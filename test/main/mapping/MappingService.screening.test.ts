import { describe, expect, it } from 'vitest'
import type { Decision, ProtocolDraft } from '../../../src/shared/mapping'
import { candidate, decision, hexId, record, search, setupMappings, suggestion } from '../../helpers/mappings'
import { samplePaper } from '../../helpers/papers'

const draft: ProtocolDraft = {
  title: 'Log anonymization',
  objective: '',
  research_questions: [],
  inclusion: [{ id: null, text: 'Processes software logs.' }],
  exclusion: [
    { id: null, text: 'Not about software logs.' },
    { id: null, text: 'Not peer reviewed.' }
  ],
  years: { from: null, to: null },
  publication_types: []
}

async function screening() {
  const env = await setupMappings()
  const id = await env.service.create('Logs')
  await env.service.saveProtocol(id, draft, 1)
  await env.service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'logs' }, [
    candidate(),
    candidate({ title: 'Masking secrets in system logs before sharing them', identifiers: { doi: '10.5555/mask.2023' }, year: 2023 })
  ])
  const [first, second] = env.service.queue(id, { phase: 'title_abstract', filter: 'pending' }).map((r) => r.id)
  const decisions = async () => {
    const read = await env.store.readMappingFile(id, 'decisions')
    return read?.ok ? read.value.decisions : []
  }
  return { ...env, id, first, second, decisions }
}

const R1 = hexId('r', 1)
const R2 = hexId('r', 2)

/** Two records two machines added under different ids for one work (a sync pair: R2 is the newer). */
async function syncPair(decided: Decision[], extra: { r3?: boolean } = {}) {
  const env = await setupMappings()
  const id = await env.service.create('Logs')
  const { store, service } = env
  await store.writeMappingFile(id, 'searches', { schema_version: 1, searches: [search({ id: hexId('s', 1), count: extra.r3 ? 2 : 1 }), search({ id: hexId('s', 2), count: 1, machine: 'machine-b' })] }, null)
  const records = [
    record({ id: R1, sources: [hexId('s', 1)] }),
    record({ id: R2, sources: [hexId('s', 2)], identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W1' }, added_at: '2026-10-12T09:30:00.000Z' })
  ]
  if (extra.r3)
    records.push(
      record({
        id: hexId('r', 3),
        title: 'Drain: An Online Log Parsing Approach with a Fixed Depth Tree',
        identifiers: {},
        sources: [hexId('s', 1)],
        distinct_from: [R2],
        added_at: '2026-10-12T09:40:00.000Z'
      })
    )
  await store.writeMappingFile(id, 'records', { schema_version: 1, records }, null)
  if (decided.length > 0) await store.writeMappingFile(id, 'decisions', { schema_version: 1, decisions: decided }, null)
  await service.open(id)
  const decisions = async () => {
    const read = await store.readMappingFile(id, 'decisions')
    return read?.ok ? read.value.decisions : []
  }
  const records2 = async () => {
    const read = await store.readMappingFile(id, 'records')
    return read?.ok ? read.value.records : []
  }
  return { ...env, id, decisions, records: records2 }
}

describe('MappingService screening', () => {
  it('decides on title and abstract, then on full text only for the included', async () => {
    const { service, id, first, second } = await screening()
    const decided = await service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'include', criterion: 'I1', suggestionId: null })
    expect(decided).toMatch(/^d[0-9a-f]{12}$/)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'pending' }).map((r) => r.id)).toEqual([second])
    expect(service.queue(id, { phase: 'full_text', filter: 'pending' }).map((r) => r.id)).toEqual([first])
    await expect(service.decide(id, { recordId: second, phase: 'full_text', decision: 'include', criterion: null, suggestionId: null })).rejects.toMatchObject({ code: 'not_eligible' })
    await expect(service.decide(id, { recordId: second, phase: 'title_abstract', decision: 'exclude', criterion: null, suggestionId: null })).rejects.toMatchObject({ code: 'criterion_required' })
    await expect(service.decide(id, { recordId: second, phase: 'title_abstract', decision: 'not_retrieved', criterion: null, suggestionId: null })).rejects.toMatchObject({ code: 'not_eligible' })
    await expect(service.decide(id, { recordId: hexId('r', 99), phase: 'title_abstract', decision: 'uncertain', criterion: null, suggestionId: null })).rejects.toMatchObject({ code: 'mapping_not_found' })
    await service.decide(id, { recordId: first, phase: 'full_text', decision: 'exclude', criterion: 'E2', suggestionId: null })
    const view = await service.open(id)
    expect(view.prisma.databases).toMatchObject({ sought: 1, assessed: 1, excludedFullText: [{ criterion: 'E2', count: 1 }] })
    expect(view.screeningStarted).toBe(true)
  })

  it('writes nothing when the same decision is already current', async () => {
    const { service, id, first, decisions, changes } = await screening()
    const req = { recordId: first, phase: 'title_abstract' as const, decision: 'uncertain' as const, criterion: null, suggestionId: null }
    const a = await service.decide(id, req)
    const emitted = changes()
    expect(await service.decide(id, req)).toBe(a)
    expect(await decisions()).toHaveLength(1)
    expect(changes()).toBe(emitted)
  })

  it('«Deshacer» appends a decision that restores the previous one, only while the undone one is current', async () => {
    const { service, id, first, decisions } = await screening()
    await service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    const excluded = await service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'exclude', criterion: 'E1', suggestionId: null })
    await service.undo(id, excluded)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'include' }).map((r) => r.id)).toEqual([first])
    await expect(service.undo(id, excluded)).rejects.toMatchObject({ code: 'undo_unavailable' })
    const all = await decisions()
    expect(all).toHaveLength(3)
    expect(all[2]).toMatchObject({ decision: 'include', undoes: excluded, replaces: [excluded] })
  })

  it('shows two machines’ different decisions as a conflict, and resolves it with the one kept', async () => {
    const { service, store, id, first, decisions } = await screening()
    const base = await service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'uncertain', criterion: null, suggestionId: null })
    const [only] = await decisions()
    const read = await store.readMappingFile(id, 'decisions')
    const fromA = { ...only, id: hexId('d', 0xa), decision: 'include' as const, replaces: [base], at: '2026-10-12T10:05:00.000Z', machine: 'machine-a' }
    const fromB = { ...only, id: hexId('d', 0xb), decision: 'exclude' as const, criterion: 'E1', replaces: [base], at: '2026-10-12T10:06:00.000Z', machine: 'machine-b' }
    await store.writeMappingFile(id, 'decisions', { schema_version: 1, decisions: [only, fromA, fromB] }, read!.hash)
    expect(await service.reindexIfChanged(id)).toBe(true)
    const view = await service.open(id)
    expect(view.conflicts).toEqual([
      {
        record: expect.objectContaining({ id: first }),
        phase: 'title_abstract',
        options: [expect.objectContaining({ decisionId: fromA.id, machine: 'machine-a' }), expect.objectContaining({ decisionId: fromB.id, machine: 'machine-b' })]
      }
    ])
    expect(service.queue(id, { phase: 'title_abstract', filter: 'conflict' }).map((r) => r.id)).toEqual([first])
    await expect(service.resolveConflict(id, first, 'title_abstract', base)).rejects.toMatchObject({ code: 'conflict' })
    await service.resolveConflict(id, first, 'title_abstract', fromB.id)
    expect((await service.open(id)).conflicts).toEqual([])
    expect(service.queue(id, { phase: 'title_abstract', filter: 'exclude' })[0]).toMatchObject({ id: first, title_abstract: { criterion: 'E1' } })
    expect((await decisions()).find((d) => d.replaces.length === 2)).toMatchObject({ decision: 'exclude', criterion: 'E1', replaces: [fromA.id, fromB.id] })
    await expect(service.resolveConflict(id, first, 'title_abstract', fromB.id)).rejects.toMatchObject({ code: 'conflict' })
    // A conflict resolution is not taken back with «Deshacer».
    const resolution = (await decisions()).at(-1)!
    await expect(service.undo(id, resolution.id)).rejects.toMatchObject({ code: 'undo_unavailable' })
  })

  it('accepts a suggestion only as it is, and marks decisions made with an earlier protocol', async () => {
    const { service, store, id, first, second, decisions } = await screening()
    const g = suggestion({ id: hexId('g', 1), record: first, decision: 'include', criterion: 'I1' })
    await store.writeMappingFile(id, 'suggestions', { schema_version: 1, suggestions: [g] }, null)
    await service.reindexIfChanged(id)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'pending' })[0].suggestions.title_abstract).toMatchObject({ id: g.id, decision: 'include' })
    await expect(service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'exclude', criterion: 'E1', suggestionId: g.id })).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: g.id })).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(service.decide(id, { recordId: second, phase: 'title_abstract', decision: 'include', criterion: 'I1', suggestionId: g.id })).rejects.toMatchObject({ code: 'invalid_edit' })
    await service.decide(id, { recordId: first, phase: 'title_abstract', decision: 'include', criterion: 'I1', suggestionId: g.id })
    expect((await decisions())[0]).toMatchObject({ by: 'suggestion', suggestion: g.id })
    await service.decide(id, { recordId: second, phase: 'title_abstract', decision: 'uncertain', criterion: null, suggestionId: null })
    const protocol = (await service.open(id)).protocol
    await service.saveProtocol(id, { ...draft, objective: 'Narrower.', inclusion: protocol.protocol.inclusion, exclusion: protocol.protocol.exclusion }, 1)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'include' })[0].title_abstract).toMatchObject({ outdated: true, protocolVersion: 1 })
  })

  it('refuses a decision on a record waiting for «Es el mismo» or «Son distintos», or merged into another', async () => {
    const { service, id } = await syncPair([])
    expect((await service.open(id)).duplicates).toEqual([expect.objectContaining({ record: expect.objectContaining({ id: R2 }) })])
    const on = (recordId: string) => ({ recordId, phase: 'title_abstract' as const, decision: 'uncertain' as const, criterion: null, suggestionId: null })
    await expect(service.decide(id, on(R2))).rejects.toMatchObject({ code: 'not_eligible' })
    await expect(service.resolveConflict(id, R2, 'title_abstract', hexId('d', 1))).rejects.toMatchObject({ code: 'not_eligible' })
    await service.decide(id, on(R1))
    await service.resolveDuplicate(id, R2, true)
    await expect(service.decide(id, on(R2))).rejects.toMatchObject({ code: 'not_eligible' })

    // A stored doubtful pair (made on entry) is refused the same way.
    const env = await screening()
    const journal = candidate({ identifiers: { doi: '10.5555/drain.journal' } })
    await env.service.addSearch(env.id, { kind: 'openalex', database: 'OpenAlex', query: 'journal' }, [journal])
    const [pair] = (await env.service.open(env.id)).duplicates
    await expect(env.service.decide(env.id, on(pair.record.id))).rejects.toMatchObject({ code: 'not_eligible' })
  })
})

describe('«Es el mismo» and the screening', () => {
  const at = (n: number) => `2026-10-12T10:0${n}:00.000Z`

  it('keeps the decision when only the newer copy was decided', async () => {
    const theirs = decision({ id: hexId('d', 2), record: R2, decision: 'exclude', criterion: 'E1', machine: 'machine-b', at: at(2) })
    const { service, id, decisions } = await syncPair([theirs])
    await service.resolveDuplicate(id, R2, true)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'exclude' }).map((r) => [r.id, r.title_abstract.criterion])).toEqual([[R1, 'E1']])
    const copy = (await decisions()).find((d) => d.record === R1)
    expect(copy).toMatchObject({ decision: 'exclude', criterion: 'E1', by: 'user', replaces: [], copied_from: theirs.id, machine: 'machine-b' })
    expect((await service.open(id)).prisma.databases).toMatchObject({ excludedScreening: 1, duplicates: 1 })
  })

  it('adds nothing visible when both copies were decided alike', async () => {
    const mine = decision({ id: hexId('d', 1), record: R1, decision: 'include', at: at(1) })
    const theirs = decision({ id: hexId('d', 2), record: R2, decision: 'include', machine: 'machine-b', at: at(2) })
    const { service, id, decisions } = await syncPair([mine, theirs])
    await service.resolveDuplicate(id, R2, true)
    expect(await decisions()).toHaveLength(2)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'include' })[0]).toMatchObject({ id: R1, title_abstract: { decisionId: mine.id } })
    expect((await service.open(id)).conflicts).toEqual([])
  })

  it('shows copies decided differently as a conflict, which «Quedarme con esta» settles', async () => {
    const mine = decision({ id: hexId('d', 1), record: R1, decision: 'include', at: at(1) })
    const theirs = decision({ id: hexId('d', 2), record: R2, decision: 'exclude', criterion: 'E2', machine: 'machine-b', at: at(2) })
    const { service, id } = await syncPair([mine, theirs])
    await service.resolveDuplicate(id, R2, true)
    const [conflict] = (await service.open(id)).conflicts
    expect(conflict).toMatchObject({ record: { id: R1 }, phase: 'title_abstract' })
    expect(conflict.options.map((o) => [o.decision, o.machine])).toEqual([
      ['include', 'machine-a'],
      ['exclude', 'machine-b']
    ])
    await service.resolveConflict(id, R1, 'title_abstract', conflict.options[1].decisionId)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'exclude' }).map((r) => r.id)).toEqual([R1])
  })

  it('carries the merged record’s «Son distintos» answers to the survivor', async () => {
    const { service, id, records } = await syncPair([], { r3: true })
    await service.resolveDuplicate(id, R2, true)
    expect((await records()).find((r) => r.id === R1)?.distinct_from).toEqual([hexId('r', 3)])
    expect((await service.open(id)).duplicates).toEqual([])
  })

  it('reads the files again, so an answer another machine gave meanwhile is not overridden', async () => {
    const { service, store, id, records } = await syncPair([])
    expect((await service.open(id)).duplicates).toHaveLength(1)
    // The other machine answered «Son distintos»; the sync wrote it but the index has not caught up.
    const read = await store.readMappingFile(id, 'records')
    const answered = read!.ok ? read!.value.records.map((r) => ({ ...r, distinct_from: [r.id === R1 ? R2 : R1] })) : []
    await store.writeMappingFile(id, 'records', { schema_version: 1, records: answered }, read!.hash)
    await expect(service.resolveDuplicate(id, R2, true)).rejects.toMatchObject({ code: 'conflict' })
    expect((await records()).find((r) => r.id === R2)?.merged_into).toBeNull()
  })
})

describe('library link on entry', () => {
  it('does not link by title a record whose DOI differs from the library paper’s', async () => {
    const { service, store, library } = await setupMappings()
    await store.writePaper(samplePaper(), null)
    await library.indexPaper('he2017drain')
    const id = await service.create('Logs')
    expect(await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'drain' }, [candidate({ identifiers: { doi: '10.5555/drain.journal' } })])).toMatchObject({ added: 1, linked: 0 })
    const other = await service.create('Other')
    expect(await service.addSearch(other, { kind: 'openalex', database: 'OpenAlex', query: 'drain' }, [candidate({ identifiers: {} })])).toMatchObject({ added: 1, linked: 1 })
  })
})
