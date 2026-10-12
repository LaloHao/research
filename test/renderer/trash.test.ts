import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { batchConfirmHolds, batchRemoveReady, deviceKind, facetKey, filterTrash, movedKeys, prune, restorable, restoreDetails, shortDevice, toggle, toggleAll, trashedDay } from '../../src/renderer/lib/trash'
import type { TrashEntry } from '../../src/shared/trash'

const entry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: 'he2017drain',
  title: 'Drain: An Online Log Parsing Approach',
  authors_label: 'He & Zhu',
  year: 2017,
  trashed_at: '2026-10-11T12:00:00.000Z',
  device: '22222222-2222-2222-2222-222222222222',
  this_device: true,
  problem: null,
  ...over
})

describe('trash view', () => {
  it('searches title, authors, year and key, ignoring case and accents', () => {
    const list = [entry(), entry({ id: 'garcia2020logs', title: 'Análisis de logs', authors_label: 'García', year: 2020 })]
    expect(filterTrash(list, '').map((e) => e.id)).toEqual(['he2017drain', 'garcia2020logs'])
    expect(filterTrash(list, 'ANALISIS garcia').map((e) => e.id)).toEqual(['garcia2020logs'])
    expect(filterTrash(list, '2017').map((e) => e.id)).toEqual(['he2017drain'])
    expect(filterTrash(list, 'drain zzz')).toEqual([])
  })

  it('toggles one key or all the visible ones, and drops keys that left the trash', () => {
    expect([...toggle(new Set(['a']), 'b')]).toEqual(['a', 'b'])
    expect([...toggle(new Set(['a', 'b']), 'a')]).toEqual(['b'])
    const visible = [entry({ id: 'a1' }), entry({ id: 'b1' })]
    expect([...toggleAll(new Set(['z1']), visible)].sort()).toEqual(['a1', 'b1', 'z1'])
    expect([...toggleAll(new Set(['a1', 'b1', 'z1']), visible)]).toEqual(['z1'])
    const same = new Set(['a1'])
    expect(prune(same, visible)).toBe(same)
    expect([...prune(new Set(['a1', 'gone']), visible)]).toEqual(['a1'])
  })

  it('names the device and the day it was removed', () => {
    expect(deviceKind(entry())).toBe('this')
    expect(deviceKind(entry({ this_device: false }))).toBe('other')
    expect(deviceKind(entry({ this_device: false, device: null }))).toBe('unknown')
    expect(shortDevice('22222222-2222-2222-2222-222222222222')).toBe('22222222')
    expect(trashedDay('2026-10-11T12:00:00.000Z')).toBe('2026-10-11')
    expect(trashedDay(null)).toBeNull()
    expect(trashedDay('yesterday')).toBeNull()
  })

  it('lists the papers that came back under another key', () => {
    const outcome = { restored: [{ id: 'a1', key: 'a1' }, { id: 'b1', key: 'b1a' }], conflicts: [], failed: [] }
    expect(movedKeys(outcome)).toEqual([{ id: 'b1', key: 'b1a' }])
  })

  it('details what a restore did besides coming back: other keys, remnants, index failures and errors', () => {
    const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction
    const outcome = {
      restored: [
        { id: 'a1', key: 'a1' },
        { id: 'b1', key: 'b1a', remnant: true as const },
        { id: 'c1', key: 'c1', warning: 'index_failed' as const }
      ],
      conflicts: [],
      failed: [{ id: 'd1', error: 'not_in_trash' }]
    }
    expect(restoreDetails(t, outcome)).toEqual([
      'trash.restored_as {"id":"b1","key":"b1a"}',
      'trash.restored_remnant {"id":"b1"}',
      'trash.restored_index_failed {"key":"c1"}',
      'd1: errors.not_in_trash {"defaultValue":"not_in_trash"}'
    ])
    expect(restoreDetails(t, { restored: [{ id: 'a1', key: 'a1' }], conflicts: [], failed: [] })).toEqual([])
  })

  it('restores in batch only the selected entries without a problem', () => {
    const list = [entry({ id: 'a1' }), entry({ id: 'b1', problem: 'invalid_yaml' }), entry({ id: 'c1' })]
    expect(restorable(list, new Set(['b1', 'c1', 'gone']))).toEqual(['c1'])
    expect(restorable(list, new Set(['b1']))).toEqual([])
  })

  it('offers the batch removal only once the rows and facet ids match the current search and filters', () => {
    const filters = [{ facet: 'technique', value: 'ner' }]
    const key = facetKey(filters)
    expect(batchRemoveReady({ query: 'drain', rowsQuery: 'drain', facetFilters: [], facetIdsKey: null })).toBe(true)
    // Rows still loading for the new search.
    expect(batchRemoveReady({ query: 'drain', rowsQuery: '', facetFilters: [], facetIdsKey: null })).toBe(false)
    expect(batchRemoveReady({ query: '', rowsQuery: null, facetFilters: [], facetIdsKey: null })).toBe(false)
    // Facet ids not loaded yet, or loaded for the previous filters.
    expect(batchRemoveReady({ query: '', rowsQuery: '', facetFilters: filters, facetIdsKey: null })).toBe(false)
    expect(batchRemoveReady({ query: '', rowsQuery: '', facetFilters: filters, facetIdsKey: facetKey([]) })).toBe(false)
    expect(batchRemoveReady({ query: '', rowsQuery: '', facetFilters: filters, facetIdsKey: key })).toBe(true)
  })

  it('runs a confirmed batch only on the visible list it was confirmed for, with the rows matching the search and filters', () => {
    expect(batchConfirmHolds({ visibleKey: 'a b' }, { visibleKey: 'a b', ready: true })).toBe(true)
    // The visible papers changed since the confirmation (a filter narrowed, a reload landed).
    expect(batchConfirmHolds({ visibleKey: 'a b' }, { visibleKey: 'a', ready: true })).toBe(false)
    // Rows or facet ids still loading for the current search or filters.
    expect(batchConfirmHolds({ visibleKey: 'a b' }, { visibleKey: 'a b', ready: false })).toBe(false)
    expect(batchConfirmHolds(null, { visibleKey: 'a b', ready: true })).toBe(false)
  })
})
