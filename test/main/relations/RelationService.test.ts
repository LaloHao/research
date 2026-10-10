import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { ConflictError } from '../../../src/main/project/errors'
import { toYaml } from '../../../src/main/project/yamlFile'
import { InvalidEdit } from '../../../src/main/summary/merge'
import { DRAIN_ID, LOGHUB_ID, loghubPaper } from '../../helpers/pair'
import { samplePaper } from '../../helpers/papers'
import { agentResult, LOGHUB_EXTENDS_DRAIN, NOW, setupRelations, typedRelation } from '../../helpers/relations'

const ID = 'he2017drain__zhu2020loghub__extends'

describe('RelationService', () => {
  it('suggests, writes relations.yaml with the analysis, and indexes it', async () => {
    const { service, store, cache, emits } = await setupRelations()
    expect(service.needsAnalysis(LOGHUB_ID)).toBe(true)
    expect(await service.run(LOGHUB_ID, {})).toEqual({ paperId: LOGHUB_ID, message: 'relations_suggested' })
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => [r.id, r.origin?.paper])).toEqual([[ID, LOGHUB_ID]])
    expect(read?.ok && read.value.analyzed).toEqual({ [LOGHUB_ID]: { candidates: [DRAIN_ID], at: NOW } })
    expect(cache.getPaper(LOGHUB_ID)?.relations_pending).toBe(1)
    expect(service.needsAnalysis(LOGHUB_ID)).toBe(false)
    // Drain's only candidate is Loghub, and that pair was just analyzed from Loghub's side.
    expect(service.forPaper(DRAIN_ID)).toMatchObject({
      suggested: [{ id: ID, other: { id: LOGHUB_ID, title: loghubPaper().title, year: 2020 } }],
      confirmed: [],
      rejected: [],
      candidates: 1,
      needsAnalysis: false,
      file: { status: 'ok' }
    })
    expect(emits()).toBeGreaterThan(0)
  })

  it("a new analysis replaces only the paper's own unreviewed suggestions, and sees only the paper's relations", async () => {
    const { service, store, provider } = await setupRelations({ agent: [agentResult([LOGHUB_EXTENDS_DRAIN, { ...LOGHUB_EXTENDS_DRAIN, type: 'uses_method_of' }])] })
    const confirmed = typedRelation({ type: 'uses_method_of', status: 'confirmed' })
    const rejected = typedRelation({ type: 'replicates', status: 'rejected' })
    const ownStale = typedRelation({ type: 'contradicts' })
    const fromDrainRun = typedRelation({ type: 'same_problem', from: DRAIN_ID, to: LOGHUB_ID })
    const unrelated = typedRelation({ from: 'am2019x', to: 'zz2020y', type: 'same_problem' })
    await store.writeRelations({ schema_version: 1, relations: [confirmed, rejected, ownStale, fromDrainRun, unrelated], analyzed: {} }, null)
    await service.reindex()
    // The fake agent leaves out both pending suggestions: Loghub's own (contradicts) and the one from Drain's analysis (same_problem).
    await service.run(LOGHUB_ID, {})
    const read = await store.readRelations()
    const list = read?.ok ? read.value.relations : []
    expect(list.map((r) => r.id)).toEqual([
      'am2019x__zz2020y__same_problem',
      ID,
      'he2017drain__zhu2020loghub__replicates',
      'he2017drain__zhu2020loghub__same_problem',
      'he2017drain__zhu2020loghub__uses_method_of'
    ])
    expect(list.find((r) => r.type === 'uses_method_of')).toEqual(confirmed)
    expect(list.find((r) => r.type === 'same_problem' && r.from === DRAIN_ID)).toEqual(fromDrainRun)
    const input = provider.agentCalls[0].input
    expect(input).toContain('- zhu2020loghub contradicts he2017drain (your earlier suggestion')
    expect(input).toContain('- he2017drain same_problem zhu2020loghub (suggested)')
    expect(input).not.toContain('am2019x')
  })

  it('reindexes for the watcher only when relations.yaml changed since its own last write or reindex', async () => {
    const { service, store, cache } = await setupRelations()
    expect(await service.reindexIfChanged()).toBe(false)
    await service.run(LOGHUB_ID, {})
    // Our own write was already reindexed.
    expect(await service.reindexIfChanged()).toBe(false)
    await writeFile(join(store.root, 'relations.yaml'), toYaml({ schema_version: 1, relations: [typedRelation({ status: 'confirmed' })] }))
    expect(await service.reindexIfChanged()).toBe(true)
    expect(cache.typedRelations(LOGHUB_ID)[0].status).toBe('confirmed')
    expect(await service.reindexIfChanged()).toBe(false)
  })

  it('confirms, rejects and undoes through one-use tokens; an undo after a later change is refused', async () => {
    const { service, cache } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    const confirmed = await service.setStatus(ID, 'confirmed')
    expect(cache.typedRelations(LOGHUB_ID)[0]).toMatchObject({ status: 'confirmed', updated_at: NOW })
    expect(cache.getPaper(LOGHUB_ID)?.relations_pending).toBe(0)
    await service.revert(confirmed)
    expect(cache.typedRelations(LOGHUB_ID)[0].status).toBe('suggested')
    await expect(service.revert(confirmed)).rejects.toBeInstanceOf(InvalidEdit)
    const rejected = await service.setStatus(ID, 'rejected')
    await service.setStatus(ID, 'suggested')
    await expect(service.revert(rejected)).rejects.toBeInstanceOf(InvalidEdit)
    await expect(service.setStatus('he2017drain__zhu2020loghub__replicates', 'confirmed')).rejects.toBeInstanceOf(InvalidEdit)
    await expect(service.revert('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(InvalidEdit)
  })

  it('changes the type, the direction and the justification; the old type never comes back', async () => {
    const { service, cache } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    const retyped = await service.changeType(ID, 'uses_method_of')
    const UMO = 'he2017drain__zhu2020loghub__uses_method_of'
    expect(cache.typedRelations(LOGHUB_ID)).toEqual([expect.objectContaining({ id: UMO, status: 'confirmed', edited: true, replaced: [ID] })])
    await service.reverse(UMO)
    expect(cache.typedRelations(LOGHUB_ID)[0]).toMatchObject({ from: DRAIN_ID, to: LOGHUB_ID })
    await service.editJustification(UMO, 'Drain reuses Loghub.')
    expect(cache.typedRelations(LOGHUB_ID)[0].justification).toBe('Drain reuses Loghub.')
    await expect(service.reverse(UMO).then(() => service.changeType(UMO, 'uses_method_of'))).rejects.toBeInstanceOf(InvalidEdit)
    await service.run(LOGHUB_ID, { force: true })
    expect(cache.typedRelations(LOGHUB_ID).map((r) => r.id)).toEqual([UMO])
    expect(typeof retyped).toBe('string')
  })

  it("auto-suggests only when enabled, for a summarized paper with citations and new candidates, in the day's auto batch", async () => {
    const { service, store, cache, enqueued } = await setupRelations()
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([])
    await store.updateConfig({ llm: { ...store.config.llm, auto_suggest_relations: true } })
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([])
    cache.setSummaryState(LOGHUB_ID, 'generated', 3, '', 'm')
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([{ type: 'suggest_relations', paperId: LOGHUB_ID, batchId: 'auto-2026-10-10' }])
    enqueued.length = 0
    await service.run(LOGHUB_ID, { batchId: 'auto-2026-10-10' })
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([])
  })

  it('does not auto-retry a paper whose analysis failed in the last 24 hours; the user can still ask', async () => {
    let now = new Date(NOW)
    const { service, store, cache, enqueued } = await setupRelations({ agent: [new LlmError('llm_timeout', 0.5, { estimated: true }), agentResult()], now: () => now })
    await store.updateConfig({ llm: { ...store.config.llm, auto_suggest_relations: true } })
    cache.setSummaryState(LOGHUB_ID, 'generated', 3, '', 'm')
    await expect(service.run(LOGHUB_ID, { batchId: 'auto-2026-10-10' })).rejects.toMatchObject({ code: 'llm_timeout' })
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([])
    await service.request(LOGHUB_ID, { force: true })
    expect(enqueued).toEqual([{ type: 'suggest_relations', paperId: LOGHUB_ID, force: true }])
    enqueued.length = 0
    now = new Date(Date.parse(NOW) + 25 * 3600_000)
    await service.autoAfter(LOGHUB_ID)
    expect(enqueued).toEqual([{ type: 'suggest_relations', paperId: LOGHUB_ID, batchId: 'auto-2026-10-11' }])
  })

  it('plans and queues a batch, and never analyzes the same pair twice from both sides unless forced', async () => {
    const { service, enqueued, provider } = await setupRelations()
    expect(await service.plan()).toEqual({ count: 2, estimateUsd: 0.5, batchLimitUsd: 10 })
    const { batchId, count } = await service.requestBatch()
    expect(count).toBe(2)
    expect(enqueued.map((s) => s.type === 'suggest_relations' && [s.paperId, s.batchId]).sort()).toEqual([
      [DRAIN_ID, batchId],
      [LOGHUB_ID, batchId]
    ])
    await service.run(LOGHUB_ID, { batchId })
    expect(await service.run(DRAIN_ID, { batchId })).toEqual({ paperId: DRAIN_ID, message: 'relations_no_candidates' })
    expect(provider.agentCalls).toHaveLength(1)
    expect((await service.plan()).count).toBe(0)
    await service.run(DRAIN_ID, { force: true })
    expect(provider.agentCalls).toHaveLength(2)
  })

  it('stops its batch when the quota runs out, but not when one paper hits its own cap', async () => {
    const quota = await setupRelations({ agent: [new LlmError('llm_quota')] })
    await expect(quota.service.run(LOGHUB_ID, { batchId: 'b1' })).rejects.toMatchObject({ code: 'llm_quota' })
    expect(quota.cancelled).toEqual(['b1'])
    const capped = await setupRelations({ agent: [new LlmError('operation_budget', 0.5)] })
    await expect(capped.service.run(LOGHUB_ID, { batchId: 'b2' })).rejects.toMatchObject({ code: 'operation_budget' })
    expect(capped.cancelled).toEqual([])
  })

  it("an unforced re-analysis that skips a covered pair keeps the paper's own earlier suggestion for that pair", async () => {
    const drainComparesLoghub = { ...LOGHUB_EXTENDS_DRAIN, from: DRAIN_ID, to: LOGHUB_ID, type: 'compares_with' }
    const { service, store, cache, provider } = await setupRelations({ agent: [agentResult([drainComparesLoghub]), agentResult([])] })
    // A third paper that cites Drain: Drain still has a candidate once its pair with Loghub is covered.
    const third = samplePaper({ id: 'am2019third', title: 'Third', identifiers: {}, citations: { source: 'openalex', fetched_at: NOW, openalex_id: 'W1', references: ['W2754665629'], cited_by_count: 0 } })
    await store.writePaper(third, null)
    cache.upsertPaper(third, 'h', false)
    cache.setText('am2019third', 't', 'ok', [{ index: 0, page: 1, text: 'Third.' }])
    await service.run(DRAIN_ID, {})
    const X = 'he2017drain__zhu2020loghub__compares_with'
    expect(cache.typedRelations(DRAIN_ID).map((r) => r.id)).toEqual([X])
    await service.run(LOGHUB_ID, { force: true })
    await service.run(DRAIN_ID, {})
    const last = provider.agentCalls.at(-1)!
    expect(last.input).not.toContain('id: zhu2020loghub')
    expect(last.input).toContain('- he2017drain compares_with zhu2020loghub (suggested)')
    expect(last.input).not.toContain('your earlier suggestion')
    const read = await store.readRelations()
    expect(read?.ok && read.value.relations.map((r) => r.id)).toEqual([X])
  })

  it('analyzes a paper without candidates without calling Claude, and records it', async () => {
    const { service, store, cache, provider } = await setupRelations()
    const solo = samplePaper({ id: 'am2019solo', title: 'Solo', identifiers: {} })
    await store.writePaper(solo, null)
    cache.upsertPaper(solo, 'h', false)
    cache.setText('am2019solo', 't', 'ok', [{ index: 0, page: 1, text: 'Alone.' }])
    expect(await service.run('am2019solo', {})).toEqual({ paperId: 'am2019solo', message: 'relations_no_candidates' })
    expect(provider.agentCalls).toHaveLength(0)
    const read = await store.readRelations()
    expect(read?.ok && read.value.analyzed.am2019solo).toEqual({ candidates: [], at: NOW })
  })

  it('never touches a relations.yaml with conflict markers until it is resolved', async () => {
    const { service, store, provider } = await setupRelations()
    const ours = typedRelation({ status: 'confirmed', updated_at: '2026-10-10T13:00:00.000Z' })
    const theirs = typedRelation({ from: DRAIN_ID, to: LOGHUB_ID, type: 'same_problem' })
    const text = `<<<<<<< HEAD\n${toYaml({ schema_version: 1, relations: [ours] })}=======\n${toYaml({ schema_version: 1, relations: [theirs] })}>>>>>>> origin/main\n`
    await writeFile(join(store.root, 'relations.yaml'), text)
    await service.reindex()
    expect(service.fileState()).toEqual({ status: 'conflict' })
    await expect(service.run(LOGHUB_ID, {})).rejects.toMatchObject({ code: 'relations_conflict' })
    await expect(service.setStatus(ours.id, 'rejected')).rejects.toMatchObject({ code: 'relations_conflict' })
    await expect(service.request(LOGHUB_ID)).rejects.toMatchObject({ code: 'relations_conflict' })
    expect(provider.agentCalls).toHaveLength(0)
    expect(await readFile(join(store.root, 'relations.yaml'), 'utf8')).toBe(text)
    expect(await service.resolveConflict()).toEqual({ dropped: 0 })
    expect(service.fileState()).toEqual({ status: 'ok' })
    expect(service.forPaper(LOGHUB_ID).confirmed.map((r) => r.id)).toEqual([ours.id])
    expect(service.forPaper(LOGHUB_ID).suggested.map((r) => r.id)).toEqual([theirs.id])
  })

  it('lists suggestions as review items under the first of their papers in the given order', async () => {
    const { service } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    expect(
      service.reviewItems([
        { id: LOGHUB_ID, title: 'L' },
        { id: DRAIN_ID, title: 'D' }
      ])
    ).toEqual([{ paperId: LOGHUB_ID, title: 'L', section: 'relation', key: ID }])
    expect(service.reviewItems([{ id: DRAIN_ID, title: 'D' }])).toEqual([{ paperId: DRAIN_ID, title: 'D', section: 'relation', key: ID }])
  })

  it('a suggestion the user restores or un-confirms survives a new analysis of its paper', async () => {
    const { service, cache } = await setupRelations({ agent: [agentResult(), agentResult([]), agentResult([])] })
    await service.run(LOGHUB_ID, {})
    await service.setStatus(ID, 'rejected')
    await service.setStatus(ID, 'suggested')
    expect(cache.typedRelations(LOGHUB_ID)[0]).toMatchObject({ status: 'suggested', edited: false })
    expect(cache.typedRelations(LOGHUB_ID)[0].origin).toEqual({ model: 'claude-sonnet-5', at: NOW, prompt_version: 1 })
    await service.run(LOGHUB_ID, {})
    expect(cache.typedRelations(LOGHUB_ID).map((r) => r.id)).toEqual([ID])
    await service.revert(await service.setStatus(ID, 'confirmed'))
    expect(cache.typedRelations(LOGHUB_ID)[0]).toMatchObject({ status: 'suggested', edited: false })
    await service.run(LOGHUB_ID, {})
    expect(cache.typedRelations(LOGHUB_ID).map((r) => r.id)).toEqual([ID])
  })

  it('an unreviewed suggestion left as the analysis wrote it is still replaced by a new analysis of its paper', async () => {
    const { service, cache } = await setupRelations({ agent: [agentResult(), agentResult([])] })
    await service.run(LOGHUB_ID, {})
    await service.run(LOGHUB_ID, {})
    expect(cache.typedRelations(LOGHUB_ID)).toEqual([])
  })

  it('refuses an undo when the entry was changed outside the app, even with the same status and timestamp', async () => {
    const { service, store } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    const token = await service.setStatus(ID, 'confirmed')
    const read = await store.readRelations()
    if (!read?.ok) throw new Error('unreadable')
    const relations = read.value.relations.map((r) => ({ ...r, justification: 'Changed on another machine.' }))
    await store.writeRelations({ ...read.value, relations }, read.hash)
    await service.reindex()
    await expect(service.revert(token)).rejects.toBeInstanceOf(InvalidEdit)
  })

  it('keeps the undo token when the undo fails for a transient reason, so it can be retried', async () => {
    const { service, store, cache } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    const token = await service.setStatus(ID, 'confirmed')
    const path = join(store.root, 'relations.yaml')
    const clean = await readFile(path, 'utf8')
    await writeFile(path, `<<<<<<< HEAD\n${clean}=======\n${clean}>>>>>>> origin/main\n`)
    await service.reindex()
    await expect(service.revert(token)).rejects.toMatchObject({ code: 'relations_conflict' })
    await writeFile(path, clean)
    await service.reindex()
    await service.revert(token)
    expect(cache.typedRelations(LOGHUB_ID)[0].status).toBe('suggested')
    await expect(service.revert(token)).rejects.toBeInstanceOf(InvalidEdit)
  })

  it('resolves only the conflicted text it last read, never a newer one', async () => {
    const { service, store } = await setupRelations()
    const ours = typedRelation({ status: 'confirmed', updated_at: '2026-10-10T13:00:00.000Z' })
    const theirs = typedRelation({ from: DRAIN_ID, to: LOGHUB_ID, type: 'same_problem' })
    const conflicted = (b: object[]) => `<<<<<<< HEAD\n${toYaml({ schema_version: 1, relations: [ours] })}=======\n${toYaml({ schema_version: 1, relations: b })}>>>>>>> origin/main\n`
    const path = join(store.root, 'relations.yaml')
    await writeFile(path, conflicted([]))
    await service.reindex()
    const newer = conflicted([theirs])
    await writeFile(path, newer)
    await expect(service.resolveConflict()).rejects.toMatchObject({ code: 'conflict', cause: expect.any(ConflictError) })
    expect(await readFile(path, 'utf8')).toBe(newer)
    expect(service.fileState()).toEqual({ status: 'conflict' })
    // The refusal re-read the file: what is shown now is what gets resolved.
    expect(await service.resolveConflict()).toEqual({ dropped: 0 })
    expect(service.forPaper(LOGHUB_ID).suggested.map((r) => r.id)).toEqual([theirs.id])
  })

  it('refuses to resolve a file that has no conflict', async () => {
    const { service, store } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    const before = await readFile(join(store.root, 'relations.yaml'), 'utf8')
    await expect(service.resolveConflict()).rejects.toMatchObject({ code: 'relations_conflict' })
    expect(await readFile(join(store.root, 'relations.yaml'), 'utf8')).toBe(before)
  })

  it('lists each suggestion once when a paper appears twice in the order', async () => {
    const { service } = await setupRelations()
    await service.run(LOGHUB_ID, {})
    expect(
      service.reviewItems([
        { id: LOGHUB_ID, title: 'L' },
        { id: DRAIN_ID, title: 'D' },
        { id: LOGHUB_ID, title: 'L again' }
      ])
    ).toEqual([{ paperId: LOGHUB_ID, title: 'L', section: 'relation', key: ID }])
  })
})
