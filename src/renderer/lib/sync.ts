import { AUTO_SYNC_MINUTES, hasPasswordInUrl, isRemoteUrl, type ConflictChoice, type ConflictDecision, type ConflictItem, type SyncStatus } from '../../shared/sync'
import { parseCount, type NumberIssue } from './numberField'

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

/**
 * The two buttons of a conflict, as i18n keys: «Quedarme con la mía» / «Usar la del otro equipo» for a file; for a paper
 * one machine trashed while the other edited it, «Conservar el paper» (the editing side) / «Aceptar que se quitó».
 */
export function choiceButtons(item: ConflictItem): { choice: ConflictChoice; key: string }[] {
  if (item.kind === 'paper') {
    const keep: ConflictChoice = item.ours === 'edited' ? 'ours' : 'theirs'
    const remove: ConflictChoice = keep === 'ours' ? 'theirs' : 'ours'
    return [
      { choice: keep, key: 'sync.conflicts.keep_paper' },
      { choice: remove, key: 'sync.conflicts.accept_removal' }
    ]
  }
  return [
    { choice: 'ours', key: 'sync.conflicts.keep_mine' },
    { choice: 'theirs', key: 'sync.conflicts.use_theirs' }
  ]
}

/** The panel's choices by conflict id, each bound to the version of the conflict it was made for. */
export type Choices = Readonly<Record<string, ConflictDecision>>

/** A choice counts only for the version of the conflict it was made for. */
function chosen(item: ConflictItem, choices: Choices): ConflictDecision | null {
  const c = choices[item.id]
  return c && c.version === item.version ? c : null
}

export function missingChoices(items: ConflictItem[], choices: Choices): number {
  return items.filter((item) => !chosen(item, choices)).length
}

/** The choice shown as picked for a conflict, if it was made for the versions listed now. */
export function choiceOf(item: ConflictItem, choices: Choices): ConflictChoice | null {
  return chosen(item, choices)?.choice ?? null
}

/** The choices of conflicts still listed with the same version: a conflict whose versions changed is asked again. */
export function keepChoices(choices: Choices, items: ConflictItem[]): Record<string, ConflictDecision> {
  const kept: Record<string, ConflictDecision> = {}
  for (const item of items) {
    const c = chosen(item, choices)
    if (c) kept[item.id] = c
  }
  return kept
}

/** Conflicts still listed whose versions changed since a choice was made for them (the user must review them again). */
export function staleChoices(choices: Choices, items: ConflictItem[]): string[] {
  return items.filter((item) => choices[item.id] && !chosen(item, choices)).map((item) => item.id)
}

/** The files an error names, for its message: the first five, then «…». */
export function pathList(paths: string[], max = 5): string {
  return paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')}, …`
}

/** Above this many line pairs the two versions are shown side by side without aligning them. */
export const MAX_DIFF_CELLS = 4_000_000

export interface DiffRow {
  left: string | null
  right: string | null
  kind: 'same' | 'changed' | 'removed' | 'added'
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Removed and added lines side by side: `changed` rows while both last, then the rest alone. */
function pairUp(removed: string[], added: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  for (let k = 0; k < Math.max(removed.length, added.length); k++) {
    const left = removed[k] ?? null
    const right = added[k] ?? null
    rows.push({ left, right, kind: left !== null && right !== null ? 'changed' : left !== null ? 'removed' : 'added' })
  }
  return rows
}

/** Longest common subsequence of lines, walked into rows. */
function lcsRows(x: string[], y: string[]): DiffRow[] {
  const n = x.length
  const m = y.length
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const rows: DiffRow[] = []
  const removed: string[] = []
  const added: string[] = []
  const flush = (): void => {
    rows.push(...pairUp(removed.splice(0), added.splice(0)))
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      flush()
      rows.push({ left: x[i], right: y[j], kind: 'same' })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      removed.push(x[i++])
    } else {
      added.push(y[j++])
    }
  }
  while (i < n) removed.push(x[i++])
  while (j < m) added.push(y[j++])
  flush()
  return rows
}

/** This machine's version (left) against the other machine's (right), line by line. */
export function lineDiff(a: string, b: string): DiffRow[] {
  const x = splitLines(a)
  const y = splitLines(b)
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let endX = x.length
  let endY = y.length
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--
    endY--
  }
  const same = (line: string): DiffRow => ({ left: line, right: line, kind: 'same' })
  const midX = x.slice(start, endX)
  const midY = y.slice(start, endY)
  const middle = midX.length * midY.length > MAX_DIFF_CELLS ? pairUp(midX, midY) : lcsRows(midX, midY)
  return [...x.slice(0, start).map(same), ...middle, ...x.slice(endX).map(same)]
}

export type UrlProblem = 'empty' | 'password' | 'invalid'

/** Why a typed remote cannot be used; each has `sync.setup.url_<problem>`. */
export function remoteUrlProblem(raw: string): UrlProblem | null {
  const url = raw.trim()
  if (url === '') return 'empty'
  if (hasPasswordInUrl(url)) return 'password'
  return isRemoteUrl(url) ? null : 'invalid'
}

export type MinutesParsed = { ok: true; value: number } | { ok: false; issue: NumberIssue | 'out_of_range' }

/** «Cada (minutos)» of the automatic sync. */
export function parseSyncMinutes(raw: string): MinutesParsed {
  const parsed = parseCount(raw)
  if (!parsed.ok) return parsed
  return parsed.value < AUTO_SYNC_MINUTES.min || parsed.value > AUTO_SYNC_MINUTES.max ? { ok: false, issue: 'out_of_range' } : parsed
}
