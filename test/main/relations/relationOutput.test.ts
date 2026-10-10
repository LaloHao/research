import { describe, expect, it } from 'vitest'
import { checkRelationEvidence, parseRelationOutput } from '../../../src/main/relations/relationOutput'
import { relationId, type RelationType, type TypedRelation } from '../../../src/shared/typedRelations'

const LOGHUB = 'zhu2020loghub'
const DRAIN = 'he2017drain'
const ctx = (existing: TypedRelation[] = []) => ({ paperId: LOGHUB, candidates: new Set([DRAIN, 'am2019x']), existing })
const item = (over: Record<string, unknown> = {}) => ({
  from: LOGHUB,
  to: DRAIN,
  type: 'extends',
  justification: ' Builds on Drain. ',
  evidence: [
    { paper: LOGHUB, page: 2, quote: ' we extend Drain ' },
    { paper: DRAIN, page: 1, quote: 'Drain parses' }
  ],
  ...over
})
const stored = (type: RelationType, over: Partial<TypedRelation> = {}): TypedRelation => ({
  id: relationId(LOGHUB, DRAIN, type),
  type,
  from: LOGHUB,
  to: DRAIN,
  status: 'suggested',
  edited: false,
  justification: 'j',
  evidence: [],
  updated_at: 't',
  ...over
})

describe('parseRelationOutput', () => {
  it('accepts relations between the paper and its candidates, trimmed, with symmetric types in alphabetical order', () => {
    const out = parseRelationOutput(
      { relations: [item(), item({ type: 'same_problem', to: 'am2019x', evidence: [{ paper: 'am2019x', page: null, quote: 'same task' }] })] },
      ctx()
    )
    expect(out).toEqual({
      ok: true,
      dropped: [],
      suggestions: [
        {
          id: 'he2017drain__zhu2020loghub__extends',
          type: 'extends',
          from: LOGHUB,
          to: DRAIN,
          justification: 'Builds on Drain.',
          evidence: [
            { paper: LOGHUB, page: 2, quote: 'we extend Drain' },
            { paper: DRAIN, page: 1, quote: 'Drain parses' }
          ]
        },
        {
          id: 'am2019x__zhu2020loghub__same_problem',
          type: 'same_problem',
          from: 'am2019x',
          to: LOGHUB,
          justification: 'Builds on Drain.',
          evidence: [{ paper: 'am2019x', page: null, quote: 'same task' }]
        }
      ]
    })
  })

  it('drops rejected, retyped, outside, duplicated, unevidenced and malformed relations, saying why', () => {
    const existing = [stored('extends', { status: 'rejected' }), stored('uses_method_of', { status: 'confirmed', edited: true, replaced: [relationId(LOGHUB, DRAIN, 'compares_with'), relationId(LOGHUB, DRAIN, 'contradicts')] })]
    const out = parseRelationOutput(
      {
        relations: [
          item(),
          item({ type: 'contradicts' }),
          item({ to: 'zz2021other' }),
          item({ from: DRAIN, to: 'am2019x' }),
          item({ type: 'replicates' }),
          item({ type: 'replicates' }),
          item({ type: 'uses_method_of', evidence: [{ paper: 'am2019x', page: 1, quote: 'x' }] }),
          { from: LOGHUB },
          item({ type: 'cites' })
        ]
      },
      ctx(existing)
    )
    expect(out.ok && out.dropped).toEqual(['rejected', 'retyped', 'not_a_candidate', 'not_a_candidate', 'duplicate', 'no_evidence', 'invalid', 'invalid'])
    expect(out.ok && out.suggestions.map((s) => s.type)).toEqual(['replicates'])
  })

  it('keeps at most four quotes per relation', () => {
    const evidence = Array.from({ length: 6 }, (_, i) => ({ paper: LOGHUB, page: 1, quote: `quote ${i}` }))
    const out = parseRelationOutput({ relations: [item({ evidence })] }, ctx())
    expect(out.ok && out.suggestions[0].evidence).toHaveLength(4)
  })

  it('rejects an answer without a relations list', () => {
    expect(parseRelationOutput({}, ctx())).toEqual({ ok: false })
    expect(parseRelationOutput(null, ctx())).toEqual({ ok: false })
    expect(parseRelationOutput({ relations: 'none' }, ctx())).toEqual({ ok: false })
  })

  it('coerces a stray non-positive page to null instead of dropping the whole relation', () => {
    const out = parseRelationOutput({ relations: [item({ evidence: [{ paper: LOGHUB, page: 0, quote: 'we extend Drain' }] })] }, ctx())
    expect(out).toEqual({ ok: true, dropped: [], suggestions: [expect.objectContaining({ evidence: [{ paper: LOGHUB, page: null, quote: 'we extend Drain' }] })] })
  })

  it('drops a relation with an empty justification as invalid', () => {
    const out = parseRelationOutput({ relations: [item({ justification: '   ' })] }, ctx())
    expect(out).toEqual({ ok: true, dropped: ['invalid'], suggestions: [] })
  })

  it('caps accepted relations at MAX_SUGGESTIONS, reporting the extras as too_many', () => {
    const relations = Array.from({ length: 22 }, () => item())
    const out = parseRelationOutput({ relations }, ctx())
    expect(out.ok && out.suggestions).toHaveLength(1)
    expect(out.ok && out.dropped.filter((d) => d === 'too_many')).toHaveLength(2)
    expect(out.ok && out.dropped.filter((d) => d === 'duplicate')).toHaveLength(19)
    expect(out.ok && out.dropped).toHaveLength(21)
  })
})

describe('checkRelationEvidence', () => {
  it('looks each quote up in its own paper, fixing the page or marking it not found', () => {
    const pages = new Map([
      [LOGHUB, [{ page: 1, text: 'Loghub is a collection.' }, { page: 2, text: 'We evaluate and extend Drain.' }]],
      [DRAIN, [{ page: 1, text: 'Drain parses logs.' }]]
    ])
    expect(
      checkRelationEvidence(
        [
          { paper: LOGHUB, page: 1, quote: 'We evaluate and extend Drain.' },
          { paper: DRAIN, page: 1, quote: 'an invented sentence about prefix trees' }
        ],
        (id) => pages.get(id) ?? []
      )
    ).toEqual([
      { paper: LOGHUB, page: 2, quote: 'We evaluate and extend Drain.', found: true },
      { paper: DRAIN, page: 1, quote: 'an invented sentence about prefix trees', found: false }
    ])
  })
})
