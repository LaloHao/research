import { describe, expect, it } from 'vitest'
import { rekeyRelations, withoutPapers } from '../../../src/main/relations/relationMerge'
import { relationId, type RelationType, type TypedRelation } from '../../../src/shared/typedRelations'

function rel(from: string, to: string, type: RelationType = 'extends', over: Partial<TypedRelation> = {}): TypedRelation {
  return {
    id: relationId(from, to, type),
    type,
    from,
    to,
    status: 'suggested',
    edited: false,
    justification: 'j',
    evidence: [{ paper: from, page: 1, quote: 'q', found: true }],
    updated_at: '2026-10-10T00:00:00.000Z',
    ...over
  }
}
const NOW = '2026-10-11T12:00:00.000Z'

describe('withoutPapers', () => {
  it('drops every relation with an end among the given papers', () => {
    const keep = rel('am2019x', 'zz2020y')
    expect(withoutPapers([rel('zhu2020loghub', 'he2017drain'), keep, rel('he2017drain', 'am2019x')], new Set(['he2017drain']))).toEqual([keep])
  })
})

describe('rekeyRelations', () => {
  it('moves the relations of a merged paper onto the library paper, with its evidence renamed', () => {
    const out = rekeyRelations([rel('he2017drain', 'am2019x')], 'he2017drain', 'he2017draina', NOW)
    expect(out).toEqual([{ ...rel('he2017draina', 'am2019x'), updated_at: NOW }])
  })

  it('re-orients symmetric types and drops a relation of the paper with itself', () => {
    const flipped = rekeyRelations([rel('he2017drain', 'hz2019x', 'same_problem')], 'he2017drain', 'xa2017drain', NOW)
    expect(flipped.map((r) => [r.id, r.from, r.to])).toEqual([[relationId('hz2019x', 'xa2017drain', 'same_problem'), 'hz2019x', 'xa2017drain']])
    expect(rekeyRelations([rel('he2017drain', 'he2017draina')], 'he2017drain', 'he2017draina', NOW)).toEqual([])
  })

  it('on an id both papers have, keeps the reviewed one, else the library one', () => {
    const library = rel('zhu2020loghub', 'he2017draina')
    const trashedConfirmed = rel('zhu2020loghub', 'he2017drain', 'extends', { status: 'confirmed' })
    expect(rekeyRelations([library, trashedConfirmed], 'he2017drain', 'he2017draina', NOW)).toEqual([
      { ...rel('zhu2020loghub', 'he2017draina', 'extends', { status: 'confirmed' }), updated_at: NOW }
    ])
    const libraryConfirmed = rel('zhu2020loghub', 'he2017draina', 'extends', { status: 'confirmed' })
    expect(rekeyRelations([libraryConfirmed, rel('zhu2020loghub', 'he2017drain')], 'he2017drain', 'he2017draina', NOW)).toEqual([libraryConfirmed])
  })
})
