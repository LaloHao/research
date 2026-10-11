import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { toYaml } from '../../../src/main/project/yamlFile'
import { SyncService, type SyncServiceDeps } from '../../../src/main/sync/SyncService'
import type { TypedRelation } from '../../../src/shared/typedRelations'
import { applyFiles, commitAll, identify, pathWithOnlyGit, trashOnDisk, twoMachines, type Machines } from '../../helpers/git'
import { typedRelation } from '../../helpers/relations'
import { tmpDir } from '../../helpers/tmp'

const service = (m: Machines, root: string, over: Partial<SyncServiceDeps> = {}): SyncService =>
  new SyncService({ root, exclusive: (fn) => fn(), pdfPolicy: () => 'track', machineName: 'laptop', gitEnv: m.env, ...over })

/** Files under `dir` (outside .git) with git conflict markers: there must never be any. */
function filesWithMarkers(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (path.includes(`${join(dir, '.git')}`)) continue
    if (/^<{7} /m.test(readFileSync(path, 'utf8'))) out.push(path)
  }
  return out
}

const PAPER = 'schema_version: 1\nid: k\ntitle: Kernel paper\n'
const relationsText = (relations: TypedRelation[]): string => toYaml({ schema_version: 1, relations, analyzed: {} })

/** A pre-push hook on machine A that makes machine B push first: once, or on every push of A. */
async function raceFromB(m: Machines, mode: 'once' | 'always'): Promise<void> {
  const marker = join(m.a, '..', 'raced')
  const script = [
    '#!/bin/sh',
    'unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX',
    mode === 'once' ? `[ -f "${marker}" ] && exit 0` : ':',
    `touch "${marker}"`,
    `cd "${m.b}" || exit 0`,
    'echo push >> race.txt',
    'git add race.txt && git commit -q -m race && git push -q origin main',
    'exit 0'
  ].join('\n')
  await mkdir(join(m.a, '.git', 'hooks'), { recursive: true })
  await writeFile(join(m.a, '.git', 'hooks', 'pre-push'), `${script}\n`, { mode: 0o755 })
}

describe('SyncService', () => {
  it('commits the project and pushes it; the other machine pulls it; nothing to do makes no commit', async () => {
    const m = await twoMachines()
    const a = service(m, m.projectA)
    const b = service(m, m.projectB, { machineName: 'desktop' })
    await applyFiles(m.projectA, { 'papers/he2017drain/notes.md': 'from A\n' })
    expect(await a.status()).toMatchObject({ setup: 'ready', phase: 'idle', dirty: true, ahead: 0, branch: 'main', upstream: 'origin/main', lastSyncAt: null })
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'log', '-1', '--format=%B', 'main')).toBe('research: sync from laptop\n\nPapers: he2017drain')
    const after = await a.status()
    expect(after).toMatchObject({ dirty: false, ahead: 0, phase: 'idle', error: null, conflicts: 0 })
    expect(after.lastSyncAt).not.toBeNull()
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(await readFile(join(m.projectB, 'papers/he2017drain/notes.md'), 'utf8')).toBe('from A\n')
    const head = m.git(m.b, 'rev-parse', 'HEAD')
    expect(await b.run({ auto: true })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.b, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('merges on its own what the app knows how to merge, leaving no conflict markers anywhere', async () => {
    const EXTENDS = typedRelation()
    const m = await twoMachines({ 'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1'] } }), 'relations.yaml': relationsText([EXTENDS]) })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, {
      'relations.yaml': relationsText([EXTENDS, typedRelation({ type: 'same_problem' })]),
      'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1', 'W2'] } })
    })
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    await applyFiles(m.projectB, {
      'relations.yaml': relationsText([EXTENDS, typedRelation({ type: 'uses_method_of' })]),
      'project.yaml': toYaml({ schema_version: 1, name: 'Thesis', snowball: { dismissed: ['W1', 'W3'] } })
    })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(filesWithMarkers(m.b)).toEqual([])
    expect((parse(await readFile(join(m.projectB, 'relations.yaml'), 'utf8')) as { relations: TypedRelation[] }).relations).toHaveLength(3)
    expect(parse(await readFile(join(m.projectB, 'project.yaml'), 'utf8')).snowball.dismissed).toEqual(['W1', 'W2', 'W3'])
    expect(m.git(m.b, 'log', '-1', '--format=%s')).toBe('research: merge sync from laptop')
    expect(m.git(m.b, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(await readFile(join(m.projectA, 'relations.yaml'), 'utf8')).toBe(await readFile(join(m.projectB, 'relations.yaml'), 'utf8'))
  })

  it('waits for a decision on a file edited on both machines without touching the working tree, then applies it', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'from A\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'from B\n' })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await readFile(join(m.projectB, 'papers/k/summary.md'), 'utf8')).toBe('from B\n')
    expect(filesWithMarkers(m.b)).toEqual([])
    expect(await b.status()).toMatchObject({ phase: 'conflicts', conflicts: 1, ahead: 1, dirty: false })
    const [item] = await b.conflicts()
    expect(item).toEqual({ id: 'file:papers/k/summary.md', kind: 'file', path: 'papers/k/summary.md', paperId: 'k', paperTitle: 'Kernel paper', ours: 'modified', theirs: 'modified' })
    expect(await b.diff(item.id)).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'from B\n', theirs: 'from A\n', unavailable: null }] })
    // An automatic sync leaves a pending decision alone.
    expect(await b.run({ auto: true })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await b.resolve({ [item.id]: 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
    expect(await readFile(join(m.projectB, 'papers/k/summary.md'), 'utf8')).toBe('from A\n')
    expect(await b.status()).toMatchObject({ phase: 'idle', conflicts: 0, ahead: 0 })
    // The version left out is still in the history, as the merge's first parent.
    expect(m.git(m.b, 'show', 'HEAD^1:papers/k/summary.md')).toBe('from B')
  })

  it('cancels a pending decision leaving the local commit unpushed, and keeps mine when chosen', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'from A\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'from B\n' })
    await b.run({ auto: false })
    b.abort()
    expect(await b.status()).toMatchObject({ phase: 'idle', conflicts: 0, ahead: 1 })
    expect(await b.conflicts()).toEqual([])
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await b.resolve({ 'file:papers/k/summary.md': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('from B')
  })

  it('asks whether to keep a paper trashed on one machine and edited on the other', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await trashOnDisk(m.projectA, 'k')
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/notes.md': 'my notes\nedited on B\n' })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await b.conflicts()).toEqual([
      { id: 'paper:k', kind: 'paper', path: 'papers/k/', paperId: 'k', paperTitle: 'Kernel paper', ours: 'edited', theirs: 'trashed' }
    ])
    expect(await b.diff('paper:k')).toEqual({ files: [{ path: 'papers/k/notes.md', ours: 'my notes\nedited on B\n', theirs: 'my notes\n', unavailable: null }] })
    expect(await b.resolve({ 'paper:k': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
    expect(await readFile(join(m.projectB, 'papers/k/notes.md'), 'utf8')).toBe('my notes\nedited on B\n')
    expect(existsSync(join(m.projectB, '.trash/k'))).toBe(false)
    await a.run({ auto: false })
    expect(await readFile(join(m.projectA, 'papers/k/notes.md'), 'utf8')).toBe('my notes\nedited on B\n')
    expect(existsSync(join(m.projectA, '.trash/k'))).toBe(false)
  })

  it('accepts that the paper was removed, keeping in the trash the edit git could carry', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await trashOnDisk(m.projectA, 'k')
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/notes.md': 'my notes\nedited on B\n' })
    await b.run({ auto: false })
    expect(await b.resolve({ 'paper:k': 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
    expect(existsSync(join(m.projectB, 'papers/k'))).toBe(false)
    expect(await readFile(join(m.projectB, '.trash/k/notes.md'), 'utf8')).toBe('my notes\nedited on B\n')
  })

  it('stops without touching anything on a conflict outside the project folder', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: 'research', outside: { 'thesis.tex': 'base\n' } })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.a, { 'thesis.tex': 'from A\n' })
    commitAll(m, m.a, 'thesis on A')
    await a.run({ auto: false })
    await applyFiles(m.b, { 'thesis.tex': 'from B\n' })
    commitAll(m, m.b, 'thesis on B')
    await applyFiles(m.projectB, { 'notes.md': 'B\n' })
    expect(await b.run({ auto: false })).toEqual({ ok: false, error: { code: 'conflict_outside', paths: ['thesis.tex'] } })
    expect(await readFile(join(m.b, 'thesis.tex'), 'utf8')).toBe('from B\n')
    expect(filesWithMarkers(m.b)).toEqual([])
    expect(await b.status()).toMatchObject({ phase: 'error', errorAuto: false, error: { code: 'conflict_outside', paths: ['thesis.tex'] }, dirty: false })
    // The project's change is safe in a local commit.
    expect(m.git(m.b, 'log', '-1', '--format=%s')).toBe('research: sync from laptop')
  })

  it('syncs a project in a subfolder while the user has uncommitted work outside it, and stops if the sync would overwrite it', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: 'research', outside: { 'thesis.tex': 'base\n', 'other.tex': 'base\n' } })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.b, { 'thesis.tex': 'B, not committed\n', 'other.tex': 'B, staged\n' })
    m.git(m.b, 'add', 'other.tex')
    await applyFiles(m.projectA, { 'papers/k/notes.md': 'from A\n' })
    await a.run({ auto: false })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(await readFile(join(m.projectB, 'papers/k/notes.md'), 'utf8')).toBe('from A\n')
    expect(await readFile(join(m.b, 'thesis.tex'), 'utf8')).toBe('B, not committed\n')
    expect(m.git(m.b, 'diff', '--cached', '--name-only')).toBe('other.tex')
    expect(m.git(m.b, 'log', '--format=%s', '-1', '--', 'thesis.tex', 'other.tex')).toBe('init')

    await applyFiles(m.a, { 'thesis.tex': 'A, committed by hand\n' })
    commitAll(m, m.a, 'thesis on A')
    await a.run({ auto: false })
    expect(await b.run({ auto: false })).toEqual({ ok: false, error: { code: 'local_changes_block', paths: ['thesis.tex'] } })
    expect(await readFile(join(m.b, 'thesis.tex'), 'utf8')).toBe('B, not committed\n')
  })

  it.skipIf(process.platform === 'win32')('pushes again once when the remote moved between the fetch and the push', async () => {
    const m = await twoMachines()
    const a = service(m, m.projectA)
    await raceFromB(m, 'once')
    await applyFiles(m.projectA, { 'notes.md': 'from A\n' })
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    // Commits made within the same second may list in any order.
    expect(m.git(m.remote, 'log', '--format=%s', 'main').split('\n').sort()).toEqual(['init', 'race', 'research: merge sync from laptop', 'research: sync from laptop'])
  })

  it.skipIf(process.platform === 'win32')('gives up when the remote moves again on the second push', async () => {
    const m = await twoMachines()
    const a = service(m, m.projectA)
    await raceFromB(m, 'always')
    await applyFiles(m.projectA, { 'notes.md': 'from A\n' })
    expect(await a.run({ auto: false })).toEqual({ ok: false, error: { code: 'push_rejected', paths: [] } })
    expect(await a.status()).toMatchObject({ phase: 'error', ahead: 2 })
  })

  it('explains a missing upstream, a missing remote and a missing repository, and sets each of them up', async () => {
    const m = await twoMachines()
    m.git(m.a, 'branch', '--unset-upstream')
    const a = service(m, m.projectA)
    expect((await a.status()).setup).toBe('no_upstream')
    expect(await a.run({ auto: false })).toEqual({ ok: false, error: { code: 'no_upstream', paths: [] } })
    // An automatic sync stops quietly on what is not set up.
    const quiet = service(m, m.projectA)
    expect(await quiet.run({ auto: true })).toEqual({ ok: false, error: { code: 'no_upstream', paths: [] } })
    expect(await quiet.status()).toMatchObject({ phase: 'idle', error: null })
    expect(await a.setup(null)).toEqual({ ok: true, outcome: 'synced' })
    expect(await a.status()).toMatchObject({ setup: 'ready', upstream: 'origin/main', phase: 'idle', error: null })

    const root = await tmpDir()
    await applyFiles(root, { 'project.yaml': 'name: New\n' })
    const fresh = service(m, root)
    expect((await fresh.status()).setup).toBe('no_repo')
    // «Inicializar repositorio» without a URL: a repository, still without a remote.
    expect(await fresh.setup(null)).toEqual({ ok: false, error: { code: 'no_remote', paths: [] } })
    expect((await fresh.status()).setup).toBe('no_remote')
    // Never guess an identity from the host name: the commit must fail until the user sets one.
    m.git(root, 'config', 'user.useConfigOnly', 'true')
    const empty = join(await tmpDir(), 'empty.git')
    m.git(root, 'init', '--quiet', '--bare', '--initial-branch=main', empty)
    // git does not know who commits yet.
    expect(await fresh.setup(empty)).toEqual({ ok: false, error: { code: 'identity_missing', paths: [] } })
    expect((await fresh.status()).setup).toBe('no_upstream')
    identify(m.env, root, 'New Machine')
    expect(await fresh.setup(null)).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(empty, 'log', '--format=%s', 'main')).toBe('research: sync from laptop')
    expect(await fresh.setup(empty)).toEqual({ ok: false, error: { code: 'remote_exists', paths: [] } })
  })

  it('follows the remote branch when it already exists', async () => {
    const m = await twoMachines({ 'project.yaml': 'name: Thesis\n' })
    const root = await tmpDir()
    m.git(root, 'clone', '--quiet', m.remote, 'copy')
    const copy = join(root, 'copy')
    identify(m.env, copy, 'Copy')
    m.git(copy, 'branch', '--unset-upstream')
    await applyFiles(copy, { 'notes.md': 'copy\n' })
    expect(await service(m, copy).setup(null)).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:notes.md')).toBe('copy')
  })

  it('reports an unreachable remote as offline after committing locally, and a missing git', async () => {
    const m = await twoMachines()
    m.git(m.a, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/thesis.git')
    const a = service(m, m.projectA)
    await applyFiles(m.projectA, { 'notes.md': 'offline work\n' })
    expect(await a.run({ auto: true })).toEqual({ ok: false, error: { code: 'offline', paths: [] } })
    expect(await a.status()).toMatchObject({ phase: 'error', errorAuto: true, dirty: false, ahead: 1 })
    expect(await a.hasUnsynced()).toBe(true)

    const missing = service(m, m.projectA, { gitBin: '/nonexistent/git' })
    expect((await missing.status()).setup).toBe('no_git')
    expect(await missing.run({ auto: false })).toEqual({ ok: false, error: { code: 'git_missing', paths: [] } })
    expect(await missing.hasUnsynced()).toBe(false)
  })

  it('refuses to sync during a merge left half-done by hand', async () => {
    const m = await twoMachines()
    await writeFile(join(m.a, '.git', 'MERGE_HEAD'), `${m.git(m.a, 'rev-parse', 'HEAD')}\n`)
    expect(await service(m, m.projectA).run({ auto: false })).toEqual({ ok: false, error: { code: 'merge_in_progress', paths: [] } })
  })

  it.skipIf(process.platform !== 'linux')('stops when the project keeps its PDFs in git LFS and git-lfs is missing', async () => {
    const m = await twoMachines()
    const a = service(m, m.projectA, { pdfPolicy: () => 'lfs', gitEnv: { ...m.env, PATH: await pathWithOnlyGit() } })
    expect(await a.run({ auto: false })).toEqual({ ok: false, error: { code: 'lfs_missing', paths: [] } })
  })

  it('does not commit while setting up a repository with a merge left half-done by hand', async () => {
    const m = await twoMachines()
    m.git(m.a, 'branch', '--unset-upstream')
    await applyFiles(m.projectA, { 'notes.md': 'not yet\n' })
    const head = m.git(m.a, 'rev-parse', 'HEAD')
    await writeFile(join(m.a, '.git', 'MERGE_HEAD'), `${head}\n`)
    expect(await service(m, m.projectA).setup(null)).toEqual({ ok: false, error: { code: 'merge_in_progress', paths: [] } })
    expect(m.git(m.a, 'rev-parse', 'HEAD')).toBe(head)
    expect(m.git(m.a, 'status', '--porcelain', '--', 'notes.md')).toBe('?? notes.md')
    expect((await service(m, m.projectA).status()).setup).toBe('no_upstream')
  })

  it('does not commit while setting up a repository with unmerged files in the index', async () => {
    const m = await twoMachines({ 'notes.md': 'base\n' })
    m.git(m.a, 'branch', '--unset-upstream')
    const head = m.git(m.a, 'rev-parse', 'HEAD')
    const blob = m.git(m.a, 'rev-parse', 'HEAD:notes.md')
    // A conflicted entry (stages 1-3) as a hand merge leaves it, without any MERGE_HEAD.
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: m.a,
      env: { ...process.env, ...m.env },
      input: `0 ${'0'.repeat(40)}\tnotes.md\n100644 ${blob} 1\tnotes.md\n100644 ${blob} 2\tnotes.md\n100644 ${blob} 3\tnotes.md\n`
    })
    expect(await service(m, m.projectA).setup(null)).toEqual({ ok: false, error: { code: 'unmerged_files', paths: [] } })
    expect(m.git(m.a, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('reports a project folder that is gone, without asking to install git', async () => {
    const m = await twoMachines()
    const gone = service(m, join(await tmpDir(), 'unplugged'))
    expect(await gone.status()).toMatchObject({ setup: 'no_repo', phase: 'error', error: { code: 'project_missing', paths: [] } })
    expect(await gone.run({ auto: true })).toEqual({ ok: false, error: { code: 'project_missing', paths: [] } })
    expect(await gone.status()).toMatchObject({ phase: 'error', errorAuto: true, error: { code: 'project_missing', paths: [] } })
    expect(await gone.hasUnsynced()).toBe(false)
    expect(await gone.setup(null)).toEqual({ ok: false, error: { code: 'project_missing', paths: [] } })
  })

  it('finds the title of a paper this machine trashed in its trashed copy, or asks the index first', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/notes.md': 'my notes\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectB, { 'papers/k/notes.md': 'my notes\nedited on B\n', 'papers/k/paper.yaml': PAPER.replace('Kernel paper', 'Renamed on B') })
    await b.run({ auto: false })
    await trashOnDisk(m.projectA, 'k')
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    // This machine only has the paper in .trash/: its own copy is read before the other machine's library.
    expect(await a.conflicts()).toEqual([
      { id: 'paper:k', kind: 'paper', path: 'papers/k/', paperId: 'k', paperTitle: 'Kernel paper', ours: 'trashed', theirs: 'edited' }
    ])
    const titled = service(m, m.projectA, { paperTitle: (key) => (key === 'k' ? 'From the index' : null) })
    expect(await titled.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect((await titled.conflicts())[0].paperTitle).toBe('From the index')
  })

  it('names the deleted side of a file deleted on one machine and edited on the other', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': null })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'from B\n' })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await b.conflicts()).toEqual([
      { id: 'file:papers/k/summary.md', kind: 'file', path: 'papers/k/summary.md', paperId: 'k', paperTitle: 'Kernel paper', ours: 'modified', theirs: 'deleted' }
    ])
    expect(await b.diff('file:papers/k/summary.md')).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'from B\n', theirs: null, unavailable: null }] })
    expect(await b.resolve({ 'file:papers/k/summary.md': 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
    expect(existsSync(join(m.projectB, 'papers/k/summary.md'))).toBe(false)
  })

  it('tells the session every time its state changes', async () => {
    const m = await twoMachines()
    let events = 0
    const a = service(m, m.projectA, { emit: () => events++ })
    await a.run({ auto: false })
    expect(events).toBeGreaterThanOrEqual(2)
  })
})
