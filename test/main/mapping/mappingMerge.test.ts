import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  mergeDecisionsText,
  mergeProtocolText,
  mergeRecordsText,
  mergeSearchesText,
  mergeSuggestionsText
} from '../../../src/main/mapping/mappingMerge'
import { toYaml } from '../../../src/main/project/yamlFile'
import type { Decision, MappingRecord, ProtocolFile, Search } from '../../../src/shared/mapping'
import { AT, decision, hexId, protocolBody, protocolFile, record, search, suggestion } from '../../helpers/mappings'

const searchesText = (searches: Search[], extra: Record<string, unknown> = {}): string => toYaml({ schema_version: 1, searches, ...extra })
const recordsText = (records: MappingRecord[]): string => toYaml({ schema_version: 1, records })
const decisionsText = (decisions: Decision[]): string => toYaml({ schema_version: 1, decisions })
const read = <T>(text: string | null): T => parse(text ?? '') as T
const LATE = '2026-10-12T12:00:00.000Z'

describe('searches.yaml', () => {
  it('keeps every search of both machines, and a discard made on either', () => {
    const s1 = search()
    const s2 = search({ id: hexId('s', 2), at: '2026-10-12T10:00:00.000Z' })
    const discarded = { ...s1, discarded: { at: LATE, reason: 'Wrong string.', machine: 'machine-b' } }
    const merged = read<{ searches: Search[] }>(mergeSearchesText({ base: searchesText([s1]), ours: searchesText([s1, s2]), theirs: searchesText([discarded]) }))
    expect(merged.searches.map((s) => [s.id, s.discarded?.reason ?? null])).toEqual([
      [s1.id, 'Wrong string.'],
      [s2.id, null]
    ])
    const earlier = { ...s1, discarded: { at: AT, reason: 'First.', machine: 'machine-a' } }
    expect(read<{ searches: Search[] }>(mergeSearchesText({ base: null, ours: searchesText([discarded]), theirs: searchesText([earlier]) })).searches[0].discarded?.reason).toBe('First.')
  })

  it('keeps unknown keys of both machines, and a one-sided change of a search', () => {
    const s1 = search()
    const ours = { ...s1, count: 5, note_a: 'ours' }
    const theirs = { ...s1, note_b: 'theirs' }
    const merged = read<{ searches: Record<string, unknown>[]; extra_o: number; extra_t: number }>(
      mergeSearchesText({ base: searchesText([s1]), ours: searchesText([ours], { extra_o: 1 }), theirs: searchesText([theirs], { extra_t: 2 }) })
    )
    expect(merged.searches[0]).toMatchObject({ count: 5, note_a: 'ours', note_b: 'theirs' })
    expect(merged).toMatchObject({ extra_o: 1, extra_t: 2 })
  })

  it('leaves to the user a search both machines changed differently', () => {
    const s1 = search()
    expect(mergeSearchesText({ base: searchesText([s1]), ours: searchesText([{ ...s1, count: 5 }]), theirs: searchesText([{ ...s1, count: 6 }]) })).toBeNull()
  })
})

describe('decisions.yaml and suggestions.yaml', () => {
  it('join both machines’ entries by id, in time order', () => {
    const d1 = decision()
    const d2 = decision({ id: hexId('d', 2), at: '2026-10-12T10:05:00.000Z', machine: 'machine-b', replaces: [d1.id] })
    const d3 = decision({ id: hexId('d', 3), at: '2026-10-12T10:03:00.000Z', replaces: [d1.id], decision: 'exclude', criterion: 'E1' })
    const merged = read<{ decisions: Decision[] }>(mergeDecisionsText({ base: decisionsText([d1]), ours: decisionsText([d1, d3]), theirs: decisionsText([d1, d2]) }))
    expect(merged.decisions.map((d) => d.id)).toEqual([d1.id, d3.id, d2.id])
    const g2 = suggestion({ id: hexId('g', 2), at: LATE })
    const sugg = (list: unknown[]): string => toYaml({ schema_version: 1, suggestions: list })
    expect(read<{ suggestions: { id: string }[] }>(mergeSuggestionsText({ base: null, ours: sugg([suggestion()]), theirs: sugg([g2]) })).suggestions.map((s) => s.id)).toEqual([hexId('g', 1), g2.id])
  })

  it('never loses a decision the other side no longer has, and keeps unknown keys', () => {
    const d1 = decision()
    const d2 = { ...decision({ id: hexId('d', 2), at: LATE }), weight: 2 }
    const merged = read<{ decisions: Record<string, unknown>[] }>(mergeDecisionsText({ base: decisionsText([d1]), ours: decisionsText([]), theirs: decisionsText([d1, d2]) }))
    expect(merged.decisions.map((d) => d.id)).toEqual([d1.id, d2.id])
    expect(merged.decisions[1].weight).toBe(2)
  })

  it('leaves to the user one decision that differs between the machines, or a side it cannot read', () => {
    const d1 = decision()
    expect(mergeDecisionsText({ base: null, ours: decisionsText([d1]), theirs: decisionsText([{ ...d1, decision: 'exclude', criterion: 'E1' }]) })).toBeNull()
    expect(mergeDecisionsText({ base: null, ours: decisionsText([d1]), theirs: toYaml({ schema_version: 1, decisions: [{ id: 'nope' }] }) })).toBeNull()
    expect(mergeSuggestionsText({ base: null, ours: 'suggestions: [', theirs: toYaml({ schema_version: 1, suggestions: [] }) })).toBeNull()
  })
})

describe('records.yaml', () => {
  it('takes the only side that changed a record, whatever the clocks say', () => {
    const base = record({ updated_at: LATE })
    const linked = { ...base, paper_id: 'he2017drain', updated_at: '2026-10-12T11:00:00.000Z' }
    const merged = read<{ records: MappingRecord[] }>(mergeRecordsText({ base: recordsText([base]), ours: recordsText([base]), theirs: recordsText([linked]) }))
    expect(merged.records[0].paper_id).toBe('he2017drain')
  })

  it('changed on both: the newer wins, with the sources and distinct records of both and a link or merge from either', () => {
    const base = record()
    const ours = { ...base, sources: [...base.sources, hexId('s', 2)], paper_id: 'he2017drain', marker: 'ours', updated_at: '2026-10-12T10:00:00.000Z' }
    const theirs = { ...base, sources: [...base.sources, hexId('s', 3)], abstract: 'Newer abstract.', distinct_from: [hexId('r', 7)], updated_at: '2026-10-12T11:00:00.000Z' }
    const extra = record({ id: hexId('r', 2), added_at: LATE, updated_at: LATE })
    const merged = read<{ records: MappingRecord[] }>(mergeRecordsText({ base: recordsText([base]), ours: recordsText([ours]), theirs: recordsText([theirs, extra]) }))
    expect(merged.records.map((r) => r.id)).toEqual([base.id, extra.id])
    expect(merged.records[0]).toMatchObject({
      abstract: 'Newer abstract.',
      sources: [hexId('s', 1), hexId('s', 2), hexId('s', 3)],
      distinct_from: [hexId('r', 7)],
      paper_id: 'he2017drain',
      marker: 'ours'
    })
  })

  it('keeps «Son distintos» from one machine when the other later added a source', () => {
    const r1 = hexId('r', 1)
    const base = record({ id: hexId('r', 2), duplicate_of: { record: r1, reason: 'similar_title' } })
    const resolved = { ...base, duplicate_of: null, distinct_from: [r1], updated_at: '2026-10-12T10:00:00.000Z' }
    const refound = { ...base, sources: [...base.sources, hexId('s', 2)], updated_at: '2026-10-12T11:00:00.000Z' }
    const merged = read<{ records: MappingRecord[] }>(mergeRecordsText({ base: recordsText([base]), ours: recordsText([resolved]), theirs: recordsText([refound]) }))
    expect(merged.records[0]).toMatchObject({ duplicate_of: null, distinct_from: [r1], sources: [hexId('s', 1), hexId('s', 2)], updated_at: '2026-10-12T11:00:00.000Z' })
  })

  it('keeps the fields «Es el mismo» filled in on one machine when the other later added a source', () => {
    const base = record({ abstract: null })
    const filled = { ...base, abstract: 'Taken from the duplicate.', marker: 'older side', updated_at: '2026-10-12T10:00:00.000Z' }
    const refound = { ...base, sources: [...base.sources, hexId('s', 2)], updated_at: '2026-10-12T11:00:00.000Z' }
    const merged = read<{ records: Record<string, unknown>[] }>(mergeRecordsText({ base: recordsText([base]), ours: recordsText([filled]), theirs: recordsText([refound]) }))
    expect(merged.records[0]).toMatchObject({ abstract: 'Taken from the duplicate.', marker: 'older side', sources: [hexId('s', 1), hexId('s', 2)] })
  })

  it('clears a pending duplicate once the merged record was merged into another', () => {
    const base = record({ id: hexId('r', 2), duplicate_of: { record: hexId('r', 1), reason: 'same_title' } })
    const merged = read<{ records: MappingRecord[] }>(
      mergeRecordsText({
        base: recordsText([base]),
        ours: recordsText([{ ...base, merged_into: hexId('r', 1), updated_at: '2026-10-12T10:00:00.000Z' }]),
        theirs: recordsText([{ ...base, duplicate_of: { record: hexId('r', 1), reason: 'similar_title' }, updated_at: '2026-10-12T11:00:00.000Z' }])
      })
    )
    expect(merged.records[0]).toMatchObject({ merged_into: hexId('r', 1), duplicate_of: null })
  })

  it('gives the same file whichever machine merges, even with equal clocks', () => {
    const base = record()
    const a = { ...base, abstract: 'A.', extra_a: 1, updated_at: LATE }
    const b = { ...base, abstract: 'B.', extra_b: 2, updated_at: LATE }
    for (const baseText of [recordsText([base]), null]) {
      const ab = mergeRecordsText({ base: baseText, ours: recordsText([a]), theirs: recordsText([b]) })
      expect(ab).not.toBeNull()
      expect(mergeRecordsText({ base: baseText, ours: recordsText([b]), theirs: recordsText([a]) })).toBe(ab)
    }
    const s1 = search()
    const da = { ...s1, discarded: { at: AT, reason: 'A.', machine: 'a' }, note_a: 1 }
    const db = { ...s1, discarded: { at: AT, reason: 'B.', machine: 'b' }, note_b: 2 }
    expect(mergeSearchesText({ base: null, ours: searchesText([da], { x: 1 }), theirs: searchesText([db], { y: 2 }) })).toBe(
      mergeSearchesText({ base: null, ours: searchesText([db], { y: 2 }), theirs: searchesText([da], { x: 1 }) })
    )
  })

  it('leaves a file it cannot read to the user', () => {
    expect(mergeRecordsText({ base: null, ours: recordsText([record()]), theirs: 'records: [' })).toBeNull()
    expect(mergeRecordsText({ base: null, ours: recordsText([record()]), theirs: toYaml({ schema_version: 2, records: [] }) })).toBeNull()
  })
})

describe('protocol.yaml', () => {
  const text = (p: ProtocolFile | Record<string, unknown>): string => toYaml(p)

  it('takes the side that changed the protocol', () => {
    const base = protocolFile()
    const edited = protocolFile({ updated_at: '2026-10-12T08:00:00.000Z' }, { objective: 'Edited on the other machine.' })
    expect(read<ProtocolFile>(mergeProtocolText({ base: text(base), ours: text(base), theirs: text(edited) })).protocol.objective).toBe('Edited on the other machine.')
  })

  it('takes a new version from one side and the highest ids, the latest date and unknown keys from both', () => {
    const base = protocolFile()
    const bumped = protocolFile(
      { version: 2, last_ids: { rq: 1, inclusion: 2, exclusion: 2 }, updated_at: '2026-10-12T10:00:00.000Z', history: [{ version: 1, replaced_at: '2026-10-12T10:00:00.000Z', protocol: base.protocol }] },
      { inclusion: [...protocolBody().inclusion, { id: 'I2', text: 'Ours.' }] }
    )
    const other = { ...protocolFile({ last_ids: { rq: 2, inclusion: 1, exclusion: 2 }, updated_at: '2026-10-12T11:00:00.000Z' }), scheme: { facets: [] } }
    const merged = read<ProtocolFile & { scheme: unknown }>(mergeProtocolText({ base: text(base), ours: text(bumped), theirs: text(other) }))
    expect(merged.version).toBe(2)
    expect(merged.protocol.inclusion.map((c) => c.id)).toEqual(['I1', 'I2'])
    expect(merged.history.map((h) => h.version)).toEqual([1])
    expect(merged.last_ids).toEqual({ rq: 2, inclusion: 2, exclusion: 2 })
    expect(merged.updated_at).toBe('2026-10-12T11:00:00.000Z')
    expect(merged.scheme).toEqual({ facets: [] })
  })

  it('both machines made the same new version: merged once, whatever the dates', () => {
    const base = protocolFile()
    const body = { inclusion: [...protocolBody().inclusion, { id: 'I2', text: 'Same.' }] }
    const at = (when: string): ProtocolFile =>
      protocolFile({ version: 2, last_ids: { rq: 1, inclusion: 2, exclusion: 2 }, updated_at: when, history: [{ version: 1, replaced_at: when, protocol: base.protocol }] }, body)
    const merged = read<ProtocolFile>(mergeProtocolText({ base: text(base), ours: text(at('2026-10-12T10:00:00.000Z')), theirs: text(at('2026-10-12T11:00:00.000Z')) }))
    expect(merged.version).toBe(2)
    expect(merged.history).toEqual([{ version: 1, replaced_at: '2026-10-12T10:00:00.000Z', protocol: base.protocol }])
  })

  it('both machines made a different new version from the same base: the user decides, never a silent merge', () => {
    const base = protocolFile()
    const snapshot = { version: 1, replaced_at: '2026-10-12T10:00:00.000Z', protocol: base.protocol }
    const ours = protocolFile(
      { version: 2, last_ids: { rq: 1, inclusion: 2, exclusion: 2 }, updated_at: '2026-10-12T10:00:00.000Z', history: [snapshot] },
      { inclusion: [...protocolBody().inclusion, { id: 'I2', text: 'Ours.' }] }
    )
    const theirs = protocolFile(
      { version: 2, last_ids: { rq: 1, inclusion: 1, exclusion: 3 }, updated_at: '2026-10-12T11:00:00.000Z', history: [{ ...snapshot, replaced_at: '2026-10-12T11:00:00.000Z' }] },
      { exclusion: [...protocolBody().exclusion, { id: 'E3', text: 'Theirs.' }] }
    )
    expect(mergeProtocolText({ base: text(base), ours: text(ours), theirs: text(theirs) })).toBeNull()
  })

  it('both machines added the same new criterion id with different text: the user decides', () => {
    const base = protocolFile()
    const withI2 = (wording: string, when: string): ProtocolFile =>
      protocolFile({ last_ids: { rq: 1, inclusion: 2, exclusion: 2 }, updated_at: when }, { inclusion: [...protocolBody().inclusion, { id: 'I2', text: wording }] })
    expect(mergeProtocolText({ base: text(base), ours: text(withI2('Ours.', '2026-10-12T10:00:00.000Z')), theirs: text(withI2('Theirs.', '2026-10-12T11:00:00.000Z')) })).toBeNull()
    // The same wording on both machines is the same protocol.
    const same = read<ProtocolFile>(
      mergeProtocolText({ base: text(base), ours: text(withI2('Same.', '2026-10-12T10:00:00.000Z')), theirs: text(withI2('Same.', '2026-10-12T11:00:00.000Z')) })
    )
    expect(same.protocol.inclusion.map((c) => c.text)).toEqual([protocolBody().inclusion[0].text, 'Same.'])
  })

  it('two earlier versions with one number and different bodies: the user decides', () => {
    const base = protocolFile()
    const final = { objective: 'Final.' }
    const side = (v2: string): ProtocolFile =>
      protocolFile(
        {
          version: 3,
          updated_at: LATE,
          history: [
            { version: 1, replaced_at: AT, protocol: base.protocol },
            { version: 2, replaced_at: AT, protocol: protocolBody({ objective: v2 }) }
          ]
        },
        final
      )
    expect(mergeProtocolText({ base: text(base), ours: text(side('Ours.')), theirs: text(side('Theirs.')) })).toBeNull()
  })

  it('merges unknown keys of one earlier version recorded on both machines, against the base', () => {
    const base = protocolFile({ version: 2, history: [{ version: 1, replaced_at: AT, protocol: protocolBody(), note: 'base' }] })
    const side = (over: Record<string, unknown>, when: string): ProtocolFile =>
      protocolFile({ version: 2, updated_at: when, history: [{ version: 1, replaced_at: AT, protocol: protocolBody(), note: 'base', ...over }] })
    const ours = side({ note: 'changed here' }, '2026-10-12T10:00:00.000Z')
    const theirs = side({ tag: 'added there' }, '2026-10-12T11:00:00.000Z')
    const merged = read<ProtocolFile>(mergeProtocolText({ base: text(base), ours: text(ours), theirs: text(theirs) }))
    expect(merged.history[0]).toMatchObject({ note: 'changed here', tag: 'added there' })
    expect(mergeProtocolText({ base: text(base), ours: text(theirs), theirs: text(ours) })).toBe(mergeProtocolText({ base: text(base), ours: text(ours), theirs: text(theirs) }))
  })

  it('leaves an unreadable side to the user', () => {
    expect(mergeProtocolText({ base: null, ours: text(protocolFile()), theirs: 'protocol: [' })).toBeNull()
  })
})
