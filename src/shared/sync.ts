/** Where the project stands with git before any sync can run. */
export const SYNC_SETUPS = ['ready', 'no_git', 'no_repo', 'no_remote', 'no_upstream'] as const
export type SyncSetup = (typeof SYNC_SETUPS)[number]

export const SYNC_PHASES = ['idle', 'syncing', 'conflicts', 'error'] as const
export type SyncPhase = (typeof SYNC_PHASES)[number]

/** Why a sync stopped; each has a Spanish text under `sync.errors.<code>`. */
export const SYNC_ERROR_CODES = [
  'git_missing',
  // The project folder itself is missing or unmounted (e.g. an unplugged drive), not that git is uninstalled.
  // Fix round 1 (I1): added, no Spanish text under sync.errors yet — a later UI task picks a message for it.
  'project_missing',
  'lfs_missing',
  'not_a_repo',
  'no_remote',
  'no_upstream',
  'remote_exists',
  // A remote URL that fails `isRemoteUrl` (a password in it, a leading `-`, whitespace or control characters).
  'invalid_remote_url',
  'detached_head',
  'merge_in_progress',
  'unmerged_files',
  'auth',
  'offline',
  'timeout',
  'remote_not_found',
  'push_rejected',
  // Under the LFS policy: the PDFs could not be uploaded (other than offline or credentials), so nothing was pushed.
  'lfs_upload_failed',
  'conflict_outside',
  'local_changes_block',
  'unrelated_histories',
  'identity_missing',
  'cancelled',
  'git_failed'
] as const
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]

export interface SyncError {
  code: SyncErrorCode
  /** Files involved, from the repository root (e.g. the conflicts outside the project). */
  paths: string[]
}

export interface SyncStatus {
  setup: SyncSetup
  phase: SyncPhase
  /** Last successful sync in this session (ISO); null before the first one. */
  lastSyncAt: string | null
  /** Uncommitted changes inside the project folder. */
  dirty: boolean
  /** Local commits the remote does not have yet. */
  ahead: number
  /** The last sync's failure; null once a sync succeeds. */
  error: SyncError | null
  /** That failure came from an automatic sync: the rail shows it, nothing else does. */
  errorAuto: boolean
  /** Files or papers waiting for a decision. */
  conflicts: number
  repoRoot: string | null
  branch: string | null
  /** e.g. `origin/main`. */
  upstream: string | null
}

export type SyncResult = { ok: true; outcome: 'synced' | 'conflicts' } | { ok: false; error: SyncError }

/** What one machine did to a file (or a paper) in a conflict; each has a text under `sync.sides.<side>`. */
export const CONFLICT_SIDES = ['modified', 'added', 'deleted', 'trashed', 'edited'] as const
export type ConflictSide = (typeof CONFLICT_SIDES)[number]

/** Whose version wins: this machine's (`ours`) or the other machine's (`theirs`). */
export const CONFLICT_CHOICES = ['ours', 'theirs'] as const
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number]

/** `file:<path from the repository root>` or `paper:<key>`. */
export const CONFLICT_ID = /^(?:file:.+|paper:[a-z][a-z0-9]*)$/

/** The versions a conflict is about, as a short hash: a choice applies only to the versions it was made for. */
export const CONFLICT_VERSION = /^[0-9a-f]{16}$/

/** A choice in the conflicts panel, bound to the version of the conflict the user saw. */
export interface ConflictDecision {
  choice: ConflictChoice
  version: string
}

/** One decision the user makes before the sync can finish. */
export interface ConflictItem {
  id: string
  /** `file`: changed on both machines; `paper`: moved to the trash on one machine while the other edited it. */
  kind: 'file' | 'paper'
  /** Inside the project folder: `papers/<key>/summary.md`, or `papers/<key>/` for a whole paper. */
  path: string
  paperId: string | null
  paperTitle: string | null
  ours: ConflictSide
  theirs: ConflictSide
  /** Changes whenever either version (or the base) changes; see `CONFLICT_VERSION`. */
  version: string
}

/** Both versions of one file for the side-by-side view; null is a side where the file does not exist. */
export interface DiffFile {
  path: string
  ours: string | null
  theirs: string | null
  unavailable: 'binary' | 'too_large' | null
}

export interface ConflictDiff {
  files: DiffFile[]
}

/** The answer to «Hay cambios sin sincronizar» when the window closes («Sincronizar y cerrar» ends in `close`). */
export const CLOSE_DECISIONS = ['close', 'cancel'] as const
export type CloseDecision = (typeof CLOSE_DECISIONS)[number]

/** Bounds of the automatic sync interval, in minutes (a per-device setting). */
export const AUTO_SYNC_MINUTES = { min: 5, max: 120, default: 10 } as const

/**
 * `scheme://user:password@host…`: git would keep the password in .git/config.
 * Fix round 1 (M6): the user part may itself contain an `@` (`https://me@corp.com:secret@host/x.git`), so the
 * password is whatever sits between the last `:` and the last `@` of the authority — not anchored to `[^/@]`,
 * which a raw `@` in the user name would defeat. `ssh://git@host:2222/…` and a bare `host:port` still don't match:
 * neither has a `@` after the `:`.
 */
export function hasPasswordInUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/]*:[^/]*@/i.test(url)
}

/** A remote the user typed: never read as an option, no whitespace or control characters, no password in it. */
export function isRemoteUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2000 || url.startsWith('-')) return false
  if (/[\s\x00-\x1f\x7f]/.test(url)) return false
  return !hasPasswordInUrl(url)
}
