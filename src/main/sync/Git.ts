import { execFile } from 'node:child_process'
import type { SyncErrorCode } from '../../shared/sync'

export const LOCAL_TIMEOUT_MS = 60_000
export const NETWORK_TIMEOUT_MS = 180_000
const MAX_BUFFER = 256 * 1024 * 1024

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
  [/\((?:fetch first|non-fast-forward|stale info)\)|cannot lock ref|failed to update ref/i, 'push_behind'],
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
  [/would be overwritten by (?:merge|checkout)/i, 'local_changes_block'],
  [/not a git repository/i, 'not_a_repo']
]

export function classifyGitError(output: string): GitFailure {
  return RULES.find(([pattern]) => pattern.test(output))?.[1] ?? 'git_failed'
}

/** git never prompts (a missing credential fails instead of hanging) and speaks English, so its errors can be classified. */
export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C', ...extra }
  if (platform === 'darwin') {
    // An app started from the Finder gets a minimal PATH: add where Homebrew installs git and git-lfs.
    const parts = (env.PATH ?? '').split(':').filter(Boolean)
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(dir)) parts.push(dir)
    env.PATH = parts.join(':')
  }
  return env
}

/** Runs git in `cwd` with `execFile` (no shell). It never receives credentials: those stay with the system's git. */
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
      const child = execFile(
        this.opts.bin ?? 'git',
        args,
        {
          cwd: this.cwd,
          env: o.env ? { ...this.env, ...o.env } : this.env,
          encoding: 'buffer',
          maxBuffer: MAX_BUFFER,
          timeout: o.timeoutMs ?? LOCAL_TIMEOUT_MS,
          signal: o.signal,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const err = stderr.toString('utf8')
          if (!error) return resolve({ code: 0, stdout, stderr: err })
          const exit = error.code
          if (typeof exit === 'number' && o.okCodes?.includes(exit)) return resolve({ code: exit, stdout, stderr: err })
          const output = `${err}\n${stdout.toString('utf8', 0, Math.min(stdout.length, 65536))}`
          if (exit === 'ENOENT') return reject(new GitError(args, null, output, 'git_missing'))
          if (error.name === 'AbortError') return reject(new GitError(args, null, output, 'cancelled'))
          if (error.killed) return reject(new GitError(args, null, output, 'timeout'))
          reject(new GitError(args, typeof exit === 'number' ? exit : null, output, classifyGitError(output)))
        }
      )
      // git may exit before reading all its input (e.g. on an error): a broken pipe is not a failure of its own.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(o.input ?? '')
    })
  }

  async text(args: string[], o?: GitRunOptions): Promise<string> {
    return (await this.run(args, o)).stdout.toString('utf8')
  }
}
