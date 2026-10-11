import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyGitError, Git, gitEnv } from '../../../src/main/sync/Git'
import { tmpDir } from '../../helpers/tmp'

const SLEEP = ['-e', 'setTimeout(() => {}, 5000)']

describe('Git', () => {
  it('runs git without a shell, feeding its standard input', async () => {
    const git = new Git(await tmpDir())
    expect((await git.text(['hash-object', '--stdin'], { input: 'hi\n' })).trim()).toBe('45b983be36b73c0788dc9cbcb76cbb80fc7bb057')
  })

  it('accepts the exit codes a command answers with, and fails with a classified kind otherwise', async () => {
    const git = new Git(await tmpDir(), { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/nonexistent/gitconfig' } })
    expect((await git.run(['config', '--get', 'research.nothing'], { okCodes: [1] })).code).toBe(1)
    await expect(git.run(['status'])).rejects.toMatchObject({ name: 'GitError', kind: 'not_a_repo' })
  })

  it('reports a missing git, a run that took too long and a cancelled one', async () => {
    const dir = await tmpDir()
    await expect(new Git(dir, { bin: '/nonexistent/git' }).run(['--version'])).rejects.toMatchObject({ kind: 'git_missing' })
    // Any program stands in for a git that hangs.
    const slow = new Git(dir, { bin: process.execPath })
    await expect(slow.run(SLEEP, { timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' })
    const abort = new AbortController()
    const run = slow.run(SLEEP, { signal: abort.signal })
    abort.abort()
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' })
  })

  // Fix round 1, I1: a missing or unmounted project folder is not "git not installed".
  it('tells a missing project folder apart from a missing git binary', async () => {
    await expect(new Git('/nonexistent/project-dir').run(['status'])).rejects.toMatchObject({ kind: 'project_missing' })
  })

  // Fix round 1, I3: a timeout or cancel kills the whole process group, not just git itself.
  it.skipIf(process.platform === 'win32')('kills the whole process group on timeout, including a grandchild', async () => {
    const dir = await tmpDir()
    const pidFile = join(dir, 'grandchild.pid')
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
      'setTimeout(() => {}, 5000);'
    ].join('\n')
    const slow = new Git(dir, { bin: process.execPath })
    await expect(slow.run(['-e', script], { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' })
    await new Promise((r) => setTimeout(r, 300))
    const gcPid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(gcPid, 0)).toThrow()
  })
})

describe('classifyGitError', () => {
  it.each([
    ["fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server", 'offline'],
    ["fatal: unable to access 'https://nonexistent.invalid/x.git/': Could not resolve host: nonexistent.invalid", 'offline'],
    ['ssh: Could not resolve hostname gitlab.example: Name or service not known\nfatal: Could not read from remote repository.', 'offline'],
    ["fatal: '/nonexistent' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'remote_not_found'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ['!\tHEAD:refs/heads/main\t[rejected] (fetch first)\nerror: failed to push some refs to origin', 'push_behind'],
    ["remote: error: cannot lock ref 'refs/heads/main': is at a23 but expected 84f\n!\tHEAD:refs/heads/main\t[remote rejected] (failed to update ref)", 'push_behind'],
    ['!\tHEAD:refs/heads/main\t[remote rejected] (pre-receive hook declined)', 'push_rejected'],
    ["git: 'lfs' is not a git command. See 'git --help'.", 'lfs_missing'],
    ["This repository is configured for Git LFS but 'git-lfs' was not found on your path.", 'lfs_missing'],
    ['*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"', 'identity_missing'],
    ['fatal: refusing to merge unrelated histories', 'unrelated_histories'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\tthesis.tex', 'local_changes_block'],
    ['error: The following untracked working tree files would be overwritten by merge:\n\tnew.md', 'local_changes_block'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'not_a_repo'],
    ['fatal: something nobody expected', 'git_failed'],
    // Fix round 1, M3: the two missing local_changes_block messages.
    ['error: Your local changes to the following files would be removed by merge:\n\tthesis.tex', 'local_changes_block'],
    ['Updating the following directories would lose untracked files in them:\n\tpapers/x', 'local_changes_block']
  ])('%s', (output, kind) => {
    expect(classifyGitError(output)).toBe(kind)
  })

  // Fix round 1, M1: a local ref-lock race (no remote involved) must not look like a rejected push.
  it('does not classify a local lock race as a push failure or auth', () => {
    const kind = classifyGitError("error: cannot lock ref 'HEAD': is at a23 but expected 84f")
    expect(kind).not.toBe('push_behind')
    expect(kind).not.toBe('push_rejected')
    expect(kind).not.toBe('auth')
  })
})

describe('gitEnv', () => {
  it('never lets git prompt and makes it speak English, keeping the rest of the environment', () => {
    const env = gitEnv({ PATH: '/usr/bin', HOME: '/home/me', LC_ALL: 'es_MX.UTF-8' }, 'linux', { GIT_CONFIG_NOSYSTEM: '1' })
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/me', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C', GIT_CONFIG_NOSYSTEM: '1' })
  })

  it('adds where Homebrew installs git and git-lfs on macOS, once', () => {
    expect(gitEnv({ PATH: '/usr/bin:/bin' }, 'darwin').PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
    expect(gitEnv({ PATH: '/usr/local/bin:/usr/bin' }, 'darwin').PATH).toBe('/usr/local/bin:/usr/bin:/opt/homebrew/bin')
  })

  // Fix round 1, I2 + M7: never a credential dialog, ssh batch mode by default, no racing the user's own git for the index lock.
  it('never lets git or ssh prompt for a credential, and avoids racing the index lock', () => {
    const env = gitEnv({ PATH: '/usr/bin' }, 'linux')
    expect(env).toMatchObject({
      GIT_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_OPTIONAL_LOCKS: '0'
    })
  })

  it('leaves an already-set GIT_SSH_COMMAND or GIT_SSH alone', () => {
    expect(gitEnv({ PATH: '/usr/bin', GIT_SSH_COMMAND: 'ssh -o something' }, 'linux').GIT_SSH_COMMAND).toBe('ssh -o something')
    expect(gitEnv({ PATH: '/usr/bin', GIT_SSH: '/usr/bin/plink' }, 'linux').GIT_SSH_COMMAND).toBeUndefined()
  })

  // Fix round 1, I4: inherited repository-locating variables must not leak into git's env, but explicit overrides still win.
  it('strips inherited repository-locating variables but keeps an explicit override', () => {
    const base = {
      PATH: '/usr/bin',
      GIT_DIR: '/other/.git',
      GIT_WORK_TREE: '/other',
      GIT_INDEX_FILE: '/other/.git/index',
      GIT_OBJECT_DIRECTORY: '/other/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/other/alt',
      GIT_COMMON_DIR: '/other/.git',
      GIT_PREFIX: 'sub/',
      GIT_NAMESPACE: 'ns',
      GIT_CEILING_DIRECTORIES: '/other'
    }
    const env = gitEnv(base, 'linux')
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_PREFIX',
      'GIT_NAMESPACE',
      'GIT_CEILING_DIRECTORIES'
    ]) {
      expect(env[key]).toBeUndefined()
    }
    expect(gitEnv(base, 'linux', { GIT_INDEX_FILE: '/tmp/my.index' }).GIT_INDEX_FILE).toBe('/tmp/my.index')
  })
})
