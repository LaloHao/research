import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatActions, type ChatActionsDeps } from '../../../src/main/chats/ChatActions'
import type { ConflictItem, SyncResult } from '../../../src/shared/sync'
import type { FetchFn } from '../../../src/main/ingest/http'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { routeFetch, type Route } from '../../helpers/fakeFetch'
import { newValueSuggestion } from '../../helpers/facets'
import { FakeLlmProvider } from '../../helpers/llm'
import { DRAIN_ID, drainPaper, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { makePdf } from '../../helpers/pdf'
import { typedRelation } from '../../helpers/relations'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const DRAIN_ROUTES: Route[] = [
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/vnd.citationstyles.csl+json', body: fx('drain.csl.json') },
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/x-bibtex', body: fx('drain.bib') },
  { url: 'https://api.openalex.org/works/doi:10.1109/icws.2017.13', body: fx('drain.openalex.json') }
]

/** A session (fake Claude, no network beyond `fetch`), Drain and Loghub in the library unless `seed` is false, and its actions. */
async function setup(opts: { fetch?: FetchFn; seed?: boolean } = {}) {
  const s = await ProjectSession.create(await tmpDir(), 'Thesis', {
    contactEmail: '',
    watch: false,
    citationPauseMs: 0,
    fetch: opts.fetch ?? routeFetch([]),
    llm: new FakeLlmProvider([])
  })
  if (opts.seed !== false) await seedPair(s.store, s.cache)
  /** The trash reads that went through the session (which tracks them, so closing waits for them). */
  const tracked: string[] = []
  const actions = new ChatActions({
    store: s.store,
    cache: s.cache,
    listTrash: () => (tracked.push('listTrash'), s.listTrash()),
    deletePlan: (ids) => (tracked.push('deletePlan'), s.deletePlan(ids)),
    queue: s.queue,
    summaries: s.summaries,
    relations: s.relations,
    facets: s.facets,
    sync: s.sync,
    estimate: () => 0.05,
    trash: (ids) => s.trash(ids),
    restore: (ids, o) => s.restore(ids, o),
    deleteForever: (ids) => s.deleteForever(ids),
    now: () => new Date('2026-10-12T10:00:00.000Z'),
    jobWaitMs: 5000
  })
  return { s, actions, tracked }
}

const toolError = { name: 'ToolError' }

describe('ChatActions', () => {
  it('appends a note and takes it back only while the notes are as it left them', async () => {
    const { s, actions } = await setup()
    await s.store.writeNotes(DRAIN_ID, 'Mine.\n', null)
    const p = await actions.prepare('write_note', { paper_id: DRAIN_ID, text: 'Parses online.', request_quote: 'add a note' })
    expect(p).toMatchObject({
      tool: 'write_note',
      args: { paper_id: DRAIN_ID, text: 'Parses online.' },
      risk: null,
      pickPdf: false,
      preview: { papers: [{ id: DRAIN_ID, title: drainPaper().title }], cost: null }
    })
    expect(p.args).not.toHaveProperty('request_quote')
    const done = await p.execute({})
    expect((await s.store.readNotes(DRAIN_ID)).text).toBe('Mine.\n\n### Claude — 2026-10-12\n\nParses online.\n')
    await done.undo!()
    expect((await s.store.readNotes(DRAIN_ID)).text).toBe('Mine.\n')
    const again = await (await actions.prepare('write_note', { paper_id: DRAIN_ID, text: 'Second.' })).execute({})
    await s.store.writeNotes(DRAIN_ID, 'Edited by hand.\n', (await s.store.readNotes(DRAIN_ID)).hash)
    await expect(again.undo!()).rejects.toMatchObject({ name: 'InvalidEdit' })
    await expect(actions.prepare('write_note', { paper_id: 'gone2020x', text: 'x' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('write_note', { paper_id: DRAIN_ID })).rejects.toMatchObject(toolError)
    await s.close()
  })

  it('decides a relation through the review service and undoes it with its token', async () => {
    const { s, actions } = await setup()
    await s.store.writeRelations({ schema_version: 1, relations: [typedRelation()], analyzed: {} }, null)
    await s.relations.reindex()
    const id = typedRelation().id
    expect(await actions.read('list_relations', { paper_id: DRAIN_ID })).toMatchObject({
      suggested: [{ id, type: 'extends', from: LOGHUB_ID, to: DRAIN_ID }],
      confirmed: []
    })
    const p = await actions.prepare('decide_relation', { relation_id: id, decision: 'confirm' })
    expect(p.preview.papers.map((x) => x.id)).toEqual([DRAIN_ID, LOGHUB_ID])
    const done = await p.execute({})
    expect(s.relations.forPaper(DRAIN_ID).confirmed.map((r) => r.id)).toEqual([id])
    await done.undo!()
    expect(s.relations.forPaper(DRAIN_ID).suggested.map((r) => r.id)).toEqual([id])
    await expect(actions.prepare('decide_relation', { relation_id: id, decision: 'change_type' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('decide_relation', { relation_id: 'he2017drain__zhu2020loghub__contradicts', decision: 'reject' })).rejects.toMatchObject(
      toolError
    )
    await s.close()
  })

  it('moves papers to the trash and back, restores them, and plans a deletion for good with its relations', async () => {
    const { s, actions } = await setup()
    await s.store.writeRelations({ schema_version: 1, relations: [typedRelation()], analyzed: {} }, null)
    await s.relations.reindex()
    const trash = await actions.prepare('trash_papers', { paper_ids: [DRAIN_ID] })
    expect(trash).toMatchObject({ risk: 'removes', preview: { papers: [{ id: DRAIN_ID }] } })
    const moved = await trash.execute({})
    expect(moved.result).toEqual({ moved: [DRAIN_ID] })
    expect(s.store.trashExists(DRAIN_ID)).toBe(true)
    await moved.undo!()
    expect(s.store.paperExists(DRAIN_ID)).toBe(true)
    await (await actions.prepare('trash_papers', { paper_ids: [DRAIN_ID] })).execute({})
    expect(await actions.read('list_trash', {})).toMatchObject({ total: 1, items: [{ paper_id: DRAIN_ID }], next_offset: null })
    const plan = await actions.prepare('delete_forever', { paper_ids: [DRAIN_ID, LOGHUB_ID] })
    expect(plan).toMatchObject({ risk: 'removes', preview: { papers: [{ id: DRAIN_ID }], relations: 1 } })
    const restore = await actions.prepare('restore_papers', { paper_ids: [DRAIN_ID] })
    expect(restore.risk).toBeNull()
    const back = await restore.execute({})
    expect(back.result).toMatchObject({ restored: [{ paper: DRAIN_ID, key: DRAIN_ID }], conflicts: [], failed: [] })
    await expect(actions.prepare('restore_papers', { paper_ids: [LOGHUB_ID] })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('delete_forever', { paper_ids: [LOGHUB_ID] })).rejects.toMatchObject(toolError)
    await back.undo!()
    expect(s.store.trashExists(DRAIN_ID)).toBe(true)
    expect(await (await actions.prepare('delete_forever', { paper_ids: [DRAIN_ID] })).execute({})).toMatchObject({ result: { deleted: 1 }, undo: null })
    await s.close()
  })

  it('prices what spends money with the caps that bound it, and queues it as one batch', async () => {
    const { s, actions } = await setup()
    // Nothing runs: only what is queued is checked.
    await s.queue.stop()
    await s.store.updateConfig({ llm: { ...s.store.config.llm, budget: { ...s.store.config.llm.budget, per_month_usd: 20 } } })
    const p = await actions.prepare('summarize', { paper_ids: [DRAIN_ID, LOGHUB_ID] })
    expect(p).toMatchObject({
      risk: 'spends',
      preview: { cost: { count: 2, estimateUsd: 0.1, perOperationUsd: 0.5, batchCapUsd: 10, monthSpentUsd: 0, monthCapUsd: 20 } }
    })
    const done = await p.execute({})
    expect(done).toMatchObject({ result: { queued: 2 }, undo: null })
    const batches = s.queue.list().flatMap((j) => (j.spec.type === 'summarize' ? [j.spec.batchId] : []))
    expect(batches).toEqual([done.result.batch, done.result.batch])
    const relations = await actions.prepare('suggest_relations', { paper_ids: [DRAIN_ID] })
    expect(relations.preview.cost).toMatchObject({ count: 1, estimateUsd: 0.05, batchCapUsd: 10 })
    await relations.execute({})
    expect(s.queue.list().some((j) => j.spec.type === 'suggest_relations' && j.spec.force === true)).toBe(true)
    expect(await actions.prepare('suggest_facets', {})).toMatchObject({
      risk: 'spends',
      preview: { cost: { count: 1, perOperationUsd: 2, batchCapUsd: null } }
    })
    await expect(actions.prepare('fill_facets', {})).rejects.toMatchObject(toolError)
    await s.close()
  })

  it('adds a paper, reports its key and undoes it by moving it to the trash; with automatic summaries on it spends', async () => {
    const { s, actions } = await setup({ fetch: routeFetch(DRAIN_ROUTES), seed: false })
    const p = await actions.prepare('add_paper', { identifier: '10.1109/ICWS.2017.13', request_quote: 'agrega el paper de Drain' })
    expect(p).toMatchObject({ risk: null, args: { identifier: '10.1109/ICWS.2017.13' }, preview: { papers: [], cost: null } })
    const done = await p.execute({})
    expect(done.result).toEqual({ paper: DRAIN_ID, outcome: 'added' })
    await done.undo!()
    expect(s.store.trashExists(DRAIN_ID)).toBe(true)
    await expect(actions.prepare('add_paper', { identifier: 'not an identifier' })).rejects.toMatchObject(toolError)
    await s.store.updateConfig({ llm: { ...s.store.config.llm, auto_summarize: true } })
    expect(await actions.prepare('add_paper', { identifier: 'arXiv:2008.06448' })).toMatchObject({
      risk: 'spends',
      preview: { cost: { count: 1, estimateUsd: 0.05 } }
    })
    await s.close()
  })

  it('adds the identifier it is given at execution (the one the user typed) instead of the prepared one', async () => {
    const { s, actions } = await setup({ fetch: routeFetch(DRAIN_ROUTES), seed: false })
    const p = await actions.prepare('add_paper', { identifier: '10.1109/icws.2017.99' })
    expect((await p.execute({ identifier: '10.1109/ICWS.2017.13' })).result).toEqual({ paper: DRAIN_ID, outcome: 'added' })
    await s.close()
  })

  it('attaches only the PDF the user picked, and syncs only a project set up for it', async () => {
    const { s, actions } = await setup()
    const p = await actions.prepare('attach_pdf', { paper_id: DRAIN_ID })
    expect(p).toMatchObject({ risk: 'file', pickPdf: true, preview: { replacesPdf: false } })
    const pdf = join(await tmpDir(), 'drain.pdf')
    await writeFile(pdf, await makePdf([['Drain parses log messages online.']]))
    expect((await p.execute({ pdfPath: pdf })).result).toEqual({ paper: DRAIN_ID, outcome: 'pdf_attached' })
    await expect(actions.prepare('attach_pdf', { paper_id: DRAIN_ID })).rejects.toMatchObject(toolError)
    expect(await actions.prepare('attach_pdf', { paper_id: DRAIN_ID, replace: true })).toMatchObject({ preview: { replacesPdf: true } })
    expect(await actions.read('sync_status', {})).not.toMatchObject({ setup: 'ready' })
    await expect(actions.prepare('sync_now', {})).rejects.toMatchObject(toolError)
    await expect(actions.prepare('resolve_sync_conflicts', { choices: [{ id: 'file:project.yaml', choice: 'ours' }] })).rejects.toMatchObject(toolError)
    await s.close()
  })

  it('reviews and edits a summary and decides a facet suggestion, each with its undo', async () => {
    const { s, actions } = await setup()
    await s.summaries.ensureForm()
    await s.store.writeSummary(DRAIN_ID, sampleSummary(), '# Drain\n', null)
    const tldr = async () => {
      const r = await s.store.readSummary(DRAIN_ID)
      return r?.ok ? r.value.fields.tldr : null
    }
    const verified = await (await actions.prepare('review_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', status: 'verified' })).execute({})
    expect((await tldr())?.status).toBe('verified')
    await verified.undo!()
    expect((await tldr())?.status).toBe('generated')
    const edited = await (await actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: 'In my words.' })).execute({})
    expect(await tldr()).toMatchObject({ value: 'In my words.', status: 'edited' })
    await edited.undo!()
    expect(await tldr()).toMatchObject({ value: 't', status: 'generated' })
    await expect(actions.prepare('review_summary', { paper_id: DRAIN_ID, status: 'generated' })).rejects.toMatchObject(toolError)

    await s.store.writeFacetSuggestions({ schema_version: 1, suggestions: [newValueSuggestion()] }, null)
    await s.facets.reindex()
    expect(await actions.read('list_facet_suggestions', {})).toMatchObject({
      items: [{ id: 'new_value__data_type__metrics', status: 'suggested', validity: 'ok' }]
    })
    const values = (): string[] => {
      const info = s.summaries.formInfo()
      const facet = info.status === 'ok' ? info.form.facets.find((f) => f.key === 'data_type') : undefined
      return facet && 'values' in facet ? facet.values : []
    }
    const accepted = await (
      await actions.prepare('decide_facet_suggestion', { suggestion_id: 'new_value__data_type__metrics', decision: 'accept' })
    ).execute({})
    expect(values()).toContain('metrics')
    await accepted.undo!()
    expect(values()).not.toContain('metrics')
    await expect(actions.prepare('decide_facet_suggestion', { suggestion_id: 'new_value__data_type__other', decision: 'reject' })).rejects.toMatchObject(
      toolError
    )
    await s.close()
  })
  it('refuses before asking an edit the summary would refuse, and keys that are not facet keys', async () => {
    const { s, actions } = await setup()
    await s.summaries.ensureForm()
    await expect(actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: 'No summary yet.' })).rejects.toMatchObject(
      toolError
    )
    await s.store.writeSummary(DRAIN_ID, sampleSummary(), '# Drain\n', null)
    await expect(actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: 42 })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'nonsense', value: 'x' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: 'x'.repeat(30_000) })).rejects.toMatchObject(
      toolError
    )
    await expect(
      actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'facets', key: 'Data-Type', value: { values: ['logs'] } })
    ).rejects.toMatchObject(toolError)
    await expect(
      actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'facets', key: 'data_type', value: { values: ['logs'] } })
    ).rejects.toMatchObject(toolError)
    await s.store.writeExtraction(DRAIN_ID, sampleExtraction(), null)
    await expect(
      actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'facets', key: 'data_type', value: { values: ['not_allowed'] } })
    ).rejects.toMatchObject(toolError)
    const ok = await actions.prepare('edit_summary', { paper_id: DRAIN_ID, section: 'facets', key: 'data_type', value: { values: ['logs'] } })
    expect(ok).toMatchObject({ risk: 'edits', args: { key: 'data_type', value: { values: ['logs'] } } })
    await expect(actions.prepare('review_summary', { paper_id: DRAIN_ID, section: 'facets', key: 'Data-Type', status: 'verified' })).rejects.toMatchObject(
      toolError
    )
    await expect(actions.prepare('review_summary', { paper_id: DRAIN_ID, section: 'fields', key: 'nonsense', status: 'verified' })).rejects.toMatchObject(
      toolError
    )
    await s.close()
  })

  it('accepts a value papers proposed, only one that some paper proposed, and puts the form back on undo', async () => {
    const { s, actions } = await setup()
    await s.summaries.ensureForm()
    await s.store.writeExtraction(
      DRAIN_ID,
      sampleExtraction({ data_type: { values: ['logs'], proposed: ['metrics'], status: 'generated', evidence: [] } }),
      null
    )
    const allowed = (): string[] => {
      const info = s.summaries.formInfo()
      const facet = info.status === 'ok' ? info.form.facets.find((f) => f.key === 'data_type') : undefined
      return facet && 'values' in facet ? facet.values : []
    }
    await expect(actions.prepare('resolve_proposed_value', { facet: 'Data-Type', value: 'metrics', decision: 'accept' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('resolve_proposed_value', { facet: 'data_type', value: 'metrics', decision: 'map', to: 'Logs!' })).rejects.toMatchObject(
      toolError
    )
    await expect(actions.prepare('resolve_proposed_value', { facet: 'data_type', value: 'metrics', decision: 'map', to: 'nonexistent' })).rejects.toMatchObject(
      toolError
    )
    await expect(actions.prepare('resolve_proposed_value', { facet: 'data_type', value: 'nobody_proposed', decision: 'accept' })).rejects.toMatchObject(
      toolError
    )
    await expect(actions.prepare('resolve_proposed_value', { facet: 'relevance', value: 'metrics', decision: 'accept' })).rejects.toMatchObject(toolError)
    const p = await actions.prepare('resolve_proposed_value', { facet: 'data_type', value: 'metrics', decision: 'accept' })
    expect(p).toMatchObject({ risk: 'edits', preview: { papers: [{ id: DRAIN_ID }] } })
    const done = await p.execute({})
    expect(allowed()).toContain('metrics')
    await done.undo!()
    expect(allowed()).not.toContain('metrics')
    await s.close()
  })

  it('names each paper once, and refuses decisions that would change nothing', async () => {
    const { s, actions } = await setup()
    await s.queue.stop()
    const p = await actions.prepare('summarize', { paper_ids: [DRAIN_ID, DRAIN_ID] })
    expect(p).toMatchObject({ args: { paper_ids: [DRAIN_ID] }, preview: { papers: [{ id: DRAIN_ID }], cost: { count: 1 } } })
    expect(p.preview.papers).toHaveLength(1)
    expect((await actions.prepare('trash_papers', { paper_ids: [DRAIN_ID, DRAIN_ID] })).args).toEqual({ paper_ids: [DRAIN_ID] })

    await s.store.writeRelations({ schema_version: 1, relations: [typedRelation()], analyzed: {} }, null)
    await s.relations.reindex()
    const id = typedRelation().id
    await expect(actions.prepare('decide_relation', { relation_id: id, decision: 'back_to_suggested' })).rejects.toMatchObject(toolError)
    await expect(actions.prepare('decide_relation', { relation_id: id, decision: 'change_type', type: typedRelation().type })).rejects.toMatchObject(toolError)

    await s.store.writeFacetSuggestions({ schema_version: 1, suggestions: [newValueSuggestion()] }, null)
    await s.facets.reindex()
    await expect(actions.prepare('decide_facet_suggestion', { suggestion_id: 'new_value__data_type__metrics', decision: 'restore' })).rejects.toMatchObject(
      toolError
    )
    await s.close()
  })

  it('refuses to take back a trashing once the paper left the trash some other way', async () => {
    const { s, actions } = await setup()
    const moved = await (await actions.prepare('trash_papers', { paper_ids: [DRAIN_ID] })).execute({})
    await s.restore([DRAIN_ID], { merge: false })
    await expect(moved.undo!()).rejects.toMatchObject({ name: 'InvalidEdit' })
    const back = await (await actions.prepare('trash_papers', { paper_ids: [DRAIN_ID] })).execute({})
    const restored = await (await actions.prepare('restore_papers', { paper_ids: [DRAIN_ID] })).execute({})
    await s.trash([DRAIN_ID])
    await expect(restored.undo!()).rejects.toMatchObject({ name: 'InvalidEdit' })
    expect(back.undo).not.toBeNull()
    await s.close()
  })

  it('never keeps the picked PDF path in what it records, even when the attachment fails', async () => {
    const { s, actions } = await setup()
    const dir = await tmpDir()
    const bad = join(dir, 'secret-folder-name.pdf')
    await writeFile(bad, 'not a pdf')
    const p = await actions.prepare('attach_pdf', { paper_id: DRAIN_ID, path: bad } as Record<string, unknown>)
    expect(JSON.stringify(p.args)).not.toContain(dir)
    const error = await p.execute({ pdfPath: bad }).then(
      () => null,
      (e: unknown) => e
    )
    expect(error).toMatchObject({ name: 'UserFacingError' })
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(dir)
    await expect(p.execute({})).rejects.toMatchObject({ name: 'UserFacingError' })
    await s.close()
  })

  it('resolves only the conflicts the sync lists now, each bound to the version it listed', async () => {
    const { s } = await setup()
    const conflict: ConflictItem = {
      id: 'file:papers/he2017drain/notes.md',
      kind: 'file',
      path: 'papers/he2017drain/notes.md',
      paperId: DRAIN_ID,
      paperTitle: 'Drain',
      ours: 'modified',
      theirs: 'modified',
      version: 'v1'
    }
    const resolved: unknown[] = []
    let listed = [conflict]
    const sync = {
      status: async () => ({ setup: 'ready' }),
      conflicts: async () => listed,
      resolve: async (choices: unknown): Promise<SyncResult> => {
        resolved.push(choices)
        return { ok: true, outcome: 'synced' }
      }
    } as unknown as ChatActionsDeps['sync']
    const actions = new ChatActions({
      store: s.store,
      cache: s.cache,
      listTrash: () => s.listTrash(),
      deletePlan: (ids) => s.deletePlan(ids),
      queue: s.queue,
      summaries: s.summaries,
      relations: s.relations,
      facets: s.facets,
      sync,
      estimate: () => 0.05,
      trash: (ids) => s.trash(ids),
      restore: (ids, o) => s.restore(ids, o),
      deleteForever: (ids) => s.deleteForever(ids)
    })
    await expect(actions.prepare('resolve_sync_conflicts', { choices: [{ id: 'file:papers/other/notes.md', choice: 'ours' }] })).rejects.toMatchObject(
      toolError
    )
    await expect(
      actions.prepare('resolve_sync_conflicts', {
        choices: [
          { id: conflict.id, choice: 'ours' },
          { id: conflict.id, choice: 'theirs' }
        ]
      })
    ).rejects.toMatchObject(toolError)
    const p = await actions.prepare('resolve_sync_conflicts', { choices: [{ id: conflict.id, choice: 'theirs' }] })
    expect(p).toMatchObject({ risk: 'sync', preview: { conflicts: [{ path: conflict.path, choice: 'theirs' }] } })
    expect(await p.execute({})).toMatchObject({ result: { outcome: 'synced' }, undo: null })
    expect(resolved).toEqual([{ [conflict.id]: { choice: 'theirs', version: 'v1' } }])
    // Resolved elsewhere before the approval: it never turns into a whole sync.
    const late = await actions.prepare('resolve_sync_conflicts', { choices: [{ id: conflict.id, choice: 'ours' }] })
    listed = []
    await expect(late.execute({})).rejects.toMatchObject({ code: 'conflict' })
    expect(resolved).toHaveLength(1)
    await s.close()
  })
  it('runs what it checked and showed, whatever happens to the call object afterwards', async () => {
    const { s, actions } = await setup()
    await s.store.writeSummary(DRAIN_ID, sampleSummary(), '# Drain\n', null)
    const call = { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: { stated: [] } as unknown }
    await expect(actions.prepare('edit_summary', call)).rejects.toMatchObject(toolError)
    const edit = { paper_id: DRAIN_ID, section: 'fields', key: 'limitations', value: { stated: ['Checked.'], inferred: [] } }
    const p = await actions.prepare('edit_summary', edit)
    edit.value.stated.push('Smuggled.')
    ;(p.args.value as { stated: string[] }).stated.push('Smuggled too.')
    await p.execute({})
    const r = await s.store.readSummary(DRAIN_ID)
    expect(r?.ok ? r.value.fields.limitations.value : null).toEqual({ stated: ['Checked.'], inferred: [] })
    await s.close()
  })
  it('queues exactly the papers the card listed, and says how many jobs it really queued', async () => {
    const { s, actions } = await setup()
    await s.queue.stop()
    await s.summaries.request(LOGHUB_ID)
    const busy = s.queue.list().find((j) => j.spec.type === 'summarize')!
    const p = await actions.prepare('summarize', { paper_ids: [DRAIN_ID, LOGHUB_ID] })
    expect(p.preview).toMatchObject({ papers: [{ id: DRAIN_ID }], cost: { count: 1 } })
    expect(p.preview.papers).toHaveLength(1)
    s.queue.cancel(busy.id)
    expect(await p.execute({})).toMatchObject({ result: { queued: 1 } })
    const batch = s.queue.list().filter((j) => j.spec.type === 'summarize' && j.state === 'queued')
    expect(batch.map((j) => j.paperId ?? (j.spec as { paperId: string }).paperId)).toEqual([DRAIN_ID])

    const fillPlan = vi.spyOn(s.summaries, 'fillPlan').mockImplementation((ids?: string[]) => {
      const count = ids?.length === 1 && ids[0] === DRAIN_ID ? 1 : ids === undefined ? 1 : 0
      return { count, estimateUsd: count * 0.05, batchLimitUsd: 10 }
    })
    const requestFill = vi.spyOn(s.summaries, 'requestFill').mockImplementation(() => ({ batchId: 'b', count: 1 }))
    const fill = await actions.prepare('fill_facets', {})
    expect(fill.preview).toMatchObject({ papers: [{ id: DRAIN_ID }], cost: { count: 1 } })
    await fill.execute({})
    expect(requestFill).toHaveBeenCalledWith([DRAIN_ID])
    fillPlan.mockRestore()
    requestFill.mockRestore()

    await s.relations.request(LOGHUB_ID, { force: true })
    const relations = await (await actions.prepare('suggest_relations', { paper_ids: [DRAIN_ID, LOGHUB_ID] })).execute({})
    expect(relations.result).toMatchObject({ queued: 1, already_queued: [LOGHUB_ID] })
    await s.close()
  })

  it('reports an attachment without a picked file, and one cancelled in Actividad, as failures', async () => {
    const { s, actions } = await setup()
    await s.queue.stop()
    const p = await actions.prepare('attach_pdf', { paper_id: DRAIN_ID })
    await expect(p.execute({})).rejects.toMatchObject({ code: 'file_problem' })
    const pdf = join(await tmpDir(), 'drain.pdf')
    await writeFile(pdf, await makePdf([['Drain.']]))
    setTimeout(() => s.queue.cancel(s.queue.list().find((j) => j.spec.type === 'attach_pdf')!.id), 20)
    expect(await p.execute({ pdfPath: pdf })).toMatchObject({ result: { state: 'cancelled' }, failed: true, undo: null })
    await s.close()
  })

  it('reads the trash through the session, pages long lists, and fails a deletion that found nothing left', async () => {
    const { s, actions, tracked } = await setup()
    await s.trash([DRAIN_ID, LOGHUB_ID])
    expect(await actions.read('list_trash', { limit: 1 })).toMatchObject({ total: 2, offset: 0, items: [{}], next_offset: 1 })
    const second = (await actions.read('list_trash', { offset: 1, limit: 1 })) as { items: unknown[]; next_offset: number | null }
    expect(second).toMatchObject({ total: 2, offset: 1, next_offset: null })
    expect(second.items).toHaveLength(1)
    const del = await actions.prepare('delete_forever', { paper_ids: [DRAIN_ID] })
    expect(tracked).toEqual(expect.arrayContaining(['listTrash', 'deletePlan']))
    await s.restore([DRAIN_ID], { merge: false })
    expect(await del.execute({})).toMatchObject({ result: { deleted: 0 }, failed: true, undo: null })
    await s.close()
  })

  it('says a relation is out of reach when one of its papers left the library', async () => {
    const { s, actions } = await setup()
    await s.store.writeRelations({ schema_version: 1, relations: [typedRelation()], analyzed: {} }, null)
    await s.relations.reindex()
    await s.trash([LOGHUB_ID])
    await expect(actions.prepare('decide_relation', { relation_id: typedRelation().id, decision: 'confirm' })).rejects.toThrow(/not in the library/)
    await s.close()
  })
})
