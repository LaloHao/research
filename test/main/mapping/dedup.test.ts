import { describe, expect, it } from 'vitest'
import {
  cleanIdentifiers,
  identifierCollisions,
  mergeCandidate,
  newRecord,
  RecordMatcher,
  recordIdFor,
  recordKey,
  titleSimilarity
} from '../../../src/main/mapping/dedup'
import { AT, candidate, hexId, record } from '../../helpers/mappings'

const LATER = '2026-10-12T11:00:00.000Z'

describe('record identity', () => {
  it('cleans identifiers: lowercase DOIs from URLs, arXiv ids from arXiv DOIs, bare OpenAlex ids', () => {
    expect(cleanIdentifiers({ doi: 'https://doi.org/10.48550/arXiv.2008.06448', openalex: 'https://openalex.org/W123' })).toEqual({
      doi: '10.48550/arxiv.2008.06448',
      arxiv: '2008.06448',
      openalex: 'W123'
    })
    expect(cleanIdentifiers({})).toEqual({})
    expect(cleanIdentifiers({ doi: '  ', arxiv: 'not an id', openalex: '' })).toEqual({})
  })

  it('keys a record by its best identifier, else by its title and year, and derives the same id from the same key', () => {
    expect(recordKey(candidate())).toBe('doi:10.1109/icws.2017.13')
    expect(recordKey(candidate({ identifiers: { arxiv: '2008.06448v2' } }))).toBe('arxiv:2008.06448')
    expect(recordKey(candidate({ identifiers: {}, title: 'Drain: An Online Log Parsing Approach!' }))).toBe('title:drain an online log parsing approach|2017')
    const id = recordIdFor('doi:10.1109/icws.2017.13', () => false)
    expect(id).toMatch(/^r[0-9a-f]{12}$/)
    expect(recordIdFor('doi:10.1109/icws.2017.13', () => false)).toBe(id)
    expect(recordIdFor('doi:10.1109/icws.2017.13', (x) => x === id)).not.toBe(id)
  })

  it('never derives a shared key from a title that cannot tell works apart (short, non-Latin or without a year)', () => {
    const short = candidate({ identifiers: {}, title: 'Introduction' })
    expect(recordKey(short)).toMatch(/^unkeyed:[0-9a-f]+$/)
    expect(recordKey(short)).not.toBe(recordKey(short))
    expect(recordKey(candidate({ identifiers: {}, title: '日志解析的在线方法研究' }))).toMatch(/^unkeyed:/)
    expect(recordKey(candidate({ identifiers: {}, year: null }))).toMatch(/^unkeyed:/)
  })

  it('measures title similarity on words, ignoring case, accents and punctuation', () => {
    expect(titleSimilarity('Drain: an online log parser', 'DRAIN — An Online Log Parser')).toBe(1)
    expect(titleSimilarity('Log parsing with trees', 'Anomaly detection with graphs')).toBeLessThan(0.5)
    expect(titleSimilarity('日志解析', '日志解析')).toBe(0)
  })
})

describe('RecordMatcher', () => {
  const drain = record()
  const matcher = (): RecordMatcher => new RecordMatcher([drain])

  it('finds the same work by any shared identifier, whatever its form', () => {
    expect(matcher().match(candidate({ identifiers: { doi: 'https://doi.org/10.1109/ICWS.2017.13' } }))).toEqual({ kind: 'same', record: drain.id })
    const preprint = record({ id: hexId('r', 2), identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' }, title: 'Loghub' })
    expect(new RecordMatcher([preprint]).match(candidate({ title: 'Other title', identifiers: { arxiv: 'arXiv:2008.06448v3' } }))).toEqual({ kind: 'same', record: preprint.id })
    const oa = record({ id: hexId('r', 3), identifiers: { openalex: 'W42' } })
    expect(new RecordMatcher([oa]).match(candidate({ title: 'x', identifiers: { openalex: 'https://openalex.org/W42' } }))).toEqual({ kind: 'same', record: oa.id })
  })

  it('never joins on a shared identifier when another identifier kind conflicts: it asks', () => {
    const preprint = record({ id: hexId('r', 2), identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' } })
    const published = candidate({ identifiers: { doi: '10.1109/issre.2023.1', arxiv: '2008.06448' } })
    expect(new RecordMatcher([preprint]).match(published)).toEqual({ kind: 'doubtful', record: preprint.id, reason: 'conflicting_ids' })
    const oa = record({ identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' } })
    expect(new RecordMatcher([oa]).match(candidate({ identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2' } }))).toEqual({
      kind: 'doubtful',
      record: oa.id,
      reason: 'conflicting_ids'
    })
  })

  it('asks when identifiers point at records that disagree, and prefers a clean title match over a doubtful one', () => {
    const conflicting = record({ id: hexId('r', 1), identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' } })
    const clean = record({ id: hexId('r', 2), identifiers: { openalex: 'W2' } })
    expect(new RecordMatcher([conflicting, clean]).match(candidate({ identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2' } }))).toEqual({
      kind: 'doubtful',
      record: conflicting.id,
      reason: 'conflicting_ids'
    })
    const other = record({ id: hexId('r', 3), identifiers: { doi: '10.5555/other' } })
    const plain = record({ id: hexId('r', 4), identifiers: {} })
    expect(new RecordMatcher([other, plain]).match(candidate({ identifiers: { doi: '10.1109/unknown' } }))).toEqual({ kind: 'same', record: plain.id })
  })

  it('without identifiers in conflict, the same normalized title and year is the same work', () => {
    expect(matcher().match(candidate({ identifiers: {}, title: 'DRAIN: an online log parsing approach with fixed-depth tree.' }))).toEqual({ kind: 'same', record: drain.id })
  })

  it('asks about the same title with other identifiers or a year apart, and about a very similar title', () => {
    expect(matcher().match(candidate({ identifiers: { doi: '10.5555/drain.journal' } }))).toEqual({ kind: 'doubtful', record: drain.id, reason: 'conflicting_ids' })
    expect(matcher().match(candidate({ identifiers: {}, year: 2018 }))).toEqual({ kind: 'doubtful', record: drain.id, reason: 'same_title' })
    expect(matcher().match(candidate({ identifiers: {}, title: 'Drain: An Online Log Parsing Approach with a Fixed Depth Tree' }))).toEqual({
      kind: 'doubtful',
      record: drain.id,
      reason: 'similar_title'
    })
    expect(matcher().match(candidate({ identifiers: {}, year: 2020 }))).toBeNull()
  })

  it('asks, never joins, when a year is missing on either side', () => {
    expect(matcher().match(candidate({ identifiers: {}, year: null }))).toEqual({ kind: 'doubtful', record: drain.id, reason: 'same_title' })
    const undated = record({ year: null, identifiers: {} })
    expect(new RecordMatcher([undated]).match(candidate({ identifiers: {}, year: null }))).toEqual({ kind: 'doubtful', record: undated.id, reason: 'same_title' })
  })

  it('treats a short title as doubtful, never as the same work, and ignores merged records', () => {
    const short = record({ id: hexId('r', 4), title: 'Introduction', identifiers: {} })
    expect(new RecordMatcher([short]).match(candidate({ title: 'Introduction', identifiers: {} }))).toEqual({ kind: 'doubtful', record: short.id, reason: 'same_title' })
    expect(new RecordMatcher([record({ merged_into: hexId('r', 9) })]).match(candidate())).toBeNull()
  })

  it('never matches titles that fold to nothing', () => {
    const cjk = record({ title: '日志解析的在线方法研究', identifiers: {} })
    expect(new RecordMatcher([cjk]).match(candidate({ title: '异常检测的图方法', identifiers: {} }))).toBeNull()
  })

  it('sees the records added during the same import', () => {
    const m = new RecordMatcher([])
    const added = newRecord(candidate(), { id: hexId('r', 5), searchId: hexId('s', 1), at: AT, paperId: null, duplicate: null })
    m.add(added)
    expect(m.match(candidate({ identifiers: { doi: '10.1109/icws.2017.13' } }))).toEqual({ kind: 'same', record: added.id })
  })
})

describe('records', () => {
  it('builds a record from a candidate with clean identifiers', () => {
    expect(newRecord(candidate({ abstract: 'A.' }), { id: hexId('r', 1), searchId: hexId('s', 1), at: AT, paperId: 'he2017drain', duplicate: null })).toEqual({
      id: hexId('r', 1),
      title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
      authors: [{ family: 'He', given: 'Pinjia' }],
      year: 2017,
      venue: 'ICWS',
      abstract: 'A.',
      kind: 'conference',
      identifiers: { doi: '10.1109/icws.2017.13' },
      sources: [hexId('s', 1)],
      paper_id: 'he2017drain',
      duplicate_of: null,
      merged_into: null,
      distinct_from: [],
      added_at: AT,
      updated_at: AT
    })
  })

  it('stores a doubtful pair on the new record', () => {
    const r = newRecord(candidate(), { id: hexId('r', 2), searchId: hexId('s', 1), at: AT, paperId: null, duplicate: { record: hexId('r', 1), reason: 'same_title' } })
    expect(r.duplicate_of).toEqual({ record: hexId('r', 1), reason: 'same_title' })
  })

  it('adds the search as a source and fills what the record lacked, once', () => {
    const bare = record({ abstract: null, venue: null, identifiers: {} })
    const merged = mergeCandidate(bare, candidate({ abstract: 'Now with an abstract.', identifiers: { doi: '10.1109/ICWS.2017.13', openalex: 'W1' } }), hexId('s', 2), LATER)
    expect(merged).toMatchObject({ abstract: 'Now with an abstract.', venue: 'ICWS', identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' }, sources: [hexId('s', 1), hexId('s', 2)], updated_at: LATER })
    expect(mergeCandidate(merged, candidate(), hexId('s', 2), '2026-10-12T12:00:00.000Z')).toBe(merged)
  })

  it('keeps the record identifiers (and unknown keys) and ignores key order', () => {
    const r = record({ identifiers: { openalex: 'W1', doi: '10.1109/icws.2017.13', pmid: '42' } as never })
    expect(mergeCandidate(r, candidate({ identifiers: { doi: '10.1109/ICWS.2017.13', openalex: 'W1' } }), hexId('s', 1), LATER)).toBe(r)
    const next = mergeCandidate(r, candidate({ identifiers: { arxiv: '2008.06448' } }), hexId('s', 1), LATER)
    expect(next.identifiers).toEqual({ doi: '10.1109/icws.2017.13', openalex: 'W1', arxiv: '2008.06448', pmid: '42' })
  })

  it('finds active records two machines made for one work (a shared identifier), unless told they are distinct', () => {
    const a = record({ id: hexId('r', 1), added_at: AT })
    const b = record({ id: hexId('r', 2), added_at: LATER, title: 'Drain (preprint title)' })
    expect(identifierCollisions([b, a])).toEqual([{ record: b.id, other: a.id }])
    expect(identifierCollisions([a, { ...b, distinct_from: [a.id] }])).toEqual([])
  })

  it('skips a pair already waiting as a doubtful duplicate, and pairs with the next owner when told distinct from the first', () => {
    const a = record({ id: hexId('r', 1), added_at: AT })
    const b = record({ id: hexId('r', 2), added_at: LATER, duplicate_of: { record: hexId('r', 1), reason: 'conflicting_ids' } })
    expect(identifierCollisions([a, b])).toEqual([])
    const c = record({ id: hexId('r', 3), added_at: '2026-10-12T12:00:00.000Z', distinct_from: [a.id] })
    expect(identifierCollisions([a, { ...b, duplicate_of: null }, c])).toEqual([
      { record: b.id, other: a.id },
      { record: c.id, other: b.id }
    ])
  })
})
