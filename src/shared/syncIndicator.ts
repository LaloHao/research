import type { SyncStatus } from './sync'

/** Every state the rail and the Sync view show; each has `sync.status.<state>` (full) and `sync.short.<state>` (rail). */
export const SYNC_STATES = [
  'loading',
  'unavailable',
  'syncing',
  'conflicts',
  'no_git',
  'no_repo',
  'no_remote',
  'no_upstream',
  'offline',
  'error',
  'pending',
  'never',
  'just_now',
  'minutes',
  'hours'
] as const
export type SyncState = (typeof SYNC_STATES)[number]
export type SyncTone = 'ok' | 'pending' | 'error' | 'busy' | 'off'

export interface SyncIndicator {
  state: SyncState
  tone: SyncTone
  /** Minutes or hours for `minutes`/`hours`. */
  count: number
}

/** What the rail shows from the last status (null: not loaded yet; 'failed': it could not be read). */
export function syncIndicator(status: SyncStatus | null | 'failed', now: number): SyncIndicator {
  const of = (state: SyncState, tone: SyncTone, count = 0): SyncIndicator => ({ state, tone, count })
  if (status === null) return of('loading', 'off')
  if (status === 'failed') return of('unavailable', 'error')
  if (status.phase === 'syncing') return of('syncing', 'busy')
  if (status.conflicts > 0) return of('conflicts', 'error')
  // The project folder is gone (an unplugged drive): the status says `no_repo`, but there is nothing to set up.
  if (status.error?.code === 'project_missing') return of('error', 'error')
  if (status.setup !== 'ready') return of(status.setup, 'off')
  if (status.phase === 'error' && status.error) {
    return status.error.code === 'offline' || status.error.code === 'timeout' ? of('offline', 'error') : of('error', 'error')
  }
  if (status.dirty || status.ahead > 0) return of('pending', 'pending')
  if (!status.lastSyncAt) return of('never', 'off')
  const minutes = Math.max(0, Math.floor((now - Date.parse(status.lastSyncAt)) / 60_000))
  if (minutes < 1) return of('just_now', 'ok')
  return minutes < 60 ? of('minutes', 'ok', minutes) : of('hours', 'ok', Math.floor(minutes / 60))
}

/** The rail button syncs right away when it can; otherwise it opens the Sync view, which explains what is missing. */
export function railAction(status: SyncStatus | null | 'failed'): 'sync' | 'open' | 'none' {
  if (status === null) return 'none'
  if (status === 'failed' || status.setup !== 'ready' || status.conflicts > 0 || status.phase === 'error') return 'open'
  return status.phase === 'syncing' ? 'none' : 'sync'
}
