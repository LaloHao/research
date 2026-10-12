import { describe, expect, it } from 'vitest'
import {
  choiceButtons,
  keepChoices,
  lineDiff,
  MAX_DIFF_CELLS,
  missingChoices,
  parseSyncMinutes,
  pathList,
  railAction,
  remoteUrlProblem,
  staleChoices,
  syncIndicator
} from '../../src/renderer/lib/sync'
import type { ConflictItem, SyncStatus } from '../../src/shared/sync'

const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  setup: 'ready',
  phase: 'idle',
  lastSyncAt: null,
  dirty: false,
  ahead: 0,
  error: null,
  errorAuto: false,
  conflicts: 0,
  repoRoot: '/home/me/thesis',
  branch: 'main',
  upstream: 'origin/main',
  ...over
})
const item = (over: Partial<ConflictItem> = {}): ConflictItem => ({
  id: 'file:papers/k/summary.md',
  kind: 'file',
  path: 'papers/k/summary.md',
  paperId: 'k',
  paperTitle: 'Kernel paper',
  ours: 'modified',
  theirs: 'modified',
  version: '0000000000000001',
  ...over
})

describe('sync indicator', () => {
  it('says how long ago the last sync was', () => {
    const ago = (minutes: number) => syncIndicator(status({ lastSyncAt: new Date(NOW - minutes * 60_000).toISOString() }), NOW)
    expect(ago(0.5)).toEqual({ state: 'just_now', tone: 'ok', count: 0 })
    expect(ago(3)).toEqual({ state: 'minutes', tone: 'ok', count: 3 })
    expect(ago(130)).toEqual({ state: 'hours', tone: 'ok', count: 2 })
    expect(syncIndicator(status(), NOW)).toEqual({ state: 'never', tone: 'off', count: 0 })
  })

  it('shows what needs attention first: syncing, conflicts, setup, errors, then changes not pushed', () => {
    expect(syncIndicator(null, NOW).state).toBe('loading')
    expect(syncIndicator('failed', NOW)).toMatchObject({ state: 'unavailable', tone: 'error' })
    expect(syncIndicator(status({ phase: 'syncing', conflicts: 2 }), NOW)).toMatchObject({ state: 'syncing', tone: 'busy' })
    expect(syncIndicator(status({ phase: 'error', conflicts: 1 }), NOW)).toMatchObject({ state: 'conflicts', tone: 'error' })
    expect(syncIndicator(status({ setup: 'no_remote', dirty: true }), NOW)).toMatchObject({ state: 'no_remote', tone: 'off' })
    expect(syncIndicator(status({ phase: 'error', error: { code: 'offline', paths: [] }, ahead: 1 }), NOW)).toMatchObject({ state: 'offline', tone: 'error' })
    expect(syncIndicator(status({ phase: 'error', error: { code: 'auth', paths: [] } }), NOW)).toMatchObject({ state: 'error', tone: 'error' })
    expect(syncIndicator(status({ dirty: true, lastSyncAt: new Date(NOW).toISOString() }), NOW)).toMatchObject({ state: 'pending', tone: 'pending' })
    expect(syncIndicator(status({ ahead: 2 }), NOW)).toMatchObject({ state: 'pending', tone: 'pending' })
    // A missing project folder is reported with setup 'no_repo', but it is an error to show, not a repository to create.
    expect(syncIndicator(status({ setup: 'no_repo', phase: 'error', error: { code: 'project_missing', paths: [] }, repoRoot: null }), NOW)).toMatchObject({
      state: 'error',
      tone: 'error'
    })
  })

  it('syncs from the rail when it can, and opens the Sync view when something needs explaining', () => {
    expect(railAction(null)).toBe('none')
    expect(railAction(status({ phase: 'syncing' }))).toBe('none')
    expect(railAction(status())).toBe('sync')
    expect(railAction(status({ dirty: true }))).toBe('sync')
    for (const s of ['failed' as const, status({ setup: 'no_repo' }), status({ conflicts: 1 }), status({ phase: 'error', error: { code: 'auth', paths: [] } })]) {
      expect(railAction(s)).toBe('open')
    }
  })
})

describe('conflicts', () => {
  it('offers «Quedarme con la mía» / «Usar la del otro equipo» for a file, and keep / accept the removal for a paper', () => {
    expect(choiceButtons(item())).toEqual([
      { choice: 'ours', key: 'sync.conflicts.keep_mine' },
      { choice: 'theirs', key: 'sync.conflicts.use_theirs' }
    ])
    expect(choiceButtons(item({ kind: 'paper', ours: 'edited', theirs: 'trashed' }))).toEqual([
      { choice: 'ours', key: 'sync.conflicts.keep_paper' },
      { choice: 'theirs', key: 'sync.conflicts.accept_removal' }
    ])
    expect(choiceButtons(item({ kind: 'paper', ours: 'trashed', theirs: 'edited' }))).toEqual([
      { choice: 'theirs', key: 'sync.conflicts.keep_paper' },
      { choice: 'ours', key: 'sync.conflicts.accept_removal' }
    ])
  })

  it('counts the decisions still missing and drops choices of conflicts no longer listed', () => {
    const items = [item(), item({ id: 'paper:j', kind: 'paper', paperId: 'j', ours: 'edited', theirs: 'trashed' })]
    const v = '0000000000000001'
    expect(missingChoices(items, {})).toBe(2)
    expect(missingChoices(items, { 'paper:j': { choice: 'ours', version: v } })).toBe(1)
    expect(keepChoices({ 'paper:j': { choice: 'ours', version: v }, 'file:gone.md': { choice: 'theirs', version: v } }, items)).toEqual({
      'paper:j': { choice: 'ours', version: v }
    })
  })

  it('keeps a choice only while its conflict has the version it was made for, and names the ones that changed', () => {
    const before = { 'file:papers/k/summary.md': { choice: 'ours' as const, version: '0000000000000001' }, 'file:gone.md': { choice: 'theirs' as const, version: '0000000000000001' } }
    const changed = [item({ version: '0000000000000002' })]
    expect(keepChoices(before, changed)).toEqual({})
    // A choice for an older version counts as missing, even before the list is filtered.
    expect(missingChoices(changed, before)).toBe(1)
    expect(staleChoices(before, changed)).toEqual(['file:papers/k/summary.md'])
    // A conflict no longer listed was settled: nothing to review again.
    expect(staleChoices(before, [item()])).toEqual([])
    expect(keepChoices(before, [item()])).toEqual({ 'file:papers/k/summary.md': before['file:papers/k/summary.md'] })
  })

  it('lists the first files an error names', () => {
    expect(pathList(['a', 'b'])).toBe('a, b')
    expect(pathList(['1', '2', '3', '4', '5', '6', '7'])).toBe('1, 2, 3, 4, 5, …')
  })
})

describe('lineDiff', () => {
  it('lines up both versions, pairing changed lines', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { left: 'a', right: 'a', kind: 'same' },
      { left: 'b', right: 'B', kind: 'changed' },
      { left: 'c', right: 'c', kind: 'same' }
    ])
    expect(lineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([
      { left: 'a', right: 'a', kind: 'same' },
      { left: null, right: 'b', kind: 'added' },
      { left: 'c', right: 'c', kind: 'same' }
    ])
    expect(lineDiff('a\nb\n', 'a\n')).toEqual([
      { left: 'a', right: 'a', kind: 'same' },
      { left: 'b', right: null, kind: 'removed' }
    ])
    expect(lineDiff('', 'x\r\ny')).toEqual([
      { left: null, right: 'x', kind: 'added' },
      { left: null, right: 'y', kind: 'added' }
    ])
  })

  it('still shows both sides of very long files, without aligning them', () => {
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1
    const rows = lineDiff(Array.from({ length: n }, (_, i) => `a${i}`).join('\n'), Array.from({ length: n }, (_, i) => `b${i}`).join('\n'))
    expect(rows).toHaveLength(n)
    expect(rows[0]).toEqual({ left: 'a0', right: 'b0', kind: 'changed' })
  })
})

describe('setup and settings checks', () => {
  it('checks the remote URL before sending it', () => {
    expect(remoteUrlProblem('  ')).toBe('empty')
    expect(remoteUrlProblem('https://me:secret@github.com/me/thesis.git')).toBe('password')
    expect(remoteUrlProblem('--upload-pack=x')).toBe('invalid')
    expect(remoteUrlProblem(' git@github.com:me/thesis.git ')).toBeNull()
  })

  it('takes a whole number of minutes between 5 and 120', () => {
    expect(parseSyncMinutes('10')).toEqual({ ok: true, value: 10 })
    expect(parseSyncMinutes('')).toEqual({ ok: false, issue: 'required' })
    expect(parseSyncMinutes('7.5')).toEqual({ ok: false, issue: 'not_integer' })
    expect(parseSyncMinutes('4')).toEqual({ ok: false, issue: 'out_of_range' })
    expect(parseSyncMinutes('121')).toEqual({ ok: false, issue: 'out_of_range' })
  })
})
