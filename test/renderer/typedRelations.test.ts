import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { availableTypes, firstEvidence, isDirected, relationSentence, splitEvidence, TYPE_COLORS } from '../../src/renderer/lib/typedRelations'
import { RELATION_TYPES } from '../../src/shared/typedRelations'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction
const evidence = [
  { paper: 'a1', page: null, quote: 'web quote', found: true },
  { paper: 'b1', page: 3, quote: 'missing', found: false },
  { paper: 'a1', page: 4, quote: 'found on page', found: true },
  { paper: 'b1', page: 2, quote: 'other found', found: true }
]

describe('typed relation helpers', () => {
  it('builds the sentence with both titles', () => {
    expect(relationSentence(t, { type: 'extends', from: 'a1', to: 'b1' }, (id) => id.toUpperCase())).toBe('typed.sentence.extends {"from":"A1","to":"B1"}')
  })

  it('splits the quotes of this paper from those of the other one', () => {
    const { own, other } = splitEvidence(evidence, 'a1')
    expect(own.map((e) => e.quote)).toEqual(['web quote', 'found on page'])
    expect(other.map((e) => e.quote)).toEqual(['missing', 'other found'])
  })

  it('picks the quote to show first: found and with a page, then found, then any', () => {
    expect(firstEvidence(evidence, 'a1')).toEqual({ page: 4, quote: 'found on page' })
    expect(firstEvidence(evidence, 'b1')).toEqual({ page: 2, quote: 'other found' })
    expect(firstEvidence([{ paper: 'c1', page: 1, quote: 'q', found: false }], 'c1')).toEqual({ page: 1, quote: 'q' })
    expect(firstEvidence(evidence, 'zz9')).toBeNull()
  })

  it('offers only the types the pair does not have yet, whatever the direction', () => {
    const r = { type: 'extends' as const, from: 'a1', to: 'b1' }
    const all = [r, { type: 'same_problem' as const, from: 'a1', to: 'b1' }, { type: 'replicates' as const, from: 'b1', to: 'a1' }, { type: 'contradicts' as const, from: 'a1', to: 'c1' }]
    expect(availableTypes(r, all)).toEqual(['uses_method_of', 'compares_with', 'contradicts'])
  })

  it('knows which types have a direction', () => {
    expect(isDirected('extends')).toBe(true)
    expect(isDirected('same_problem')).toBe(false)
  })

  it('has one distinct color per type', () => {
    expect(new Set(RELATION_TYPES.map((type) => TYPE_COLORS[type])).size).toBe(RELATION_TYPES.length)
  })
})
