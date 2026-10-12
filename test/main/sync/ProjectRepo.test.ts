import { describe, expect, it } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectRepo } from '../../../src/main/sync/ProjectRepo'
import { applyFiles, commitAll, identify, isolatedGitEnv, pathWithOnlyGit, processAlive, runGit, slowRemote, twoMachines } from '../../helpers/git'
import { tmpDir } from '../../helpers/tmp'

const message = (): string => 'research: sync\n'

async function open(dir: string, env: Record<string, string>): Promise<ProjectRepo> {
  const repo = await ProjectRepo.open(dir, { env })
  if (!repo) throw new Error(`no repository at ${dir}`)
  return repo
}

describe('ProjectRepo', () => {
  it('finds the repository at the project folder or above it, and none outside git', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: 'research' })
    const repo = await open(m.projectA, m.env)
    expect(repo.prefix).toBe('research/')
    expect(repo.top).toBe(realpathSync(m.a))
    expect((await open(m.a, m.env)).prefix).toBe('')
    expect(await ProjectRepo.open(await tmpDir(), { env: m.env })).toBeNull()
    // A folder that is gone (an unplugged drive) is not "outside git".
    await expect(ProjectRepo.open(join(await tmpDir(), 'gone'), { env: m.env })).rejects.toMatchObject({ kind: 'project_missing' })
    expect(await repo.info()).toEqual({ branch: 'main', upstream: { remote: 'origin', ref: 'refs/heads/main', short: 'origin/main' }, remotes: ['origin'] })
    m.git(m.a, 'branch', '--unset-upstream')
    expect((await repo.info()).upstream).toBeNull()
  })

  it('commits only the project folder, leaving what the user staged or edited outside it as it was', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: 'research', outside: { 'thesis.tex': 'v1\n', 'other.tex': 'o1\n' } })
    const repo = await open(m.projectA, m.env)
    await applyFiles(m.a, {
      'thesis.tex': 'v2, not committed\n',
      'other.tex': 'o2, staged\n',
      'research/papers/he2017drain/notes.md': 'notes\n',
      'research/.cache/index.sqlite': 'rebuildable\n',
      'research/project.yaml': null
    })
    m.git(m.a, 'add', 'other.tex')
    expect(await repo.dirtyInProject()).toBe(true)
    expect(await repo.commitProject(message)).toEqual(['research/papers/he2017drain/notes.md', 'research/project.yaml'])
    expect(m.git(m.a, 'log', '-1', '--format=%s')).toBe('research: sync')
    expect(m.git(m.a, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('research/papers/he2017drain/notes.md\nresearch/project.yaml')
    expect(m.git(m.a, 'diff', '--cached', '--name-only')).toBe('other.tex')
    expect(m.git(m.a, 'diff', '--name-only')).toBe('thesis.tex')
    expect(await repo.dirtyInProject()).toBe(false)
    expect(await repo.commitProject(message)).toBeNull()
    expect(await repo.aheadCount()).toBe(1)
  })

  it('makes the first commit of a new repository on main', async () => {
    const env = await isolatedGitEnv()
    const root = await tmpDir()
    await ProjectRepo.init(root, { env })
    identify(env, root, 'Solo')
    // The app's .gitignore already ignores .cache/: naming it must not make `git add` fail.
    await applyFiles(root, { 'project.yaml': 'x\n', '.gitignore': '.cache/\n', '.cache/index.sqlite': 'rebuildable\n' })
    const repo = await open(root, env)
    expect(await repo.revParse('HEAD')).toBeNull()
    expect(await repo.commitProject(message)).toEqual(['.gitignore', 'project.yaml'])
    expect((await repo.info()).branch).toBe('main')
    expect(runGit(env, root, 'status', '--porcelain')).toBe('')
  })

  it('merges two machines\' commits apart from the working tree, edits the result and fast-forwards to it', async () => {
    const m = await twoMachines({ 'a.md': 'a\n', 'b.md': 'b\n' })
    await applyFiles(m.a, { 'a.md': 'a from A\n' })
    commitAll(m, m.a, 'A')
    m.git(m.a, 'push', '--quiet')
    await applyFiles(m.b, { 'a.md': 'a from B\n', 'b.md': 'b from B\n' })
    commitAll(m, m.b, 'B')
    const repo = await open(m.b, m.env)
    await repo.fetch('origin')
    const ours = (await repo.revParse('HEAD'))!
    const theirs = (await repo.revParse('@{upstream}'))!
    expect(await repo.isAncestor(ours, theirs)).toBe(false)
    expect(await repo.mergeBase(ours, theirs)).toBe(m.git(m.b, 'rev-parse', 'HEAD~1'))
    const merged = await repo.mergeTree(ours, theirs)
    expect(merged.conflicts.map((c) => c.path)).toEqual(['a.md'])
    expect(await repo.readText(merged.conflicts[0].theirs!.oid)).toBe('a from A\n')
    // The conflict never reaches the working tree.
    expect(await readFile(join(m.b, 'a.md'), 'utf8')).toBe('a from B\n')
    const tree = await repo.editTree(merged.tree, [
      { path: 'a.md', mode: '100644', oid: await repo.writeBlob('a merged\n') },
      { path: 'c.md', mode: '100644', oid: await repo.writeBlob('c\n') },
      { path: 'b.md', remove: true }
    ])
    expect((await repo.lsTree(tree, ['.'])).map((e) => e.path)).toEqual(['a.md', 'c.md'])
    const commit = await repo.commitTree(tree, [ours, theirs], 'merge\n')
    expect(await repo.blockedPaths(ours, commit)).toEqual([])
    await repo.fastForward(commit)
    expect(await readFile(join(m.b, 'a.md'), 'utf8')).toBe('a merged\n')
    expect(existsSync(join(m.b, 'b.md'))).toBe(false)
    expect(m.git(m.b, 'status', '--porcelain')).toBe('')
    expect(m.git(m.b, 'log', '-1', '--format=%P')).toBe(`${ours} ${theirs}`)
    expect(await repo.readFileAt(commit, 'c.md')).toEqual(Buffer.from('c\n'))
    expect(await repo.readFileAt(commit, 'b.md')).toBeNull()
    expect(await repo.oidAt(commit, 'c.md')).toBe(await repo.writeBlob('c\n'))
    expect(await repo.nameStatus(ours, commit, ['.'])).toEqual([
      { status: 'M', path: 'a.md' },
      { status: 'D', path: 'b.md' },
      { status: 'A', path: 'c.md' }
    ])
    await repo.push('origin', 'refs/heads/main')
    expect(await repo.aheadCount()).toBe(0)
    expect(m.git(m.remote, 'rev-parse', 'main')).toBe(commit)
  })

  it('names the local files a fast-forward would overwrite, ignored ones included', async () => {
    const m = await twoMachines({ '.gitignore': '*.pdf\n*.log\n', 'a.md': 'a\n' })
    await applyFiles(m.a, { 'a.md': 'a from A\n', 'k/paper.pdf': '%PDF A', 'n.log/x': 'a dir there\n', 'd.log': 'a file there\n' })
    m.git(m.a, 'add', '--force', 'k/paper.pdf', 'n.log/x', 'd.log')
    commitAll(m, m.a, 'A')
    m.git(m.a, 'push', '--quiet')
    await applyFiles(m.b, {
      'a.md': 'a, not committed\n',
      'k/paper.pdf': '%PDF B, ignored here',
      // An ignored file where the other machine added a folder, and an ignored folder where it added a file.
      'n.log': 'ignored file\n',
      'd.log/y': 'ignored folder\n'
    })
    const repo = await open(m.b, m.env)
    await repo.fetch('origin')
    expect(await repo.blockedPaths((await repo.revParse('HEAD'))!, (await repo.revParse('@{upstream}'))!)).toEqual(['a.md', 'd.log/', 'k/paper.pdf', 'n.log'])
  })

  it('tells text from binary and too large for the diff view', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    expect(await repo.blobText(await repo.writeBlob('line\n'), 100)).toEqual({ text: 'line\n' })
    expect(await repo.blobText(await repo.writeBlob(new Uint8Array([0x25, 0x00, 0x01])), 100)).toEqual({ unavailable: 'binary' })
    expect(await repo.blobText(await repo.writeBlob('x'.repeat(101)), 100)).toEqual({ unavailable: 'too_large' })
  })

  it('notices a merge left half-done by hand', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    expect(await repo.operationInProgress()).toBe(false)
    await writeFile(join(m.a, '.git', 'MERGE_HEAD'), `${await repo.revParse('HEAD')}\n`)
    expect(await repo.operationInProgress()).toBe(true)
    expect(await repo.hasUnmerged()).toBe(false)
  })

  it('notices a rebase left half-done by hand', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    await mkdir(join(m.a, '.git', 'rebase-merge'))
    expect(await repo.operationInProgress()).toBe(true)
  })

  it('repairs the real index when a commit could not update it, and does not fail once the branch moved', async () => {
    const m = await twoMachines({ 'f.md': 'v1\n' })
    const repo = await open(m.a, m.env)
    await applyFiles(m.a, { 'f.md': 'v2\n' })
    // The user's own git holds the index while the app commits.
    const lock = join(m.a, '.git', 'index.lock')
    await writeFile(lock, '')
    expect(await repo.commitProject(message)).toEqual(['f.md'])
    await rm(lock)
    expect(m.git(m.a, 'log', '-1', '--format=%s')).toBe('research: sync')
    expect(await repo.commitProject(message)).toBeNull()
    expect(m.git(m.a, 'status', '--porcelain')).toBe('')
    expect(await repo.dirtyInProject()).toBe(false)
  })

  it('never commits with an identity git guessed instead of one the user configured', async () => {
    const env = await isolatedGitEnv()
    const root = await tmpDir()
    await ProjectRepo.init(root, { env })
    await applyFiles(root, { 'project.yaml': 'x\n' })
    // EMAIL is one of git's guesses (like user@host.domain); the test does not set user.useConfigOnly itself.
    const repo = await open(root, { ...env, EMAIL: 'guess@host.example' })
    await expect(repo.commitProject(message)).rejects.toMatchObject({ kind: 'identity_missing' })
    expect(await repo.revParse('HEAD')).toBeNull()
    // The temporary index is gone after the failure.
    expect((await readdir(repo.gitDir)).filter((name) => name.startsWith('research-'))).toEqual([])
  })

  it('runs tree edits side by side without sharing a temporary index', async () => {
    const m = await twoMachines({ 'a.md': 'a\n' })
    const repo = await open(m.a, m.env)
    const base = (await repo.revParse('HEAD'))!
    const ids = [0, 1, 2, 3, 4, 5]
    const trees = await Promise.all(ids.map(async (i) => repo.editTree(base, [{ path: `f${i}.md`, mode: '100644', oid: await repo.writeBlob(`${i}\n`) }])))
    for (const i of ids) expect((await repo.lsTree(trees[i], ['.'])).map((e) => e.path)).toEqual(['a.md', `f${i}.md`])
    expect((await readdir(repo.gitDir)).filter((name) => name.startsWith('research-'))).toEqual([])
  })

  it('treats a project folder whose name looks like pathspec magic as a plain folder', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: ':x', outside: { 'x/o': 'o1\n' } })
    const repo = await open(m.projectA, m.env)
    expect(repo.prefix).toBe(':x/')
    await applyFiles(m.a, { 'x/o': 'o2\n', ':x/notes.md': 'n\n', ':x/.cache/index.sqlite': 'rebuildable\n' })
    expect(await repo.commitProject(message)).toEqual([':x/notes.md'])
    expect(m.git(m.a, 'diff', '--name-only')).toBe('x/o')
    expect(m.git(m.a, 'diff', '--cached', '--name-only')).toBe('')
    expect(await repo.dirtyInProject()).toBe(false)
    expect((await repo.lsTree('HEAD', [':x/'])).map((e) => e.path)).toEqual([':x/notes.md', ':x/project.yaml'])
  })

  it('handles project and file names with spaces and accents', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n' }, { sub: 'mi tesis ñ' })
    const repo = await open(m.projectA, m.env)
    expect(repo.prefix).toBe('mi tesis ñ/')
    await applyFiles(m.projectA, { 'papers/zhang2019/notas ú.md': 'n\n' })
    expect(await repo.commitProject(message)).toEqual(['mi tesis ñ/papers/zhang2019/notas ú.md'])
    const head = (await repo.revParse('HEAD'))!
    expect(await repo.nameStatus('HEAD~1', head, ['mi tesis ñ/papers/'])).toEqual([{ status: 'A', path: 'mi tesis ñ/papers/zhang2019/notas ú.md' }])
    expect(await repo.readFileAt(head, 'mi tesis ñ/papers/zhang2019/notas ú.md')).toEqual(Buffer.from('n\n'))
  })

  it('fast-forwards a project in a subfolder, stopping first for a local file in the way', async () => {
    const m = await twoMachines({ 'a.md': 'a\n' }, { sub: 'research' })
    await applyFiles(m.projectA, { 'a.md': 'a from A\n', 'new.md': 'new from A\n' })
    commitAll(m, m.a, 'A')
    m.git(m.a, 'push', '--quiet')
    await applyFiles(m.projectB, { 'new.md': 'untracked on B\n' })
    const repo = await open(m.projectB, m.env)
    await repo.fetch('origin')
    const head = (await repo.revParse('HEAD'))!
    const theirs = (await repo.revParse('@{upstream}'))!
    expect(await repo.blockedPaths(head, theirs)).toEqual(['research/new.md'])
    await rm(join(m.projectB, 'new.md'))
    expect(await repo.blockedPaths(head, theirs)).toEqual([])
    await repo.fastForward(theirs)
    expect(await readFile(join(m.projectB, 'a.md'), 'utf8')).toBe('a from A\n')
    expect(await readFile(join(m.projectB, 'new.md'), 'utf8')).toBe('new from A\n')
  })

  it('reads the branch even when a tag has the same name', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    m.git(m.a, 'tag', 'main')
    expect(await repo.info()).toEqual({ branch: 'main', upstream: { remote: 'origin', ref: 'refs/heads/main', short: 'origin/main' }, remotes: ['origin'] })
  })

  it('counts a .cache/ committed by hand as a change, since the next sync commit takes it out', async () => {
    const m = await twoMachines({ 'project.yaml': 'x\n', '.cache/index.sqlite': 'committed by hand\n' })
    const repo = await open(m.a, m.env)
    expect(await repo.dirtyInProject()).toBe(true)
    expect(await repo.commitProject(message)).toEqual(['.cache/index.sqlite'])
    expect(await repo.dirtyInProject()).toBe(false)
    expect(existsSync(join(m.a, '.cache', 'index.sqlite'))).toBe(true)
  })

  it('tells a missing file from a commit that is not there', async () => {
    const m = await twoMachines({ 'a.md': 'a\n', 'd/b.md': 'b\n' })
    const repo = await open(m.a, m.env)
    expect(await repo.readFileAt('HEAD', 'nope.md')).toBeNull()
    expect(await repo.oidAt('HEAD', 'nope.md')).toBeNull()
    expect(await repo.readFileAt('HEAD', 'd')).toBeNull()
    await expect(repo.readFileAt('0'.repeat(40), 'a.md')).rejects.toThrow()
    await expect(repo.oidAt('0'.repeat(40), 'a.md')).rejects.toThrow()
  })

  it('adds a remote and points the branch at it', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    m.git(m.a, 'branch', '--unset-upstream')
    await repo.addRemote('backup', m.remote)
    await repo.setUpstream('main', 'backup')
    expect((await repo.info()).upstream).toEqual({ remote: 'backup', ref: 'refs/heads/main', short: 'backup/main' })
    expect((await repo.info()).remotes).toEqual(['backup', 'origin'])
  })

  // Final review, I1: a big fetch or push is stopped only when it goes quiet, never for taking long while it reports.
  it.skipIf(process.platform !== 'linux')(
    'fetches and pushes through a remote that takes longer than the idle limit while it keeps reporting',
    async () => {
      const m = await twoMachines()
      await applyFiles(m.b, { 'from-b.md': 'b\n' })
      commitAll(m, m.b, 'from b')
      m.git(m.b, 'push', '--quiet', 'origin', 'main')
      const slow = await slowRemote(m, 'chatty', 1_200)
      const repo = (await ProjectRepo.open(m.a, { env: slow.env, limits: { idleMs: 500, longMs: 20_000 } }))!
      await repo.fetch('origin')
      expect(m.git(m.a, 'rev-parse', 'origin/main')).toBe(m.git(m.b, 'rev-parse', 'HEAD'))
      await repo.fastForward('origin/main')
      await applyFiles(m.a, { 'from-a.md': 'a\n' })
      commitAll(m, m.a, 'from a')
      await repo.push('origin', 'refs/heads/main')
      expect(m.git(m.remote, 'rev-parse', 'main')).toBe(m.git(m.a, 'rev-parse', 'HEAD'))
    },
    20_000
  )

  it.skipIf(process.platform !== 'linux')(
    'gives up on a remote that goes silent for the idle limit, leaving no process behind',
    async () => {
      const m = await twoMachines()
      const slow = await slowRemote(m, 'silent', 30_000)
      const repo = (await ProjectRepo.open(m.a, { env: slow.env, limits: { idleMs: 500, longMs: 20_000 } }))!
      const started = Date.now()
      await expect(repo.fetch('origin')).rejects.toMatchObject({ kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(10_000)
      const pids = await slow.pids()
      expect(pids).toHaveLength(1)
      const deadline = Date.now() + 5_000
      while (processAlive(pids[0]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(processAlive(pids[0])).toBe(false)
    },
    20_000
  )

  it.skipIf(process.platform !== 'linux')('reports git-lfs as missing when git cannot find it', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, { ...m.env, PATH: await pathWithOnlyGit() })
    expect(await repo.lfsAvailable()).toBe(false)
  })
})
