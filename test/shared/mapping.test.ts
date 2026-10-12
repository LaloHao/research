import { describe, expect, it } from 'vitest'
import {
  criterionFits,
  criterionText,
  DecisionSchema,
  MappingRecordSchema,
  ProtocolBodySchema,
  ProtocolFileSchema,
  SearchesFileSchema,
  SearchSchema
} from '../../src/shared/mapping'
import { AT, decision, hexId, protocolBody, protocolFile, record, search } from '../helpers/mappings'

describe('mapping files', () => {
  it('fill their defaults and keep keys a later version adds', () => {
    expect(SearchesFileSchema.parse({ schema_version: 1 })).toEqual({ schema_version: 1, searches: [] })
    expect(MappingRecordSchema.parse({ id: hexId('r', 1), title: 'T', sources: [hexId('s', 1)], added_at: AT, updated_at: AT, later: 1 })).toEqual({
      id: hexId('r', 1),
      title: 'T',
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      kind: null,
      identifiers: {},
      sources: [hexId('s', 1)],
      paper_id: null,
      duplicate_of: null,
      merged_into: null,
      distinct_from: [],
      added_at: AT,
      updated_at: AT,
      later: 1
    })
    const { reviewer: _r, note: _n, replaces: _p, undoes: _u, ...bare } = decision()
    expect(DecisionSchema.parse(bare)).toMatchObject({ reviewer: 'main', note: null, replaces: [], undoes: null })
    expect(SearchSchema.parse({ id: hexId('s', 2), kind: 'openalex', at: AT, database: 'OpenAlex', count: 3 })).toMatchObject({ query: null, filters: {}, discarded: null, origin: null, capped: false })
  })

  it('refuse ids of the wrong shape, a record without a source and an unknown decision', () => {
    expect(MappingRecordSchema.safeParse(record({ id: 'r1' })).success).toBe(false)
    expect(MappingRecordSchema.safeParse(record({ sources: [] })).success).toBe(false)
    expect(SearchSchema.safeParse(search({ id: hexId('d', 1) })).success).toBe(false)
    expect(DecisionSchema.safeParse({ ...decision(), decision: 'maybe' }).success).toBe(false)
    expect(DecisionSchema.safeParse(decision({ criterion: 'X1' })).success).toBe(false)
  })

  it('keep inclusion ids as I and exclusion ids as E, each once, with the years in order', () => {
    expect(ProtocolBodySchema.safeParse(protocolBody()).success).toBe(true)
    expect(ProtocolBodySchema.safeParse(protocolBody({ inclusion: [{ id: 'E3', text: 'x' }] })).success).toBe(false)
    expect(ProtocolBodySchema.safeParse(protocolBody({ exclusion: [{ id: 'E1', text: 'a' }, { id: 'E1', text: 'b' }] })).success).toBe(false)
    expect(ProtocolBodySchema.safeParse(protocolBody({ years: { from: 2020, to: 2010 } })).success).toBe(false)
    expect(ProtocolFileSchema.parse(protocolFile()).phases).toEqual(['title_abstract', 'full_text'])
  })
})

describe('criteria', () => {
  it('finds a criterion in the current protocol, or in the latest earlier version that had it', () => {
    const file = protocolFile(
      {
        version: 3,
        history: [
          { version: 1, replaced_at: AT, protocol: protocolBody({ exclusion: [{ id: 'E3', text: 'Old wording.' }] }) },
          { version: 2, replaced_at: AT, protocol: protocolBody({ exclusion: [{ id: 'E3', text: 'Newer wording.' }] }) }
        ]
      },
      { exclusion: [{ id: 'E1', text: 'Not about software logs.' }] }
    )
    expect(criterionText(file, 'E1')).toBe('Not about software logs.')
    expect(criterionText(file, 'E3')).toBe('Newer wording.')
    expect(criterionText(file, 'E9')).toBeNull()
  })

  it('fits an exclusion criterion to exclude, an inclusion one or none to include, and none otherwise', () => {
    const p = protocolFile()
    expect(criterionFits(p, 'exclude', 'E2')).toBe(true)
    expect(criterionFits(p, 'exclude', null)).toBe(false)
    expect(criterionFits(p, 'exclude', 'I1')).toBe(false)
    expect(criterionFits(p, 'include', 'I1')).toBe(true)
    expect(criterionFits(p, 'include', null)).toBe(true)
    expect(criterionFits(p, 'include', 'I7')).toBe(false)
    expect(criterionFits(p, 'uncertain', null)).toBe(true)
    expect(criterionFits(p, 'not_retrieved', 'E1')).toBe(false)
  })
})
