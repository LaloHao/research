import { describe, expect, it } from 'vitest'
import {
  criterionFits,
  criterionText,
  DecisionSchema,
  MappingRecordSchema,
  ProtocolBodySchema,
  ProtocolDraftSchema,
  ProtocolFileSchema,
  SearchesFileSchema,
  SearchSchema
} from '../../src/shared/mapping'
import type { MappingRecord, ProtocolBody, Search } from '../../src/shared/mapping'
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

  it('keep keys a later version adds inside nested objects, through parse and serialize', () => {
    const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(schema.parse(value))))
    const body = { ...protocolBody(), classification: { facets: [] } } as ProtocolBody & Record<string, unknown>
    body.inclusion = [{ id: 'I1', text: 'Processes logs.', rq: ['RQ1'] } as ProtocolBody['inclusion'][number]]
    body.research_questions = [{ id: 'RQ1', text: 'Which?', facet: 'technique' } as ProtocolBody['research_questions'][number]]
    body.years = { from: 2015, to: null, note: 'x' } as ProtocolBody['years']
    const file = {
      ...protocolFile(),
      protocol: body,
      last_ids: { rq: 1, inclusion: 1, exclusion: 2, quality: 4 },
      history: [{ version: 1, replaced_at: AT, protocol: protocolBody(), by: 'machine-a' }]
    }
    const p = roundTrip(ProtocolFileSchema, file) as unknown as Record<string, any>
    expect(p.protocol.classification).toEqual({ facets: [] })
    expect(p.protocol.inclusion[0].rq).toEqual(['RQ1'])
    expect(p.protocol.research_questions[0].facet).toBe('technique')
    expect(p.protocol.years.note).toBe('x')
    expect(p.last_ids.quality).toBe(4)
    expect(p.history[0].by).toBe('machine-a')

    const r = roundTrip(
      MappingRecordSchema,
      record({ identifiers: { doi: '10.1/x', pmid: '123' } as MappingRecord['identifiers'], duplicate_of: { record: hexId('r', 2), reason: 'same_title', score: 0.9 } as MappingRecord['duplicate_of'] })
    ) as unknown as Record<string, any>
    expect(r.identifiers.pmid).toBe('123')
    expect(r.duplicate_of.score).toBe(0.9)

    const s = roundTrip(
      SearchSchema,
      search({
        kind: 'snowball',
        origin: { direction: 'both', from: [hexId('r', 1)], iteration: 1, depth: 2 } as Search['origin'],
        discarded: { at: AT, reason: 'Wrong string.', machine: 'machine-a', by: 'main' } as Search['discarded']
      })
    ) as unknown as Record<string, any>
    expect(s.origin.depth).toBe(2)
    expect(s.discarded.by).toBe('main')
  })

  it('keep the protocol draft strict', () => {
    const draft = { title: 'T', objective: '', research_questions: [], inclusion: [], exclusion: [], years: { from: null, to: null }, publication_types: [] }
    expect(ProtocolDraftSchema.parse({ ...draft, extra: 1 })).not.toHaveProperty('extra')
    expect(ProtocolDraftSchema.parse({ ...draft, inclusion: [{ id: null, text: 'x', extra: 1 }] }).inclusion[0]).not.toHaveProperty('extra')
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

  it('reads a criterion as worded in the protocol version a decision was made with', () => {
    const file = protocolFile(
      {
        version: 3,
        history: [
          { version: 1, replaced_at: AT, protocol: protocolBody({ exclusion: [{ id: 'E3', text: 'Not in English.' }] }) },
          { version: 2, replaced_at: AT, protocol: protocolBody({ exclusion: [{ id: 'E3', text: 'Before 2015.' }] }) }
        ]
      },
      { exclusion: [{ id: 'E3', text: 'Published before 2015.' }] }
    )
    expect(criterionText(file, 'E3', 1)).toBe('Not in English.')
    expect(criterionText(file, 'E3', 2)).toBe('Before 2015.')
    expect(criterionText(file, 'E3', 3)).toBe('Published before 2015.')
    expect(criterionText(file, 'E3')).toBe('Published before 2015.')
    // A version that no longer names it (or is unknown) falls back to the current wording, then the latest earlier one.
    expect(criterionText(file, 'E3', 9)).toBe('Published before 2015.')
    const removed = protocolFile({ version: 2, history: [{ version: 1, replaced_at: AT, protocol: protocolBody({ exclusion: [{ id: 'E5', text: 'Gone.' }] }) }] })
    expect(criterionText(removed, 'E5', 2)).toBe('Gone.')
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
