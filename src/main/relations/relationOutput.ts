import { z } from 'zod'
import { orient, RELATION_TYPES, relationId, type RelationEvidence, type RelationType, type TypedRelation } from '../../shared/typedRelations'
import { locateQuote } from '../summary/evidence'
import type { PageText } from '../summary/paperText'
import { MAX_EVIDENCE } from './relationPrompt'

const ItemSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(RELATION_TYPES),
  justification: z.string().trim().min(1),
  evidence: z.array(z.object({ paper: z.string(), page: z.number().int().positive().nullable(), quote: z.string().trim().min(1) }))
})
const OutputSchema = z.object({ relations: z.array(z.unknown()) })

export type DropReason = 'invalid' | 'not_a_candidate' | 'rejected' | 'retyped' | 'duplicate' | 'no_evidence'

export interface ParsedSuggestion {
  id: string
  type: RelationType
  from: string
  to: string
  justification: string
  evidence: { paper: string; page: number | null; quote: string }[]
}

export type ParsedOutput = { ok: true; suggestions: ParsedSuggestion[]; dropped: DropReason[] } | { ok: false }

/** Item by item: a bad item is dropped (with its reason); only a missing relations list makes the whole answer invalid. */
export function parseRelationOutput(value: unknown, ctx: { paperId: string; candidates: ReadonlySet<string>; existing: TypedRelation[] }): ParsedOutput {
  const top = OutputSchema.safeParse(value)
  if (!top.success) return { ok: false }
  const rejected = new Set(ctx.existing.filter((r) => r.status === 'rejected').map((r) => r.id))
  const retyped = new Set(ctx.existing.flatMap((r) => r.replaced ?? []))
  const seen = new Set<string>()
  const suggestions: ParsedSuggestion[] = []
  const dropped: DropReason[] = []
  for (const raw of top.data.relations) {
    const item = ItemSchema.safeParse(raw)
    if (!item.success) {
      dropped.push('invalid')
      continue
    }
    const { from, to, type } = item.data
    const other = from === ctx.paperId ? to : to === ctx.paperId ? from : null
    if (other === null || other === ctx.paperId || !ctx.candidates.has(other)) {
      dropped.push('not_a_candidate')
      continue
    }
    const ends = orient(from, to, type)
    const id = relationId(ends.from, ends.to, type)
    if (rejected.has(id)) {
      dropped.push('rejected')
      continue
    }
    if (retyped.has(id)) {
      dropped.push('retyped')
      continue
    }
    if (seen.has(id)) {
      dropped.push('duplicate')
      continue
    }
    const evidence = item.data.evidence.filter((e) => e.paper === ends.from || e.paper === ends.to).slice(0, MAX_EVIDENCE)
    if (evidence.length === 0) {
      dropped.push('no_evidence')
      continue
    }
    seen.add(id)
    suggestions.push({ id, type, ...ends, justification: item.data.justification, evidence: evidence.map((e) => ({ paper: e.paper, page: e.page, quote: e.quote })) })
  }
  return { ok: true, suggestions, dropped }
}

/** Like the summaries: each quote is looked up in its own paper's indexed text; `found` false when it is not there. */
export function checkRelationEvidence(evidence: ParsedSuggestion['evidence'], pagesOf: (paperId: string) => PageText[]): RelationEvidence[] {
  return evidence.map((e) => {
    const r = locateQuote(e.quote, pagesOf(e.paper), e.page)
    return { paper: e.paper, page: r.page, quote: e.quote, found: r.found }
  })
}
