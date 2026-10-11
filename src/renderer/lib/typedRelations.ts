import type { TFunction } from 'i18next'
import { RELATION_TYPES, SYMMETRIC_TYPES, type RelationEvidence, type RelationType, type TypedRelation } from '../../shared/typedRelations'

/** How long the "Deshacer" notice stays after a review decision. */
export const UNDO_MS = 6000

/** One color per relation type (Tableau 10), used by the type chips and the graph. */
export const TYPE_COLORS: Record<RelationType, string> = {
  extends: '#4e79a7',
  uses_method_of: '#59a14f',
  compares_with: '#f28e2b',
  contradicts: '#e15759',
  replicates: '#b07aa1',
  same_problem: '#9c755f'
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Text color for a chip on `background` (`#rrggbb`): dark or white, whichever contrasts more; the chip looks the same in both themes. */
export function chipTextColor(background: string): string {
  return contrastRatio(background, '#111111') >= contrastRatio(background, '#ffffff') ? '#111111' : '#ffffff'
}

/** "Loghub extiende a Drain"; symmetric types read without direction ("Drain y Loghub abordan el mismo problema"). */
export function relationSentence(t: TFunction, r: Pick<TypedRelation, 'type' | 'from' | 'to'>, titleOf: (id: string) => string): string {
  return t(`typed.sentence.${r.type}`, { from: titleOf(r.from), to: titleOf(r.to) })
}

/** Quotes from this paper (they open its PDF) and from the paper at the other end. */
export function splitEvidence(evidence: RelationEvidence[], paperId: string): { own: RelationEvidence[]; other: RelationEvidence[] } {
  return { own: evidence.filter((e) => e.paper === paperId), other: evidence.filter((e) => e.paper !== paperId) }
}

/** The quote of `paperId` to show first: a found one with a page, else a found one, else any. */
export function firstEvidence(evidence: RelationEvidence[], paperId: string): { page: number | null; quote: string } | null {
  const own = evidence.filter((e) => e.paper === paperId)
  const best = own.find((e) => e.found && e.page !== null) ?? own.find((e) => e.found) ?? own[0]
  return best ? { page: best.page, quote: best.quote } : null
}

const samePair = (a: Pick<TypedRelation, 'from' | 'to'>, b: Pick<TypedRelation, 'from' | 'to'>): boolean =>
  (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from)

/** Types a relation can change to: not its own, and none the pair already has (the id is the pair plus the type). */
export function availableTypes(r: Pick<TypedRelation, 'type' | 'from' | 'to'>, all: Pick<TypedRelation, 'type' | 'from' | 'to'>[]): RelationType[] {
  const taken = new Set(all.filter((o) => samePair(o, r)).map((o) => o.type))
  return RELATION_TYPES.filter((type) => type !== r.type && !taken.has(type))
}

export function isDirected(type: RelationType): boolean {
  return !SYMMETRIC_TYPES.has(type)
}
