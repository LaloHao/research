import { describe, expect, it } from 'vitest'
import { citationsState, scorePercent } from '../../src/renderer/lib/relationsView'

describe('relations view', () => {
  it('derives the citation state from the paper.yaml block', () => {
    expect(citationsState(null)).toBe('none')
    expect(citationsState({ source: 'openalex', fetched_at: 't', references: [], unresolved: true })).toBe('unresolved')
    expect(citationsState({ source: 'openalex', fetched_at: 't', references: ['W1'] })).toBe('ok')
  })

  it('shows similarity scores as percentages', () => {
    expect(scorePercent(0.4167)).toBe('42 %')
  })
})
