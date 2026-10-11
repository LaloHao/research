import { describe, expect, it } from 'vitest'
import { orient, otherEnd, relationId, RelationsFileSchema, TypedRelationSchema } from '../../src/shared/typedRelations'

const entry = {
  id: 'he2017drain__zhu2020loghub__extends',
  type: 'extends',
  from: 'zhu2020loghub',
  to: 'he2017drain',
  status: 'suggested',
  justification: 'Loghub extends the Drain parser.',
  evidence: [{ paper: 'zhu2020loghub', page: 4, quote: 'we extend Drain', found: true }],
  origin: { model: 'claude-sonnet-5', at: '2026-10-10T00:00:00.000Z', prompt_version: 1 },
  updated_at: '2026-10-10T00:00:00.000Z'
}

describe('relation ids', () => {
  it('orders the pair alphabetically and appends the type', () => {
    expect(relationId('zhu2020loghub', 'he2017drain', 'extends')).toBe('he2017drain__zhu2020loghub__extends')
    expect(relationId('he2017drain', 'zhu2020loghub', 'extends')).toBe('he2017drain__zhu2020loghub__extends')
  })

  it('stores symmetric types alphabetically and keeps the direction of the others', () => {
    expect(orient('zhu2020loghub', 'he2017drain', 'same_problem')).toEqual({ from: 'he2017drain', to: 'zhu2020loghub' })
    expect(orient('zhu2020loghub', 'he2017drain', 'compares_with')).toEqual({ from: 'he2017drain', to: 'zhu2020loghub' })
    expect(orient('zhu2020loghub', 'he2017drain', 'extends')).toEqual({ from: 'zhu2020loghub', to: 'he2017drain' })
  })

  it('names the other end of a relation', () => {
    expect(otherEnd({ from: 'a1', to: 'b1' }, 'a1')).toBe('b1')
    expect(otherEnd({ from: 'a1', to: 'b1' }, 'b1')).toBe('a1')
  })
})

describe('RelationsFileSchema', () => {
  it('reads a file and fills defaults', () => {
    const file = RelationsFileSchema.parse({ schema_version: 1, relations: [entry] })
    expect(file.relations[0]).toMatchObject({ edited: false, status: 'suggested', type: 'extends' })
    expect(RelationsFileSchema.parse({ schema_version: 1 }).relations).toEqual([])
  })

  it('rejects an id that does not match its pair and type, and unknown types or statuses', () => {
    expect(TypedRelationSchema.safeParse({ ...entry, id: 'he2017drain__zhu2020loghub__replicates' }).success).toBe(false)
    expect(TypedRelationSchema.safeParse({ ...entry, type: 'cites', id: 'he2017drain__zhu2020loghub__cites' }).success).toBe(false)
    expect(TypedRelationSchema.safeParse({ ...entry, status: 'maybe' }).success).toBe(false)
  })

  it('keeps every id an entry had before the user changed its type, the analyzing paper and unknown keys', () => {
    const retyped = { ...entry, id: 'he2017drain__zhu2020loghub__uses_method_of', type: 'uses_method_of', replaced: [entry.id], edited: true, note: 'kept' }
    const parsed = TypedRelationSchema.parse({ ...retyped, origin: { ...entry.origin, paper: 'zhu2020loghub' } })
    expect(parsed).toMatchObject({ replaced: [entry.id], note: 'kept', origin: { paper: 'zhu2020loghub' } })
  })

  it('reads which candidates each paper was analyzed with, defaulting to none', () => {
    expect(RelationsFileSchema.parse({ schema_version: 1 }).analyzed).toEqual({})
    const analyzed = { zhu2020loghub: { candidates: ['he2017drain'], at: '2026-10-10T00:00:00.000Z' } }
    expect(RelationsFileSchema.parse({ schema_version: 1, analyzed }).analyzed).toEqual(analyzed)
    expect(RelationsFileSchema.safeParse({ schema_version: 1, analyzed: { zhu2020loghub: { candidates: 'x' } } }).success).toBe(false)
  })
})
