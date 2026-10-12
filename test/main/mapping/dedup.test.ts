import { describe, expect, it } from 'vitest'
import {
  cleanIdentifiers,
  syncDuplicates,
  mergeCandidate,
  newRecord,
  RecordMatcher,
  recordIdFor,
  recordKey,
  titleForm,
  titleSimilarity
} from '../../../src/main/mapping/dedup'
import type { MappingRecord, WorkCandidate } from '../../../src/shared/mapping'
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

  it('drops values that are not identifiers and reads the URL and versioned forms', () => {
    expect(cleanIdentifiers({ doi: 'N/A', openalex: 'garbage' })).toEqual({})
    expect(cleanIdentifiers({ doi: '-', arxiv: '-' })).toEqual({})
    expect(cleanIdentifiers({ doi: 'https://www.doi.org/10.1109/ICWS.2017.13' })).toEqual({ doi: '10.1109/icws.2017.13' })
    expect(cleanIdentifiers({ doi: 'doi:10.1109/ICWS.2017.13' })).toEqual({ doi: '10.1109/icws.2017.13' })
    expect(cleanIdentifiers({ arxiv: 'https://arxiv.org/abs/2008.06448v2' })).toEqual({ arxiv: '2008.06448' })
    expect(cleanIdentifiers({ arxiv: 'https://arxiv.org/pdf/2008.06448v2.pdf' })).toEqual({ arxiv: '2008.06448' })
    expect(cleanIdentifiers({ doi: '10.48550/arXiv.2008.06448v2' })).toEqual({ doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' })
    expect(cleanIdentifiers({ openalex: 'https://openalex.org/works/w99' })).toEqual({ openalex: 'W99' })
  })

  it('keys a record by its best identifier, else by its title and year, and derives the same id from the same key', () => {
    expect(recordKey(candidate())).toBe('doi:10.1109/icws.2017.13')
    expect(recordKey(candidate({ identifiers: { arxiv: '2008.06448v2' } }))).toBe('arxiv:2008.06448')
    expect(recordKey(candidate({ identifiers: {}, title: 'Drain: An Online Log Parsing Approach!' }))).toBe('title:drain an online log parsing approach|2017|he')
    expect(recordKey(candidate({ identifiers: {}, authors: [] }))).toBe('title:drain an online log parsing approach with fixed depth tree|2017|')
    expect(recordKey(candidate({ identifiers: { doi: '10.48550/arXiv.2008.06448' } }))).toBe(recordKey(candidate({ identifiers: { arxiv: '2008.06448' } })))
    expect(recordKey(candidate({ identifiers: { doi: 'N/A' } }))).toMatch(/^title:/)
    const id = recordIdFor('doi:10.1109/icws.2017.13', () => false)
    expect(id).toMatch(/^r[0-9a-f]{12}$/)
    expect(recordIdFor('doi:10.1109/icws.2017.13', () => false)).toBe(id)
    expect(recordIdFor('doi:10.1109/icws.2017.13', (x) => x === id)).not.toBe(id)
  })

  it('never derives a shared key from a title that cannot tell works apart (short, non-Latin or without a year)', () => {
    const short = candidate({ identifiers: {}, title: 'Introduction' })
    expect(recordKey(short)).toMatch(/^unkeyed:[0-9a-f]+$/)
    expect(recordKey(short)).not.toBe(recordKey(short))
    expect(recordKey(candidate({ identifiers: {}, title: '日志解析' }))).toMatch(/^unkeyed:/)
    expect(recordKey(candidate({ identifiers: {}, title: '日志解析的在线方法研究' }))).toBe('title:日志解析的在线方法研究|2017|he')
    expect(recordKey(candidate({ identifiers: {}, year: null }))).toMatch(/^unkeyed:/)
  })

  it('measures title similarity on words, ignoring case, accents and punctuation', () => {
    expect(titleSimilarity('Drain: an online log parser', 'DRAIN — An Online Log Parser')).toBe(1)
    expect(titleSimilarity('Log parsing with trees', 'Anomaly detection with graphs')).toBeLessThan(0.5)
    expect(titleSimilarity('日志解析', '日志解析')).toBe(1)
    expect(titleSimilarity('基于Transformer的日志解析方法研究', '基于Transformer的异常检测方法研究')).toBeLessThan(0.9)
  })

  it('keeps the letters of every script in the title normal form, and Latin titles as the library folds them', () => {
    expect(titleForm('Drain: An Online Log-Parsing Approach (ß, Æ)!')).toBe('drain an online log parsing approach ss ae')
    expect(titleForm('基于Transformer的日志解析 for logs')).toBe('基于transformer的日志解析 for logs')
    expect(titleForm('Ανάλυση ΑΡΧΕΊΩΝ καταγραφής')).toBe('αναλυση αρχειων καταγραφησ')
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

  it('joins the record a shared identifier matches cleanly, even when another record sharing one conflicts', () => {
    const conflicting = record({ id: hexId('r', 1), identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' } })
    const clean = record({ id: hexId('r', 2), identifiers: { openalex: 'W2' } })
    expect(new RecordMatcher([conflicting, clean]).match(candidate({ identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2' } }))).toEqual({
      kind: 'same',
      record: clean.id
    })
  })

  it('prefers a clean title match over a doubtful one, and the nearest year among doubtful ones', () => {
    const other = record({ id: hexId('r', 3), identifiers: { doi: '10.5555/other' } })
    const plain = record({ id: hexId('r', 4), identifiers: {} })
    expect(new RecordMatcher([other, plain]).match(candidate({ identifiers: { doi: '10.1109/unknown' } }))).toEqual({ kind: 'same', record: plain.id })
    const far = record({ id: hexId('r', 5), identifiers: {}, year: null })
    const close = record({ id: hexId('r', 6), identifiers: {}, year: 2018 })
    expect(new RecordMatcher([far, close]).match(candidate({ identifiers: {} }))).toEqual({ kind: 'doubtful', record: close.id, reason: 'same_title' })
  })

  it('never joins on a junk identifier', () => {
    const a = record({ identifiers: { doi: 'n/a' }, title: 'Log parsing with fixed depth trees' })
    expect(new RecordMatcher([a]).match(candidate({ identifiers: { doi: 'N/A' }, title: 'Anomaly detection on system logs' }))).toBeNull()
  })

  it('needs the first authors to agree for a title match', () => {
    const chair = record({ identifiers: {}, title: 'Message from the General Chair', authors: [{ family: 'Smith' }], venue: 'ICSE' })
    const m = new RecordMatcher([chair])
    expect(m.match(candidate({ identifiers: {}, title: 'Message from the General Chair', authors: [{ family: 'Jones' }], venue: 'ICSE' }))).toEqual({
      kind: 'doubtful',
      record: chair.id,
      reason: 'same_title'
    })
    expect(m.match(candidate({ identifiers: {}, title: 'Message from the General Chair', authors: [{ family: 'Smíth' }] }))).toEqual({ kind: 'same', record: chair.id })
    expect(m.match(candidate({ identifiers: {}, title: 'Message from the General Chair', authors: [] }))).toEqual({ kind: 'same', record: chair.id })
  })

  it('tells mixed-script titles apart, and matches a non-Latin title again', () => {
    const a = record({ identifiers: {}, title: '基于Transformer的日志解析方法研究 for system logs' })
    const m = new RecordMatcher([a])
    expect(m.match(candidate({ identifiers: {}, title: '基于Transformer的异常检测方法研究 for system logs' }))).toBeNull()
    expect(m.match(candidate({ identifiers: {}, title: '基于Transformer的日志解析方法研究 for system logs' }))).toEqual({ kind: 'same', record: a.id })
    const greek = record({ id: hexId('r', 2), identifiers: {}, title: 'Ανάλυση αρχείων καταγραφής συστημάτων' })
    expect(new RecordMatcher([greek]).match(candidate({ identifiers: {}, title: 'ΑΝΆΛΥΣΗ ΑΡΧΕΊΩΝ ΚΑΤΑΓΡΑΦΉΣ ΣΥΣΤΗΜΆΤΩΝ' }))).toEqual({ kind: 'same', record: greek.id })
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
    expect(new RecordMatcher([undated]).match(candidate({ identifiers: {}, year: null, venue: 'ICWS Workshops' }))).toEqual({ kind: 'doubtful', record: undated.id, reason: 'same_title' })
  })

  it('treats a short title as doubtful, never as the same work, and resolves merged records to the record they were merged into', () => {
    const short = record({ id: hexId('r', 4), title: 'Introduction', identifiers: {}, venue: 'IEEE Software' })
    expect(new RecordMatcher([short]).match(candidate({ title: 'Introduction', identifiers: {} }))).toEqual({ kind: 'doubtful', record: short.id, reason: 'same_title' })
    expect(new RecordMatcher([record({ merged_into: hexId('r', 9) })]).match(candidate())).toBeNull()
    const root = record({ id: hexId('r', 9), identifiers: { doi: '10.5555/root' }, title: 'Root title of the merged work' })
    expect(new RecordMatcher([record({ merged_into: root.id }), root]).match(candidate())).toEqual({ kind: 'same', record: root.id })
  })

  it('matches a re-import of a short or year-less title that replicates a record, and asks about one that differs', () => {
    const intro = record({ id: hexId('r', 1), title: 'Introduction', identifiers: {}, venue: 'IEEE Software' })
    const undated = record({ id: hexId('r', 2), identifiers: {}, year: null })
    const m = new RecordMatcher([intro, undated])
    expect(m.match(candidate({ title: 'Introduction', identifiers: {}, venue: 'IEEE Software' }))).toEqual({ kind: 'same', record: intro.id })
    expect(m.match(candidate({ identifiers: {}, year: null }))).toEqual({ kind: 'same', record: undated.id })
    expect(m.match(candidate({ title: 'Introduction', identifiers: {}, venue: 'IEEE Software', authors: [{ family: 'Other' }] }))).toEqual({
      kind: 'doubtful',
      record: intro.id,
      reason: 'same_title'
    })
  })

  it('keeps «Son distintos» settled for title-only records', () => {
    const a = record({ id: hexId('r', 1), title: 'Introduction', identifiers: {}, authors: [{ family: 'Smith' }], distinct_from: [hexId('r', 2)] })
    const b = record({ id: hexId('r', 2), title: 'Introduction', identifiers: {}, authors: [{ family: 'Jones' }], distinct_from: [hexId('r', 1)] })
    const m = new RecordMatcher([a, b])
    expect(m.match(candidate({ title: 'Introduction', identifiers: {}, authors: [{ family: 'Jones' }] }))).toEqual({ kind: 'same', record: b.id })
    expect(m.match(candidate({ title: 'Introduction', identifiers: {}, authors: [{ family: 'Smith' }] }))).toEqual({ kind: 'same', record: a.id })
  })

  it('never matches titles without letters or digits', () => {
    const blank = record({ title: '???', identifiers: {} })
    expect(new RecordMatcher([blank]).match(candidate({ title: '!!!', identifiers: {} }))).toBeNull()
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
    expect(syncDuplicates([b, a])).toEqual([{ record: b.id, other: a.id, reason: 'same_id' }])
    expect(syncDuplicates([a, { ...b, distinct_from: [a.id] }])).toEqual([])
  })

  it('skips a pair already waiting as a doubtful duplicate, and pairs with the next record when told distinct from the first', () => {
    const a = record({ id: hexId('r', 1), added_at: AT })
    const b = record({ id: hexId('r', 2), added_at: LATER, duplicate_of: { record: hexId('r', 1), reason: 'conflicting_ids' } })
    expect(syncDuplicates([a, b])).toEqual([])
    const c = record({ id: hexId('r', 3), added_at: '2026-10-12T12:00:00.000Z', distinct_from: [a.id] })
    expect(syncDuplicates([a, { ...b, duplicate_of: null }, c])).toEqual([
      { record: b.id, other: a.id, reason: 'same_id' },
      { record: c.id, other: b.id, reason: 'same_id' }
    ])
  })

  it('finds records with weak or title keys that two machines made for one work', () => {
    const a = record({ id: hexId('r', 1), title: 'Introduction', identifiers: {} })
    const b = record({ id: hexId('r', 2), title: 'Introduction', identifiers: {}, added_at: LATER })
    expect(syncDuplicates([a, b])).toEqual([{ record: b.id, other: a.id, reason: 'same_title' }])
    const titled = record({ id: hexId('r', 3), identifiers: {}, added_at: LATER })
    const withDoi = record({ id: hexId('r', 4) })
    expect(syncDuplicates([titled, withDoi])).toEqual([{ record: titled.id, other: withDoi.id, reason: 'same_title' }])
    const other = record({ id: hexId('r', 5), title: 'Introduction', identifiers: {}, authors: [{ family: 'Jones' }], added_at: LATER })
    expect(syncDuplicates([a, other])).toEqual([{ record: other.id, other: a.id, reason: 'same_title' }])
  })
})

/** Task 10's addSearch loop: same → merge; else a new record (doubtful pairs stored on it). */
function importInto(records: MappingRecord[], candidates: WorkCandidate[], searchId: string): MappingRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]))
  const matcher = new RecordMatcher(byId.values())
  for (const c of candidates) {
    const m = matcher.match(c)
    if (m?.kind === 'same') {
      byId.set(m.record, mergeCandidate(byId.get(m.record)!, c, searchId, LATER))
      continue
    }
    const r = newRecord(c, {
      id: recordIdFor(recordKey(c), (x) => byId.has(x)),
      searchId,
      at: AT,
      paperId: null,
      duplicate: m ? { record: m.record, reason: m.reason } : null
    })
    byId.set(r.id, r)
    matcher.add(r)
  }
  return [...byId.values()]
}

describe('re-imports', () => {
  const preprint = candidate({ title: 'Loghub: a large collection of system log datasets', identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' } })
  const published = candidate({ title: 'Loghub: A Large Collection of System Log Datasets', identifiers: { doi: '10.1109/issre59848.2023.00071', arxiv: '2008.06448' } })
  const first = importInto([], [preprint, published], hexId('s', 1))
  const [a, b] = first

  it('stores a preprint and its published version as a doubtful pair', () => {
    expect(first).toHaveLength(2)
    expect(b.duplicate_of).toEqual({ record: a.id, reason: 'conflicting_ids' })
  })

  it('adds nothing when the same works arrive again', () => {
    const again = importInto(first, [preprint, published], hexId('s', 2))
    expect(again).toHaveLength(2)
    expect(again.every((r) => r.sources.includes(hexId('s', 2)))).toBe(true)
  })

  it('keeps «Son distintos» settled', () => {
    const distinct = [
      { ...a, distinct_from: [b.id] },
      { ...b, duplicate_of: null, distinct_from: [a.id] }
    ]
    const again = importInto(distinct, [published, preprint], hexId('s', 2))
    expect(again).toHaveLength(2)
    expect(again.find((r) => r.id === b.id)!.sources).toContain(hexId('s', 2))
  })

  it('keeps «Es el mismo» settled', () => {
    const merged = [a, { ...b, duplicate_of: null, merged_into: a.id }]
    const again = importInto(merged, [published, preprint], hexId('s', 2))
    expect(again).toHaveLength(2)
    expect(again.find((r) => r.id === a.id)!.sources).toContain(hexId('s', 2))
  })

  it('adds nothing when short, year-less and non-Latin titles arrive again', () => {
    const cs = [
      candidate({ title: 'Introduction', identifiers: {} }),
      candidate({ identifiers: {}, year: null }),
      candidate({ title: '日志解析的在线方法研究', identifiers: {} })
    ]
    const once = importInto([], cs, hexId('s', 1))
    expect(once).toHaveLength(3)
    expect(importInto(once, cs, hexId('s', 2))).toHaveLength(3)
  })
})

describe('performance', () => {
  const vocab = Array.from({ length: 2000 }, (_, i) => `w${i.toString(36)}x`)
  let seed = 7
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const title = (): string => Array.from({ length: 8 + rand(5) }, () => vocab[rand(vocab.length)]).join(' ')

  it('matches 3,000 candidates against 3,000 records of the same years quickly, with and without years', () => {
    const records = Array.from({ length: 3000 }, (_, i) => record({ id: `r${i.toString(16).padStart(12, '0')}`, title: title(), identifiers: {}, year: 2020 + (i % 2) }))
    const m = new RecordMatcher(records)
    const start = performance.now()
    for (let i = 0; i < 3000; i++) m.match(candidate({ title: title(), identifiers: {}, year: i % 3 === 0 ? null : 2020 }))
    expect(performance.now() - start).toBeLessThan(3000)
  })
})
