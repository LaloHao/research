import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SyncErrorCode } from '../../shared/sync'

export const LOCAL_TIMEOUT_MS = 60_000
export const NETWORK_TIMEOUT_MS = 180_000
const MAX_BUFFER = 256 * 1024 * 1024
// Fix round 1 (I3): grace between SIGTERM and SIGKILL when a timeout or cancel has to kill the process group.
const KILL_GRACE_MS = 2_000

/** A sync error code, or `push_behind`: the remote moved since the fetch (the sync tries once more). */
export type GitFailure = SyncErrorCode | 'push_behind'

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly output: string,
    readonly kind: GitFailure
  ) {
    super(`git ${args[0] ?? ''} failed (${kind}): ${output.trim().split('\n').slice(-3).join(' | ')}`)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  /** Extra environment (tests point GIT_CONFIG_GLOBAL at an empty file). */
  env?: Record<string, string>
  /** Another git binary (tests only). */
  bin?: string
}

export interface GitRunOptions {
  input?: string | Uint8Array
  env?: Record<string, string>
  /** Exit codes that are answers, not failures (e.g. 1 for `merge-tree` with conflicts). */
  okCodes?: number[]
  timeoutMs?: number
  signal?: AbortSignal
}

export interface GitOutput {
  code: number
  stdout: Buffer
  stderr: string
}

/** First match wins; the output is git's (LC_ALL=C) stderr plus the start of its stdout (`push --porcelain` reports there). */
const RULES: [RegExp, GitFailure][] = [
  [/'git-lfs' was not found|git-lfs: (?:command )?not found|'lfs' is not a git command/i, 'lfs_missing'],
  // Fix round 1 (M1): anchored to the remote side, so a local ref-lock race (`update-ref HEAD <new> <old>`,
  // or a concurrent fetch) does not look like a rejected push; that falls through to push_rejected or git_failed.
  [/\((?:fetch first|non-fast-forward|stale info)\)|remote: error: cannot lock ref|\[remote rejected\] \(failed to update ref\)/i, 'push_behind'],
  [/\[remote rejected\]|\[rejected\]|hook declined|protected branch/i, 'push_rejected'],
  [/terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|Access denied|returned error: 40[13]/i, 'auth'],
  [
    /Could not resolve host|Could not resolve hostname|Failed to connect|Connection refused|Connection timed out|Network is unreachable|Operation timed out|Connection reset|No route to host|Temporary failure in name resolution/i,
    'offline'
  ],
  [/does not appear to be a git repository|Repository not found|repository '.*' not found|returned error: 404/i, 'remote_not_found'],
  [/Could not read from remote repository/i, 'auth'],
  [/Please tell me who you are|empty ident name|unable to auto-detect email|no email was given/i, 'identity_missing'],
  [/refusing to merge unrelated histories/i, 'unrelated_histories'],
  // Fix round 1 (M3): also the two messages for an untracked file or directory a merge/checkout would clobber.
  [/would be (?:overwritten|removed) by (?:merge|checkout)|would lose untracked files/i, 'local_changes_block'],
  [/not a git repository/i, 'not_a_repo']
]

export function classifyGitError(output: string): GitFailure {
  return RULES.find(([pattern]) => pattern.test(output))?.[1] ?? 'git_failed'
}

// Fix round 1 (I4): git variables that locate another repository, index or object store. An app started from a
// git hook, a `git` alias, or some editor terminals can inherit these; left alone, every command (including
// `update-ref HEAD` and `commit-tree`) would act on that other repository instead of the project's.
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES'
] as const

/**
 * git never prompts and speaks English, so its errors can be classified.
 *
 * Fix round 1 (I2, M7): `GIT_TERMINAL_PROMPT=0` alone does not stop every prompt — `GIT_ASKPASS`/`SSH_ASKPASS`
 * can still open a GUI, ssh does not read `GIT_TERMINAL_PROMPT` at all, and Git Credential Manager has its own
 * interactive mode. `GIT_OPTIONAL_LOCKS=0` keeps a background `status` from racing the user's own git for the
 * index lock.
 *
 * Fix round 2 (I5): there is no default `GIT_SSH_COMMAND` any more. The caller (`Git.run`) spawns detached on
 * POSIX, which denies ssh a controlling terminal, and that together with `SSH_ASKPASS_REQUIRE=never` was
 * confirmed (against a real sshd, an encrypted key and an unknown host) to already fail closed instead of
 * prompting — a missing host key or an encrypted key both fail within a couple hundred ms, with askpass never
 * called. A default `GIT_SSH_COMMAND` would instead win over the user's own `core.sshCommand` (git gives
 * `GIT_SSH_COMMAND` precedence over it), silently ignoring a port, identity file or jump host they configured;
 * that was confirmed too. `SSH_ASKPASS` is set to `''` regardless, as a no-cost fallback for pre-8.4 OpenSSH,
 * which ignores `SSH_ASKPASS_REQUIRE`.
 *
 * Fix round 1 (I4): strips the git variables that locate another repository (see `GIT_LOCATION_VARS`) out of
 * `base` before applying `extra`, so an explicit override — e.g. the temporary index a sync commit is built in —
 * still wins.
 */
export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...base }
  for (const key of GIT_LOCATION_VARS) delete cleaned[key]
  const env: NodeJS.ProcessEnv = {
    ...cleaned,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra
  }
  if (platform === 'darwin') {
    // An app started from the Finder gets a minimal PATH: add where Homebrew installs git and git-lfs.
    const parts = (env.PATH ?? '').split(':').filter(Boolean)
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(dir)) parts.push(dir)
    env.PATH = parts.join(':')
  }
  return env
}

/**
 * Runs git in `cwd` without a shell. It never receives credentials: those stay with the system's git.
 *
 * Fix round 1 (I3): built on `spawn`, not `execFile` — `execFile`'s own options do not include `detached`
 * (confirmed against its running process: without it, the child stays in this process's own process group),
 * so it could not give a timeout or cancel the thing it needs to kill a whole process group. `spawn` is used
 * directly and stdout/stderr are buffered here instead.
 */
export class Git {
  private readonly env: NodeJS.ProcessEnv

  constructor(
    readonly cwd: string,
    private readonly opts: GitOptions = {}
  ) {
    this.env = gitEnv(process.env, process.platform, opts.env)
  }

  run(args: string[], o: GitRunOptions = {}): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      const timeoutMs = o.timeoutMs ?? LOCAL_TIMEOUT_MS
      // Fix round 1 (I3): a plain kill signal/timeout only reaches git itself; ssh, git-lfs and pack-objects
      // can outlive it. These flags let the exit handler tell a real timeout/cancel from any other exit.
      let timedOut = false
      let cancelled = false
      let settled = false
      let killTimer: NodeJS.Timeout | undefined
      let bufferExceeded = false
      // Fix round 3 (m8): escalate() can otherwise run more than once (e.g. an overflow followed by a timeout),
      // each time sending another SIGTERM and replacing killTimer, orphaning the previous one. Harmless, but
      // this makes it idempotent.
      let escalated = false

      const child = spawn(this.opts.bin ?? 'git', args, {
        cwd: this.cwd,
        env: o.env ? { ...this.env, ...o.env } : this.env,
        windowsHide: true,
        // Fix round 1 (I2, I3): a new process group on POSIX denies ssh a controlling terminal (so a
        // passphrase or host-key prompt fails instead of hanging) and lets a timeout/cancel kill the whole
        // group — ssh, git-lfs, pack-objects — not just git's own pid.
        detached: process.platform !== 'win32'
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutLen = 0
      let stderrLen = 0

      const collect = (chunks: Buffer[], len: number, data: Buffer): number => {
        if (len >= MAX_BUFFER) {
          if (!bufferExceeded) {
            bufferExceeded = true
            escalate()
          }
          return len
        }
        chunks.push(data)
        return len + data.length
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdoutLen = collect(stdoutChunks, stdoutLen, data)
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderrLen = collect(stderrChunks, stderrLen, data)
      })

      // Fix round 2 (m5): detach the abort listener once the run is done, so a long-lived signal (e.g. one
      // shutdown signal shared by every run in the app) does not accumulate a listener per run.
      let abortListener: (() => void) | undefined
      const detachAbortListener = (): void => {
        if (abortListener) o.signal?.removeEventListener('abort', abortListener)
      }

      // Fix round 2 (m2): clearing killTimer on settle would cancel a SIGKILL that is still needed — a group
      // member that ignores SIGTERM and has already closed its own pipes would otherwise survive forever.
      // Only clear it when the run was never escalated for a timeout/cancel/overflow in the first place.
      const clearTimers = (): void => {
        clearTimeout(timer)
        if (!escalated && killTimer) clearTimeout(killTimer)
      }

      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimers()
        detachAbortListener()
        const stdout = Buffer.concat(stdoutChunks)
        const err = Buffer.concat(stderrChunks).toString('utf8')
        // Fix round 2 (m1): the overflow can race a clean exit — git may write its last bytes and exit 0 just
        // before (or despite) the group kill the overflow triggered. A truncated/overflowing stdout must never
        // look like a success, whatever the exit code says.
        if (bufferExceeded) return reject(new GitError(args, exitCode, `${err}\n${stdout.toString('utf8', 0, Math.min(stdout.length, 65536))}`, 'git_failed'))
        if (exitCode === 0) return resolve({ code: 0, stdout, stderr: err })
        if (typeof exitCode === 'number' && o.okCodes?.includes(exitCode)) return resolve({ code: exitCode, stdout, stderr: err })
        const output = `${err}\n${stdout.toString('utf8', 0, Math.min(stdout.length, 65536))}`
        if (timedOut) return reject(new GitError(args, exitCode, output, 'timeout'))
        if (cancelled) return reject(new GitError(args, exitCode, output, 'cancelled'))
        reject(new GitError(args, exitCode, output, classifyGitError(output)))
      }

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimers()
        detachAbortListener()
        const output = Buffer.concat(stderrChunks).toString('utf8')
        // Fix round 1 (I1): node reports a missing cwd the same way as a missing git binary (ENOENT). An
        // unplugged drive or a deleted project folder must not tell the user to install git.
        if (error.code === 'ENOENT') return reject(new GitError(args, null, output, existsSync(this.cwd) ? 'git_missing' : 'project_missing'))
        reject(new GitError(args, null, output, classifyGitError(output)))
      })

      child.on('close', (code) => finish(code))

      const killGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
        // Fix round 2 (m2): no `settled` guard here any more — git exiting does not mean every group member
        // did. A pid that is already gone just answers ESRCH, which is caught below.
        if (!child.pid) return
        if (process.platform === 'win32') {
          // `/T` kills the whole tree; `/F` forces it; `windowsHide` keeps it from flashing a console (m3).
          // taskkill failing (e.g. already exited) is not our problem.
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
        } else {
          try {
            // The negative pid targets the process group (its id equals the leader's pid when spawned detached).
            process.kill(-child.pid, signal)
          } catch {
            try {
              child.kill(signal)
            } catch {
              // Already gone.
            }
          }
        }
      }

      function escalate(): void {
        // Fix round 3 (m8): idempotent — a second call (overflow then timeout, or timeout then abort) must not
        // send another SIGTERM or orphan the previous killTimer.
        if (escalated) return
        escalated = true
        killGroup('SIGTERM')
        // Fix round 3 (m7): on Windows the first taskkill already ran with /T /F, which kills the whole tree.
        // A second, delayed call is redundant and, since Windows recycles pids quickly once a process handle is
        // released, risks hitting an unrelated process tree that happens to reuse the same pid by then.
        if (process.platform !== 'win32') killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      }

      const timer = setTimeout(() => {
        timedOut = true
        escalate()
      }, timeoutMs)

      if (o.signal) {
        if (o.signal.aborted) {
          cancelled = true
          escalate()
        } else {
          abortListener = () => {
            cancelled = true
            escalate()
          }
          o.signal.addEventListener('abort', abortListener, { once: true })
        }
      }

      // git may exit before reading all its input (e.g. on an error): a broken pipe is not a failure of its own.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(o.input ?? '')
    })
  }

  async text(args: string[], o?: GitRunOptions): Promise<string> {
    return (await this.run(args, o)).stdout.toString('utf8')
  }
}
