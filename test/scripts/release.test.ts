import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { identify, isolatedGitEnv, runGit, type GitEnv } from '../helpers/git'
import { tmpDir } from '../helpers/tmp'

const SCRIPTS = resolve(__dirname, '../../scripts')
const supported = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v bash && command -v git'], { stdio: 'ignore' }).status === 0

const PACKAGE = `{
  "name": "research",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dist": "electron-builder"
  }
}
`

/** A repository on master with package.json and the release scripts, like the real one. */
async function repo(): Promise<{ dir: string; env: GitEnv; git: (...args: string[]) => string }> {
  const env = await isolatedGitEnv()
  const dir = await tmpDir()
  const git = (...args: string[]): string => runGit(env, dir, ...args)
  git('init', '--quiet', '--initial-branch=master')
  identify(env, dir, 'Tester')
  await mkdir(join(dir, 'scripts'))
  for (const script of ['release.sh', 'release-notes.sh']) await copyFile(join(SCRIPTS, script), join(dir, 'scripts', script))
  await writeFile(join(dir, 'package.json'), PACKAGE)
  git('add', '.')
  git('commit', '--quiet', '-m', 'Initial commit')
  return { dir, env, git }
}

function run(dir: string, env: GitEnv, script: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [join(dir, 'scripts', script), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8', ...env },
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe.skipIf(!supported)('scripts/release.sh', () => {
  it('bumps only the version line, commits and tags, without pushing', async () => {
    const { dir, env, git } = await repo()
    const result = run(dir, env, 'release.sh', '0.2.0')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(PACKAGE.replace('"0.1.0"', '"0.2.0"'))
    expect(git('log', '-1', '--format=%s')).toBe('Release v0.2.0')
    expect(git('describe', '--tags', '--exact-match', 'HEAD')).toBe('v0.2.0')
    expect(git('cat-file', '-t', 'v0.2.0')).toBe('tag')
    expect(git('status', '--porcelain')).toBe('')
    expect(result.stdout).toContain('git push origin v0.2.0')
  })

  it('accepts a leading v and a pre-release', async () => {
    const { dir, env, git } = await repo()
    expect(run(dir, env, 'release.sh', 'v0.2.0-rc.1').status).toBe(0)
    expect(git('tag', '--list')).toBe('v0.2.0-rc.1')
  })

  it('refuses a bad version, an older or equal one, a dirty tree, another branch and an existing tag', async () => {
    const { dir, env, git } = await repo()
    expect(run(dir, env, 'release.sh', 'next').stderr).toContain('Usage')
    expect(run(dir, env, 'release.sh', '0.1.0').stderr).toContain('already at 0.1.0')
    expect(run(dir, env, 'release.sh', '0.0.9').stderr).toContain('not newer')
    // A changed tracked file blocks; an untracked one (local notes, specs, plans) does not.
    await writeFile(join(dir, 'notes.txt'), 'x')
    git('add', 'notes.txt')
    git('commit', '--quiet', '-m', 'Notes')
    await writeFile(join(dir, 'notes.txt'), 'changed')
    expect(run(dir, env, 'release.sh', '0.2.0').stderr).toContain('has changes')
    git('checkout', '--quiet', '--', 'notes.txt')
    await writeFile(join(dir, 'untracked.md'), 'x')
    expect(run(dir, env, 'release.sh', '0.2.0').stderr).not.toContain('has changes')
    expect(git('tag', '--list')).toBe('v0.2.0')
    expect(run(dir, env, 'release.sh', '0.2.0').stderr).toContain('already exists')
    git('checkout', '--quiet', '-b', 'feature')
    expect(run(dir, env, 'release.sh', '0.3.0').stderr).toContain('Release from master')
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0')
  })
})

describe.skipIf(!supported)('scripts/release-notes.sh', () => {
  it('lists the commits since the previous tag, then how to install', async () => {
    const { dir, env, git } = await repo()
    git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
    git('commit', '--quiet', '--allow-empty', '-m', 'Add the tray')
    git('commit', '--quiet', '--allow-empty', '-m', 'Fix the menu')
    git('tag', '-a', 'v0.2.0', '-m', 'v0.2.0')
    git('commit', '--quiet', '--allow-empty', '-m', 'Not released yet')
    const result = run(dir, env, 'release-notes.sh', 'v0.2.0')
    expect(result.status).toBe(0)
    const notes = result.stdout
    expect(notes).toContain('## Changes since v0.1.0')
    expect(notes.indexOf('- Add the tray (')).toBeGreaterThan(0)
    expect(notes.indexOf('- Add the tray (')).toBeLessThan(notes.indexOf('- Fix the menu ('))
    expect(notes).not.toContain('Initial commit')
    expect(notes).not.toContain('Not released yet')
    expect(notes).toContain('install-appimage.sh | bash -s -- --release v0.2.0')
    expect(notes).toContain('raw.githubusercontent.com/LaloHao/research/v0.2.0/')
    expect(notes).toContain('sha256sum -c research-0.2.0-x86_64.AppImage.sha256')
  })

  it('says first release when there is no earlier tag, and fails on an unknown tag', async () => {
    const { dir, env, git } = await repo()
    git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
    expect(run(dir, env, 'release-notes.sh', 'v0.1.0').stdout).toContain('## First release')
    const missing = run(dir, env, 'release-notes.sh', 'v9.0.0')
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('No tag v9.0.0')
  })
})
