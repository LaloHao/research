import { describe, expect, it } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectRepo } from '../../../src/main/sync/ProjectRepo'
import { applyFiles, commitAll, identify, isolatedGitEnv, pathWithOnlyGit, runGit, twoMachines } from '../../helpers/git'
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
    const m = await twoMachines({ '.gitignore': '*.pdf\n', 'a.md': 'a\n' })
    await applyFiles(m.a, { 'a.md': 'a from A\n', 'k/paper.pdf': '%PDF A' })
    m.git(m.a, 'add', '--force', 'k/paper.pdf')
    commitAll(m, m.a, 'A')
    m.git(m.a, 'push', '--quiet')
    await applyFiles(m.b, { 'a.md': 'a, not committed\n', 'k/paper.pdf': '%PDF B, ignored here' })
    const repo = await open(m.b, m.env)
    await repo.fetch('origin')
    expect(await repo.blockedPaths((await repo.revParse('HEAD'))!, (await repo.revParse('@{upstream}'))!)).toEqual(['a.md', 'k/paper.pdf'])
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

  it('adds a remote and points the branch at it', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, m.env)
    m.git(m.a, 'branch', '--unset-upstream')
    await repo.addRemote('backup', m.remote)
    await repo.setUpstream('main', 'backup')
    expect((await repo.info()).upstream).toEqual({ remote: 'backup', ref: 'refs/heads/main', short: 'backup/main' })
    expect((await repo.info()).remotes).toEqual(['backup', 'origin'])
  })

  it.skipIf(process.platform !== 'linux')('reports git-lfs as missing when git cannot find it', async () => {
    const m = await twoMachines()
    const repo = await open(m.a, { ...m.env, PATH: await pathWithOnlyGit() })
    expect(await repo.lfsAvailable()).toBe(false)
  })
})
