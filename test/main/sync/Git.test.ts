import { execFile } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { classifyGitError, Git, gitEnv } from '../../../src/main/sync/Git'
import { tmpDir } from '../../helpers/tmp'

// Fix round 2, m3: only the taskkill call (Windows) goes through execFile; spawn (used for git itself) stays real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const SLEEP = ['-e', 'setTimeout(() => {}, 5000)']
const SHORT_SLEEP = ['-e', 'setTimeout(() => {}, 300)']

// Fix round 3, I6: a fixed timeoutMs races the child's own startup (spawning a grandchild, installing a
// handler) under load — the re-review reproduced this failing 3/5 runs under 48 busy loops on 24 cores. These
// poll for an explicit readiness signal instead, so the test only aborts once the child is actually ready.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function waitForNonEmptyFile(path: string, timeoutMs = 5_000): Promise<string> {
  let content = ''
  await waitFor(async () => {
    try {
      content = (await readFile(path, 'utf8')).trim()
      return content.length > 0
    } catch {
      return false
    }
  }, timeoutMs)
  return content
}

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

  // Fix round 1, I3 (made deterministic by fix round 3, I6): a timeout or cancel kills the whole process
  // group, not just git itself — including a grandchild. Cancelled through an AbortController once the
  // grandchild's pid is known, instead of racing a fixed timeoutMs against the child's own startup.
  it.skipIf(process.platform === 'win32')(
    'kills the whole process group on cancel, including a grandchild',
    async () => {
      const dir = await tmpDir()
      const pidFile = join(dir, 'grandchild.pid')
      const script = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
        'setTimeout(() => {}, 10000);'
      ].join('\n')
      const slow = new Git(dir, { bin: process.execPath })
      const controller = new AbortController()
      const run = slow.run(['-e', script], { signal: controller.signal, timeoutMs: 15_000 })
      const gcPid = Number(await waitForNonEmptyFile(pidFile))
      controller.abort()
      await expect(run).rejects.toMatchObject({ kind: 'cancelled' })
      await waitFor(() => !isAlive(gcPid))
      expect(isAlive(gcPid)).toBe(false)
    },
    20_000
  )

  // Fix round 2, m2 (made deterministic by fix round 3, I6): the scheduled SIGKILL must not be dropped just
  // because git itself already exited — a group member that ignores SIGTERM and has already closed its pipes
  // needs that SIGKILL to actually die. The ignorer writes a ready file only after its SIGTERM handler is
  // installed, and the test waits for that (not a fixed delay) before cancelling, so the handler is always in
  // place before the signal arrives, even under load.
  it(
    'keeps the scheduled SIGKILL alive after git itself has exited, for a group member that ignores SIGTERM',
    async () => {
      const dir = await tmpDir()
      const pidFile = join(dir, 'ignorer.pid')
      const readyFile = join(dir, 'ignorer.ready')
      const gcScript = join(dir, 'ignorer.js')
      await writeFile(
        gcScript,
        [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(readyFile)}, '1');`,
          'setTimeout(() => {}, 10000);'
        ].join('\n')
      )
      const mainScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const gc = spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
        'setTimeout(() => {}, 10000);'
      ].join('\n')
      const slow = new Git(dir, { bin: process.execPath })
      const controller = new AbortController()
      const run = slow.run(['-e', mainScript], { signal: controller.signal, timeoutMs: 15_000 })
      const gcPid = Number(await waitForNonEmptyFile(pidFile))
      // Wait for the ignorer's own SIGTERM handler to actually be installed before signalling the group.
      await waitForNonEmptyFile(readyFile)
      controller.abort()
      await expect(run).rejects.toMatchObject({ kind: 'cancelled' })
      // The main process dies on SIGTERM right away; the ignorer, by design, does not.
      expect(isAlive(gcPid)).toBe(true)
      // Wait for the SIGKILL scheduled after the grace period to land (poll instead of a fixed sleep).
      await waitFor(() => !isAlive(gcPid), 5_000)
      expect(isAlive(gcPid)).toBe(false)
    },
    20_000
  )

  // Fix round 2, m1: a truncated/overflowing stdout must never look like a success. Ignoring SIGTERM makes the
  // process exit 0 on its own (instead of dying from the group kill the overflow triggers), which is what the
  // review's race looks like once SIGTERM loses.
  it(
    'rejects once the output limit is exceeded, even if the process then exits 0 on its own',
    async () => {
      const dir = await tmpDir()
      const script = [
        "process.on('SIGTERM', () => {});",
        'process.stdout.write(Buffer.alloc(256 * 1024 * 1024 + 5 * 1024 * 1024, 97), () => process.exit(0));'
      ].join('\n')
      await expect(new Git(dir, { bin: process.execPath }).run(['-e', script])).rejects.toMatchObject({ kind: 'git_failed' })
    },
    10_000
  )

  // Final review, I1: a long transfer that keeps reporting progress must not be cut off by a total timeout.
  it('keeps a run alive past its idle limit while it keeps writing, and shows progress as a terminal would', async () => {
    const dir = await tmpDir()
    const script = [
      'let n = 0;',
      'const tick = setInterval(() => {',
      '  process.stderr.write(`Writing objects: ${n * 10}% (${n}/10)\\r`);',
      '  if (++n === 10) { clearInterval(tick); process.stderr.write("Writing objects: 100% (10/10), done.\\n", () => process.exit(0)); }',
      '}, 60);'
    ].join('\n')
    const out = await new Git(dir, { bin: process.execPath }).run(['-e', script], { idleMs: 250, timeoutMs: 10_000 })
    expect(out.code).toBe(0)
    expect(out.stderr).toBe('Writing objects: 100% (10/10), done.\n')
  })

  it.skipIf(process.platform === 'win32')(
    'times out a run that goes silent for its idle limit, killing its whole group',
    async () => {
      const dir = await tmpDir()
      const pidFile = join(dir, 'sleeper.pid')
      const script = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "process.stderr.write('Receiving objects: 1%\\r');",
        "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
        'setTimeout(() => {}, 10000);'
      ].join('\n')
      const started = Date.now()
      const run = new Git(dir, { bin: process.execPath }).run(['-e', script], { idleMs: 300, timeoutMs: 15_000 })
      await expect(run).rejects.toMatchObject({ kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(8_000)
      const gcPid = Number(await waitForNonEmptyFile(pidFile))
      await waitFor(() => !isAlive(gcPid))
      expect(isAlive(gcPid)).toBe(false)
    },
    20_000
  )

  it('still stops a run that keeps writing once it reaches its hard cap', async () => {
    const dir = await tmpDir()
    const script = "setInterval(() => process.stderr.write('Counting objects\\r'), 20)"
    await expect(new Git(dir, { bin: process.execPath }).run(['-e', script], { idleMs: 200, timeoutMs: 400 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it(
    'keeps only the end of a long stderr: neither a failure nor its classification depends on how much progress came first',
    async () => {
      const dir = await tmpDir()
      const progress = "const line = 'Writing objects:  50% (1/2), 1.00 MiB | 1.00 MiB/s\\r'; for (let i = 0; i < 200000; i++) process.stderr.write(line);"
      const ok = await new Git(dir, { bin: process.execPath }).run(['-e', `${progress} process.stderr.write('done\\n', () => process.exit(0))`])
      expect(ok.stderr.length).toBeLessThan(2 * 1024 * 1024)
      expect(ok.stderr.endsWith('done\n')).toBe(true)
      const failing = `${progress} process.stderr.write('\\ngit@host: Permission denied (publickey).\\nfatal: Could not read from remote repository.\\n', () => process.exit(128))`
      await expect(new Git(dir, { bin: process.execPath }).run(['-e', failing])).rejects.toMatchObject({ kind: 'auth' })
    },
    20_000
  )

  // Fix round 2, m3: on Windows, killing the process group goes through `taskkill`, which must not flash a console.
  it('passes windowsHide to the taskkill call on Windows', async () => {
    const dir = await tmpDir()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const slow = new Git(dir, { bin: process.execPath })
      // On this (non-Windows) test host `taskkill` does not exist, so it is a no-op and the process just runs
      // its course — only whether the call itself was made correctly is being checked here, not the outcome.
      await slow.run(SHORT_SLEEP, { timeoutMs: 50 }).catch(() => undefined)
      const taskkillCalls = (execFile as unknown as Mock).mock.calls.filter((call: unknown[]) => call[0] === 'taskkill')
      expect(taskkillCalls.length).toBeGreaterThan(0)
      expect(taskkillCalls[0][2]).toMatchObject({ windowsHide: true })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  // Fix round 2, m5: a run that finishes normally must remove its own abort listener, or a long-lived signal
  // shared across many runs (e.g. one shutdown signal for the whole app) would accumulate listeners forever.
  it('removes the abort listener once a run finishes, so a shared AbortSignal does not leak listeners', async () => {
    const dir = await tmpDir()
    const git = new Git(dir)
    const controller = new AbortController()
    await git.text(['hash-object', '--stdin'], { input: 'hi\n', signal: controller.signal })
    await git.text(['hash-object', '--stdin'], { input: 'bye\n', signal: controller.signal })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
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

  // Fix round 1, I2 + M7 (amended by fix round 2, I5): never a credential dialog, no racing the user's own git
  // for the index lock. No default GIT_SSH_COMMAND any more — the detached spawn plus SSH_ASKPASS_REQUIRE=never
  // already make ssh non-interactive, and a default would silently override a user's own core.sshCommand.
  it('never lets git or ssh prompt for a credential, and avoids racing the index lock', () => {
    const env = gitEnv({ PATH: '/usr/bin' }, 'linux')
    expect(env).toMatchObject({
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
      GIT_OPTIONAL_LOCKS: '0'
    })
  })

  // Final review, I1: git-lfs reports progress (which keeps an idle timeout from firing) only to a terminal unless forced.
  it('makes git-lfs report its progress without a terminal', () => {
    expect(gitEnv({ PATH: '/usr/bin' }, 'linux').GIT_LFS_FORCE_PROGRESS).toBe('1')
  })

  // Fix round 2, I5: no default GIT_SSH_COMMAND — it would override a user's core.sshCommand (port, key, jump host).
  it('leaves GIT_SSH_COMMAND unset when the base env has none, and keeps an inherited GIT_SSH_COMMAND or GIT_SSH', () => {
    expect(gitEnv({ PATH: '/usr/bin' }, 'linux').GIT_SSH_COMMAND).toBeUndefined()
    expect(gitEnv({ PATH: '/usr/bin', GIT_SSH_COMMAND: 'ssh -o something' }, 'linux').GIT_SSH_COMMAND).toBe('ssh -o something')
    const withSsh = gitEnv({ PATH: '/usr/bin', GIT_SSH: '/usr/bin/plink' }, 'linux')
    expect(withSsh.GIT_SSH_COMMAND).toBeUndefined()
    expect(withSsh.GIT_SSH).toBe('/usr/bin/plink')
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
