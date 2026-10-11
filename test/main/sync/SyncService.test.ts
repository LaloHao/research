import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { toYaml } from '../../../src/main/project/yamlFile'
import { ProjectRepo } from '../../../src/main/sync/ProjectRepo'
import { SyncService, type SyncServiceDeps } from '../../../src/main/sync/SyncService'
import type { ConflictChoice, SyncResult } from '../../../src/shared/sync'
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

const VERSION = expect.stringMatching(/^[0-9a-f]{16}$/)
const PAPER = 'schema_version: 1\nid: k\ntitle: Kernel paper\n'
/** «Terminar sincronización» as the panel sends it: each choice with the version of its conflict listed right now. */
async function choose(svc: SyncService, picks: Record<string, ConflictChoice>): Promise<SyncResult> {
  const versions = new Map((await svc.conflicts()).map((c) => [c.id, c.version]))
  return svc.resolve(Object.fromEntries(Object.entries(picks).map(([id, choice]) => [id, { choice, version: versions.get(id) ?? 'unknown' }])))
}
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    expect(item).toEqual({
      id: 'file:papers/k/summary.md',
      kind: 'file',
      path: 'papers/k/summary.md',
      paperId: 'k',
      paperTitle: 'Kernel paper',
      ours: 'modified',
      theirs: 'modified',
      version: VERSION
    })
    expect(await b.diff(item.id)).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'from B\n', theirs: 'from A\n', unavailable: null }] })
    // An automatic sync leaves a pending decision alone.
    expect(await b.run({ auto: true })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await choose(b, { [item.id]: 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
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
    expect(await choose(b, { 'file:papers/k/summary.md': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
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
      { id: 'paper:k', kind: 'paper', path: 'papers/k/', paperId: 'k', paperTitle: 'Kernel paper', ours: 'edited', theirs: 'trashed', version: VERSION }
    ])
    expect(await b.diff('paper:k')).toEqual({ files: [{ path: 'papers/k/notes.md', ours: 'my notes\nedited on B\n', theirs: 'my notes\n', unavailable: null }] })
    expect(await choose(b, { 'paper:k': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
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
    expect(await choose(b, { 'paper:k': 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
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
    // The same URL again is a retry; another one is refused while origin exists.
    expect(await fresh.setup(empty)).toEqual({ ok: true, outcome: 'synced' })
    expect(await fresh.setup(join(root, 'elsewhere.git'))).toEqual({ ok: false, error: { code: 'remote_exists', paths: [] } })
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
      { id: 'paper:k', kind: 'paper', path: 'papers/k/', paperId: 'k', paperTitle: 'Kernel paper', ours: 'trashed', theirs: 'edited', version: VERSION }
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
      { id: 'file:papers/k/summary.md', kind: 'file', path: 'papers/k/summary.md', paperId: 'k', paperTitle: 'Kernel paper', ours: 'modified', theirs: 'deleted', version: VERSION }
    ])
    expect(await b.diff('file:papers/k/summary.md')).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'from B\n', theirs: null, unavailable: null }] })
    expect(await choose(b, { 'file:papers/k/summary.md': 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
    expect(existsSync(join(m.projectB, 'papers/k/summary.md'))).toBe(false)
  })

  it('never applies a choice to a newer local version than the one shown, and keeps the choices still valid', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n', 'papers/k/notes.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A1\n', 'papers/k/notes.md': 'A1 notes\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'B1\n', 'papers/k/notes.md': 'B1 notes\n' })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await b.diff('file:papers/k/summary.md')).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'B1\n', theirs: 'A1\n', unavailable: null }] })
    // The app saves a newer summary while the panel is open.
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'B2\n' })
    expect(await choose(b, { 'file:papers/k/summary.md': 'theirs', 'file:papers/k/notes.md': 'theirs' })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(await readFile(join(m.projectB, 'papers/k/summary.md'), 'utf8')).toBe('B2\n')
    expect((await b.conflicts()).map((c) => c.id)).toEqual(['file:papers/k/summary.md'])
    expect(await b.diff('file:papers/k/summary.md')).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'B2\n', theirs: 'A1\n', unavailable: null }] })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('A1')
    // The unchanged notes decision is kept: only the new one is needed.
    expect(await choose(b, { 'file:papers/k/summary.md': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('B2')
    expect(m.git(m.remote, 'show', 'main:papers/k/notes.md')).toBe('A1 notes')
  })

  it('keeps a decision when the app only wrote other files while the panel was open', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A1\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'B1\n' })
    await b.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/notes.md': 'unrelated\n' })
    expect(await choose(b, { 'file:papers/k/summary.md': 'theirs' })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('A1')
    expect(m.git(m.remote, 'show', 'main:papers/k/notes.md')).toBe('unrelated')
  })

  it('asks again instead of reusing a choice when the remote moved before the push', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A1\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'B1\n' })
    await b.run({ auto: false })
    // Machine A pushes a newer version after B was shown A1.
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A2\n' })
    await a.run({ auto: false })
    expect(await choose(b, { 'file:papers/k/summary.md': 'ours' })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('A2')
    expect(await b.diff('file:papers/k/summary.md')).toEqual({ files: [{ path: 'papers/k/summary.md', ours: 'B1\n', theirs: 'A2\n', unavailable: null }] })
    expect(await choose(b, { 'file:papers/k/summary.md': 'ours' })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('B1')
  })

  it('never applies a choice made for versions that a later sync replaced under the same id', async () => {
    const m = await twoMachines({ 'papers/k/paper.yaml': PAPER, 'papers/k/summary.md': 'base\n' })
    const a = service(m, m.projectA)
    const b = service(m, m.projectB)
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A1\n' })
    await a.run({ auto: false })
    await applyFiles(m.projectB, { 'papers/k/summary.md': 'B1\n' })
    await b.run({ auto: false })
    const [seen] = await b.conflicts()
    // Machine A pushes a newer version, and another «Sincronizar» (e.g. before closing) lists the conflict again.
    await applyFiles(m.projectA, { 'papers/k/summary.md': 'A2\n' })
    await a.run({ auto: false })
    expect(await b.run({ auto: false })).toEqual({ ok: true, outcome: 'conflicts' })
    const [now] = await b.conflicts()
    expect(now.id).toBe(seen.id)
    expect(now.version).not.toBe(seen.version)
    // The choice made for A1 is not applied to A2.
    expect(await b.resolve({ [seen.id]: { choice: 'ours', version: seen.version } })).toEqual({ ok: true, outcome: 'conflicts' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('A2')
    expect(await readFile(join(m.projectB, 'papers/k/summary.md'), 'utf8')).toBe('B1\n')
    expect((await b.conflicts()).map((c) => c.version)).toEqual([now.version])
    expect(await b.resolve({ [now.id]: { choice: 'ours', version: now.version } })).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.remote, 'show', 'main:papers/k/summary.md')).toBe('B1')
  })

  it('lets a mistyped remote URL be corrected while the branch has no upstream yet', async () => {
    const m = await twoMachines()
    const root = await tmpDir()
    await applyFiles(root, { 'project.yaml': 'name: New\n' })
    const fresh = service(m, root)
    expect(await fresh.setup(null)).toEqual({ ok: false, error: { code: 'no_remote', paths: [] } })
    identify(m.env, root, 'New Machine')
    const typo = join(await tmpDir(), 'typo.git')
    expect(await fresh.setup(typo)).toMatchObject({ ok: false, error: { code: 'remote_not_found' } })
    expect((await fresh.status()).setup).toBe('no_upstream')
    const empty = join(await tmpDir(), 'empty.git')
    m.git(root, 'init', '--quiet', '--bare', '--initial-branch=main', empty)
    expect(await fresh.setup(empty)).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(root, 'remote', 'get-url', 'origin')).toBe(empty)
    // Once the branch follows the remote, another URL is refused.
    expect(await fresh.setup(typo)).toEqual({ ok: false, error: { code: 'remote_exists', paths: [] } })
  })

  it('never re-points an origin that was fetched or that another branch follows', async () => {
    const m = await twoMachines()
    // A new local branch follows nothing, while main still tracks the fetched origin.
    m.git(m.a, 'switch', '--quiet', '-c', 'research')
    const a = service(m, m.projectA)
    expect((await a.status()).setup).toBe('no_upstream')
    const other = join(await tmpDir(), 'other.git')
    m.git(m.a, 'init', '--quiet', '--bare', '--initial-branch=main', other)
    expect(await a.setup(other)).toEqual({ ok: false, error: { code: 'remote_exists', paths: [] } })
    expect(m.git(m.a, 'remote', 'get-url', 'origin')).toBe(m.remote)
    // Fetched once, even with no branch following it, origin is not a typo either.
    m.git(m.a, 'config', '--unset', 'branch.main.remote')
    expect(await a.setup(other)).toEqual({ ok: false, error: { code: 'remote_exists', paths: [] } })
    expect(m.git(m.a, 'remote', 'get-url', 'origin')).toBe(m.remote)
  })

  it('refuses a remote with an unrelated history before following it', async () => {
    const m = await twoMachines()
    const root = await tmpDir()
    m.git(root, 'init', '--quiet', '--initial-branch=main')
    identify(m.env, root, 'Other')
    await applyFiles(root, { 'project.yaml': 'name: Other\n' })
    const other = service(m, root)
    expect(await other.setup(m.remote)).toEqual({ ok: false, error: { code: 'unrelated_histories', paths: [] } })
    expect(await other.status()).toMatchObject({ setup: 'no_upstream', upstream: null })
    expect(await other.hasUnsynced()).toBe(false)
    expect(m.git(m.remote, 'log', '--format=%s', 'main')).toBe('init')
  })

  it('refuses a remote URL with a password or that reads as an option, and retries the same origin', async () => {
    const m = await twoMachines()
    m.git(m.a, 'remote', 'remove', 'origin')
    const a = service(m, m.projectA)
    for (const url of ['https://me:secret@example.test/x.git', '-uhack', 'a b']) {
      expect(await a.setup(url)).toEqual({ ok: false, error: { code: 'invalid_remote_url', paths: [] } })
    }
    expect(m.git(m.a, 'remote')).toBe('')
    const offline = 'https://127.0.0.1:9/thesis.git'
    expect(await a.setup(offline)).toEqual({ ok: false, error: { code: 'offline', paths: [] } })
    // A retry after going offline is not «that remote already exists», and another URL corrects origin while the
    // branch follows nothing yet.
    expect(await a.setup(offline)).toEqual({ ok: false, error: { code: 'offline', paths: [] } })
    expect(await a.setup(m.remote)).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.a, 'remote', 'get-url', 'origin')).toBe(m.remote)
  })

  it('never holds the write gate while online, and pushes what the app wrote during the fetch', async () => {
    const m = await twoMachines()
    let held = false
    const online: boolean[] = []
    const a = service(m, m.projectA, {
      exclusive: async (fn) => {
        held = true
        try {
          return await fn()
        } finally {
          held = false
        }
      }
    })
    const fetch = ProjectRepo.prototype.fetch
    vi.spyOn(ProjectRepo.prototype, 'fetch').mockImplementation(async function (this: ProjectRepo, ...args) {
      online.push(held)
      await fetch.apply(this, args)
      await applyFiles(m.projectA, { 'during.md': 'written while fetching\n' })
    })
    const push = ProjectRepo.prototype.push
    vi.spyOn(ProjectRepo.prototype, 'push').mockImplementation(async function (this: ProjectRepo, ...args) {
      online.push(held)
      await push.apply(this, args)
    })
    await applyFiles(m.projectA, { 'notes.md': 'from A\n' })
    expect(await a.run({ auto: false })).toEqual({ ok: true, outcome: 'synced' })
    expect(online).toEqual([false, false])
    expect(m.git(m.remote, 'show', 'main:during.md')).toBe('written while fetching')
  })

  it('joins a sync already running, and stops for good once closed', async () => {
    const m = await twoMachines()
    const a = service(m, m.projectA)
    const first = a.run({ auto: false })
    expect(a.run({ auto: true })).toBe(first)
    // While a sync runs, choices and a URL are not taken: the caller gets that sync's result.
    expect(a.resolve({ 'file:x': { choice: 'ours', version: '0123456789abcdef' } })).toBe(first)
    expect(a.setup('https://example.test/x.git')).toBe(first)
    expect(await first).toEqual({ ok: true, outcome: 'synced' })
    expect(m.git(m.a, 'remote')).toBe('origin')

    const fetch = ProjectRepo.prototype.fetch
    vi.spyOn(ProjectRepo.prototype, 'fetch').mockImplementation(async function (this: ProjectRepo, ...args) {
      void a.close()
      await fetch.apply(this, args)
    })
    await applyFiles(m.projectA, { 'notes.md': 'from A\n' })
    expect(await a.run({ auto: false })).toEqual({ ok: false, error: { code: 'cancelled', paths: [] } })
    vi.restoreAllMocks()
    const head = m.git(m.a, 'rev-parse', 'HEAD')
    await applyFiles(m.projectA, { 'more.md': 'after close\n' })
    expect(await a.run({ auto: false })).toEqual({ ok: false, error: { code: 'cancelled', paths: [] } })
    expect(await a.setup(null)).toEqual({ ok: false, error: { code: 'cancelled', paths: [] } })
    expect(m.git(m.a, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('tells the session every time its state changes', async () => {
    const m = await twoMachines()
    let events = 0
    const a = service(m, m.projectA, { emit: () => events++ })
    await a.run({ auto: false })
    expect(events).toBeGreaterThanOrEqual(2)
  })
})
