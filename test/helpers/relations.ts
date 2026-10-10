import type { CompleteResult } from '../../src/main/llm/LlmProvider'
import { relationId, type TypedRelation } from '../../src/shared/typedRelations'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES } from './pair'

export const NOW = '2026-10-10T12:00:00.000Z'

/** Loghub extends Drain, suggested; `id` follows from/to/type unless given. */
export function typedRelation(over: Partial<TypedRelation> = {}): TypedRelation {
  const type = over.type ?? 'extends'
  const from = over.from ?? LOGHUB_ID
  const to = over.to ?? DRAIN_ID
  return {
    type,
    from,
    to,
    status: 'suggested',
    edited: false,
    justification: 'Loghub builds on the Drain parser.',
    evidence: [{ paper: from, page: 2, quote: 'q', found: true }],
    origin: { model: 'claude-sonnet-5', at: '2026-10-10T00:00:00.000Z', prompt_version: 1, paper: from },
    updated_at: '2026-10-10T00:00:00.000Z',
    ...over,
    id: over.id ?? relationId(from, to, type)
  }
}

/** One relation as the agent answers it, quoting the pages of pair.ts verbatim. */
export const LOGHUB_EXTENDS_DRAIN = {
  from: LOGHUB_ID,
  to: DRAIN_ID,
  type: 'extends',
  justification: 'Loghub extends the Drain parser.',
  evidence: [
    { paper: LOGHUB_ID, page: 2, quote: LOGHUB_PAGES[1] },
    { paper: DRAIN_ID, page: 1, quote: DRAIN_PAGES[0] }
  ]
}

export function agentResult(relations: unknown[] = [LOGHUB_EXTENDS_DRAIN], costUsd = 0.12): CompleteResult {
  return { value: { relations }, costUsd, model: 'claude-sonnet-5' }
}
