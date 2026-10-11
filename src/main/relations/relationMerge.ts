import type { ReviewItem } from '../../shared/summary'
import {
  MAX_JUSTIFICATION,
  orient,
  otherEnd,
  relationId,
  SYMMETRIC_TYPES,
  type PaperRelations,
  type RelationChange,
  type RelationEvidence,
  type RelationOrigin,
  type RelationStatus,
  type RelationType,
  type RelationView,
  type TypedEdge,
  type TypedRelation
} from '../../shared/typedRelations'
import { sortRelations } from '../project/relationsFile'
import { InvalidEdit } from '../summary/merge'

export function toEntry(s: { type: RelationType; from: string; to: string; justification: string; evidence: RelationEvidence[] }, origin: RelationOrigin): TypedRelation {
  const ends = orient(s.from, s.to, s.type)
  return {
    id: relationId(ends.from, ends.to, s.type),
    type: s.type,
    ...ends,
    status: 'suggested',
    edited: false,
    justification: s.justification,
    evidence: s.evidence,
    origin,
    updated_at: origin.at
  }
}

/**
 * Unreviewed suggestions that an earlier analysis of `paperId` itself produced, with a paper this run looked at
 * (`analyzed`): the only entries a new analysis replaces. A pair the run skipped (covered from the other side) keeps them.
 */
export function replaceable(r: TypedRelation, paperId: string, analyzed: ReadonlySet<string>): boolean {
  return r.status === 'suggested' && !r.edited && r.origin?.paper === paperId && analyzed.has(otherEnd(r, paperId))
}

/**
 * A new analysis of `paperId` that looked at the papers in `analyzed`: its own earlier unreviewed suggestions with those
 * papers are replaced (the prompt let the model repeat them); suggestions with papers it skipped, from the other paper's
 * analysis, reviewed, edited and retyped ids are never touched or duplicated.
 */
export function mergeSuggestions(current: TypedRelation[], paperId: string, fresh: TypedRelation[], analyzed: ReadonlySet<string>): TypedRelation[] {
  const kept = current.filter((r) => !replaceable(r, paperId, analyzed))
  const taken = new Set(kept.map((r) => r.id))
  const retyped = new Set(kept.flatMap((r) => r.replaced ?? []))
  const added: TypedRelation[] = []
  for (const r of fresh) {
    if (taken.has(r.id) || retyped.has(r.id)) continue
    taken.add(r.id)
    added.push(r)
  }
  return sortRelations([...kept, ...added])
}

export function withStatus(r: TypedRelation, status: RelationStatus, now: string): TypedRelation {
  return { ...r, status, updated_at: now }
}

/**
 * A suggestion the user put back on purpose (restored after rejecting, or un-confirmed): no longer owned by its
 * paper's analysis, so a later analysis of that paper keeps it (see mergeSuggestions). Other entries are returned as is.
 */
export function userKept(r: TypedRelation): TypedRelation {
  if (r.status !== 'suggested' || r.origin?.paper === undefined) return r
  const { paper: _paper, ...origin } = r.origin
  return { ...r, origin }
}

/** The user's own type: confirmed, edited, and every id it had before is never suggested again. */
export function retype(r: TypedRelation, type: RelationType, now: string): TypedRelation {
  const ends = orient(r.from, r.to, type)
  const replaced = [...new Set([...(r.replaced ?? []), r.id])]
  return { ...r, ...ends, type, id: relationId(ends.from, ends.to, type), status: 'confirmed', edited: true, replaced, updated_at: now }
}

/** The user's own direction (same id: the pair and the type do not change). */
export function reverse(r: TypedRelation, now: string): TypedRelation {
  if (SYMMETRIC_TYPES.has(r.type)) throw new InvalidEdit(`Relation ${r.id} has no direction`)
  return { ...r, from: r.to, to: r.from, status: 'confirmed', edited: true, updated_at: now }
}

/** The user's own justification; the status is kept (editing is not reviewing). */
export function withJustification(r: TypedRelation, text: string, now: string): TypedRelation {
  const justification = text.trim()
  if (!justification || justification.length > MAX_JUSTIFICATION) throw new InvalidEdit('Invalid justification')
  return { ...r, justification, edited: true, updated_at: now }
}

export function applyChange(list: TypedRelation[], change: RelationChange): TypedRelation[] {
  const without = list.filter((r) => r.id !== change.before.id)
  if (without.length === list.length) throw new InvalidEdit(`Unknown relation ${change.before.id}`)
  if (without.some((r) => r.id === change.after.id)) throw new InvalidEdit(`Relation ${change.after.id} already exists`)
  return sortRelations([...without, change.after])
}

/** Same instant, whatever its spelling (a hand-edited or re-serialized timestamp still matches). */
const sameInstant = (a: string, b: string): boolean => a === b || Date.parse(a) === Date.parse(b)

/** Key-order independent, `undefined` keys ignored (as after a YAML round trip). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v
  )
}

/** The same entry: every field equal, the timestamp compared as an instant. */
function sameEntry(a: TypedRelation, b: TypedRelation): boolean {
  return sameInstant(a.updated_at, b.updated_at) && canonical({ ...a, updated_at: '' }) === canonical({ ...b, updated_at: '' })
}

/** Puts `before` back (stamped now) only if the entry is still exactly what the change left. */
export function revertChange(list: TypedRelation[], change: RelationChange, now: string): TypedRelation[] {
  const current = list.find((r) => r.id === change.after.id)
  if (!current || !sameEntry(current, change.after)) {
    throw new InvalidEdit(`Relation ${change.after.id} changed since`)
  }
  const without = list.filter((r) => r.id !== change.after.id)
  if (without.some((r) => r.id === change.before.id)) throw new InvalidEdit(`Relation ${change.before.id} already exists`)
  return sortRelations([...without, { ...change.before, updated_at: now }])
}

export function viewsFor(
  list: TypedRelation[],
  paperId: string,
  papers: ReadonlyMap<string, { title: string; year: number | null }>
): Pick<PaperRelations, 'suggested' | 'confirmed' | 'rejected'> {
  const views: RelationView[] = list
    .filter((r) => r.from === paperId || r.to === paperId)
    .map((r) => {
      const other = otherEnd(r, paperId)
      const p = papers.get(other)
      return { ...r, other: { id: other, title: p?.title ?? other, year: p?.year ?? null } }
    })
  return {
    suggested: views.filter((r) => r.status === 'suggested'),
    confirmed: views.filter((r) => r.status === 'confirmed'),
    rejected: views.filter((r) => r.status === 'rejected')
  }
}

/** Each suggestion once, under whichever of its two papers comes first in `rows`. */
export function relationReviewItems(list: TypedRelation[], rows: { id: string; title: string }[]): ReviewItem[] {
  const position = new Map<string, number>()
  // A paper listed twice counts where it first appears.
  rows.forEach((r, i) => {
    if (!position.has(r.id)) position.set(r.id, i)
  })
  return list.flatMap((r) => {
    if (r.status !== 'suggested') return []
    const at = [r.from, r.to].filter((id) => position.has(id)).sort((a, b) => position.get(a)! - position.get(b)!)[0]
    return at ? [{ paperId: at, title: rows[position.get(at)!].title, section: 'relation' as const, key: r.id }] : []
  })
}

/** Paper by paper in `order`: the paper's summary items, then its relation items. */
export function interleaveReview(order: string[], summary: ReviewItem[], relation: ReviewItem[]): ReviewItem[] {
  const byPaper = (items: ReviewItem[]): Map<string, ReviewItem[]> => {
    const m = new Map<string, ReviewItem[]>()
    for (const it of items) m.set(it.paperId, [...(m.get(it.paperId) ?? []), it])
    return m
  }
  const s = byPaper(summary)
  const r = byPaper(relation)
  return [...new Set(order)].flatMap((id) => [...(s.get(id) ?? []), ...(r.get(id) ?? [])])
}

export function typedEdges(list: TypedRelation[]): TypedEdge[] {
  return list.flatMap((r) =>
    r.status === 'rejected' ? [] : [{ id: r.id, source: r.from, target: r.to, type: r.type, status: r.status, directed: !SYMMETRIC_TYPES.has(r.type) }]
  )
}

/** Relations with neither end among `ids` (deleting papers for good). */
export function withoutPapers(list: TypedRelation[], ids: ReadonlySet<string>): TypedRelation[] {
  return list.filter((r) => !ids.has(r.from) && !ids.has(r.to))
}

const reviewed = (r: TypedRelation): boolean => r.status !== 'suggested' || r.edited

/**
 * A trashed paper `from` merged into the library paper `to`: each of its relations is moved onto `to` (re-oriented,
 * re-keyed, evidence and origin renamed), a relation of `to` with itself is dropped, and on an id both already have the
 * reviewed one wins, otherwise the one that was there.
 */
export function rekeyRelations(list: TypedRelation[], from: string, to: string, now: string): TypedRelation[] {
  const byId = new Map<string, TypedRelation>()
  const moving: TypedRelation[] = []
  for (const r of list) {
    if (r.from === from || r.to === from) moving.push(r)
    else byId.set(r.id, r)
  }
  for (const r of moving) {
    const a = r.from === from ? to : r.from
    const b = r.to === from ? to : r.to
    if (a === b) continue
    const ends = orient(a, b, r.type)
    const next: TypedRelation = {
      ...r,
      ...ends,
      id: relationId(ends.from, ends.to, r.type),
      evidence: r.evidence.map((e) => (e.paper === from ? { ...e, paper: to } : e)),
      ...(r.origin?.paper === from ? { origin: { ...r.origin, paper: to } } : {}),
      updated_at: now
    }
    const current = byId.get(next.id)
    if (!current || (reviewed(next) && !reviewed(current))) byId.set(next.id, next)
  }
  return sortRelations([...byId.values()])
}
