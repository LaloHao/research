import type { TFunction } from 'i18next'
import type { FacetFilter } from '../../shared/relations'
import type { RestoreOutcome, TrashEntry } from '../../shared/trash'
import { errorText } from './errorText'

/** How long «N papers movidos a la papelera · Deshacer» stays on screen. */
export const TRASH_UNDO_MS = 8000

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** The Papelera search: every word must appear in the title, authors, year or key (case and accents ignored). */
export function filterTrash(entries: TrashEntry[], query: string): TrashEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return entries
  return entries.filter((e) => {
    const text = fold([e.title, e.authors_label, e.year ?? '', e.id].join(' '))
    return words.every((w) => text.includes(w))
  })
}

export function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** With every visible entry selected, unselects them; otherwise selects them all. Hidden selections stay. */
export function toggleAll(set: ReadonlySet<string>, visible: TrashEntry[]): Set<string> {
  const next = new Set(set)
  const all = visible.length > 0 && visible.every((e) => set.has(e.id))
  for (const e of visible) {
    if (all) next.delete(e.id)
    else next.add(e.id)
  }
  return next
}

/** The selection after a refresh: keys no longer in the trash drop out (the same set when nothing changed). */
export function prune(set: ReadonlySet<string>, entries: TrashEntry[]): ReadonlySet<string> {
  const present = new Set(entries.map((e) => e.id))
  return [...set].every((id) => present.has(id)) ? set : new Set([...set].filter((id) => present.has(id)))
}

/** «Restaurar (N)»: the selected entries that can be restored (an entry with a problem is not, as its own button says). */
export function restorable(entries: TrashEntry[], selected: ReadonlySet<string>): string[] {
  return entries.filter((e) => selected.has(e.id) && e.problem === null).map((e) => e.id)
}

/** Identifies the facet filters a set of facet paper ids was loaded for. */
export function facetKey(filters: FacetFilter[]): string {
  return JSON.stringify(filters)
}

/**
 * The library's batch «Quitar de la biblioteca» acts on the visible rows, so it is offered only once those rows were
 * loaded for the current search and, with facet filters, the facet ids for those filters: never on a stale, larger set.
 */
export function batchRemoveReady(state: { query: string; rowsQuery: string | null; facetFilters: FacetFilter[]; facetIdsKey: string | null }): boolean {
  return state.rowsQuery === state.query && (state.facetFilters.length === 0 || state.facetIdsKey === facetKey(state.facetFilters))
}

export function deviceKind(e: TrashEntry): 'this' | 'other' | 'unknown' {
  return e.this_device ? 'this' : e.device ? 'other' : 'unknown'
}

export function shortDevice(device: string | null): string {
  return (device ?? '').slice(0, 8)
}

/** The day it was removed, as trashed.yaml has it (YYYY-MM-DD); null when unknown. */
export function trashedDay(iso: string | null): string | null {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null
}

/** Papers that came back under another key (merged into another paper, or their key was taken): the notice names them. */
export function movedKeys(outcome: RestoreOutcome): { id: string; key: string }[] {
  return outcome.restored.filter((r) => r.key !== r.id).map((r) => ({ id: r.id, key: r.key }))
}

/** What a restore did besides bringing papers back as they were (another key, a remnant, an index failure, errors): one sentence each. */
export function restoreDetails(t: TFunction, outcome: RestoreOutcome): string[] {
  return [
    ...movedKeys(outcome).map((m) => t('trash.restored_as', m)),
    ...outcome.restored.filter((x) => x.remnant).map((x) => t('trash.restored_remnant', { id: x.id })),
    ...outcome.restored.filter((x) => x.warning === 'index_failed').map((x) => t('trash.restored_index_failed', { key: x.key })),
    ...outcome.failed.map((f) => `${f.id}: ${errorText(t, f.error)}`)
  ]
}
