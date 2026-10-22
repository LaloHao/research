import { describe, expect, it } from 'vitest'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { waitFor } from '../../helpers/chats'
import { DEVICE } from '../../helpers/chats'
import { DRAFT_AT, DRAFT_ID_A, DRAIN_DRAFT, DRAIN_ID, DRAIN_QUOTE, draftFile, draftInputOf, LOGHUB_ID, LOGHUB_QUOTE, setupDrafts } from '../../helpers/drafts'
import { chatAnswer } from '../../helpers/llm'
import { callTools } from '../../helpers/mcp'

describe('DraftService', () => {
  it('writes a draft through the read-only tools, streams it, verifies its citations and logs its cost as `draft`', async () => {
    const { store, drafts, provider, updates } = await setupDrafts({
      responses: [
        async (req, emit) => {
          const [hit, outside] = await callTools(req.servers[0], [
            { name: 'find_in_paper', arguments: { paper_id: DRAIN_ID, text: 'log messages' } },
            { name: 'read_pages', arguments: { paper_id: LOGHUB_ID, from: 1, to: 1 } }
          ])
          expect(hit.text.startsWith('<library_data>')).toBe(true)
          // The tools reach only the chosen papers.
          expect(outside).toMatchObject({ isError: true })
          expect(outside.text).toContain('not among the papers chosen for this draft')
          emit({ kind: 'turn' })
          emit({ kind: 'tool', name: 'find_in_paper' })
          emit({ kind: 'turn' })
          emit({ kind: 'delta', text: 'Online parsers ' })
          emit({ kind: 'delta', text: 'exist.' })
          return chatAnswer(DRAIN_DRAFT, 0.12)
        }
      ]
    })
    const id = await drafts.run(draftInputOf({ model: 'haiku', length: 'long' }), null)
    expect(id).toBe(DRAFT_ID_A)
    await drafts.idle()
    expect(updates.map((u) => u.kind)).toEqual(['start', 'turn', 'tool', 'turn', 'delta', 'delta', 'done'])
    expect(updates.every((u) => u.draftId === DRAFT_ID_A)).toBe(true)
    const req = provider.chatCalls[0]
    expect(req).toMatchObject({ model: 'haiku', maxUsd: 1, maxTurns: 23, servers: [{ name: 'library' }] })
    expect(req.system).toContain('Write the draft in Spanish')
    expect(req.system).toContain('about 1500 words')
    expect(req.input).toContain(`<paper>\nkey: ${DRAIN_ID}\n`)
    expect(req.input).not.toContain(`key: ${LOGHUB_ID}`)
    expect(req.input.endsWith('<question>\nSection title: Log parsing\nPurpose: Compare online parsers.\n</question>')).toBe(true)
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'draft', cost_usd: 0.12, model: 'claude-sonnet-5', paper_id: '' })])
    const view = await drafts.open(id)
    expect(view).toMatchObject({
      summary: { title: 'Log parsing', versions: 1, papers: 1, costUsd: 0.12, problem: false },
      input: draftInputOf({ model: 'haiku', length: 'long' }),
      versions: [{ text: DRAIN_DRAFT, model: 'claude-sonnet-5', costUsd: 0.12, stopped: false, check: { unverified: 0, outside: 0, uncited: 0 } }],
      partial: null
    })
    expect(view.versions[0].check.citations).toEqual([{ paper: DRAIN_ID, page: 1, quote: DRAIN_QUOTE, state: 'found', outside: false }])
    expect(await store.readDraft(id)).toMatchObject({ ok: true, value: { meta: { updated_on: 'laptop', cost_usd: 0.12 }, texts: [DRAIN_DRAFT] } })
  })

  it('flags citations outside the selection, unverified quotes and claims marked without a citation', async () => {
    const text = `${DRAIN_DRAFT} Loghub collects logs [[${LOGHUB_ID}|p. 1|"${LOGHUB_QUOTE}"]]. Drain is perfect [[${DRAIN_ID}|p. 2|"Drain is perfect"]]. Everyone agrees [[sin cita]].`
    const { drafts } = await setupDrafts({ responses: [chatAnswer(text)] })
    const id = await drafts.run(draftInputOf(), null)
    await drafts.idle()
    const { check } = (await drafts.open(id)).versions[0]
    expect(check).toMatchObject({ unverified: 1, outside: 1, uncited: 1 })
    expect(check.citations.map((c) => [c.paper, c.state, c.outside])).toEqual([
      [DRAIN_ID, 'found', false],
      [LOGHUB_ID, 'found', true],
      [DRAIN_ID, 'not_found', false]
    ])
  })

  it('«Detener» keeps what arrived as a stopped version, charged at the draft cap as an estimate', async () => {
    const { store, drafts, updates } = await setupDrafts({
      responses: [
        (req, emit) =>
          new Promise((_resolve, reject) => {
            emit({ kind: 'turn' })
            emit({ kind: 'delta', text: 'Partial draft' })
            req.signal!.addEventListener('abort', () => reject(Object.assign(new DOMException('aborted', 'AbortError'), { costUsd: req.maxUsd, estimated: true })))
          })
      ]
    })
    const id = await drafts.run(draftInputOf(), null)
    await waitFor(() => updates.some((u) => u.kind === 'delta'))
    expect((await drafts.open(id)).partial).toMatchObject({ text: 'Partial draft', seq: updates.at(-1)?.seq })
    await expect(drafts.edit(id, 'x')).rejects.toMatchObject({ code: 'draft_busy' })
    await expect(drafts.run(draftInputOf(), id)).rejects.toMatchObject({ code: 'draft_busy' })
    drafts.stop(id)
    await drafts.idle()
    expect(updates.at(-1)).toMatchObject({ kind: 'stopped' })
    expect((await drafts.open(id)).versions).toMatchObject([{ text: 'Partial draft', stopped: true, costUsd: 1 }])
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'draft', cost_usd: 1, estimated: true })])
  })

  it('a version cut at its cap says so with the draft cap, and keeps no version', async () => {
    const { store, drafts, updates } = await setupDrafts({ responses: [new LlmError('operation_budget', 1)] })
    await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_draft_usd: 0.4 } } })
    const id = await drafts.run(draftInputOf(), null)
    await drafts.idle()
    expect(updates.at(-1)).toMatchObject({ kind: 'error', error: 'draft_budget' })
    expect((await drafts.open(id)).versions).toEqual([])
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'draft', cost_usd: 1 })])
  })

  it('refuses over the monthly cap before writing anything, and refuses papers outside the library', async () => {
    const { store, drafts, provider } = await setupDrafts()
    await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_month_usd: 1 } } })
    await store.appendCost(DEVICE, { at: DRAFT_AT, paper_id: 'x', batch_id: null, model: 'm', cost_usd: 1, operation: 'summarize' })
    await expect(drafts.run(draftInputOf(), null)).rejects.toMatchObject({ code: 'budget_exceeded' })
    await expect(drafts.run(draftInputOf({ papers: ['gone2020x'] }), null)).rejects.toMatchObject({ code: 'paper_not_in_library' })
    await expect(drafts.run(draftInputOf({ rq: 'RQ9' }), null)).rejects.toMatchObject({ code: 'invalid_edit' })
    expect(await store.listDraftIds()).toEqual([])
    expect(provider.chatCalls).toHaveLength(0)
  })

  it('«Regenerar» writes a new version from the form as it is now and keeps the earlier ones', async () => {
    const { store, drafts, provider } = await setupDrafts({ responses: [chatAnswer('First version.'), chatAnswer('Second version.', 0.05)] })
    const id = await drafts.run(draftInputOf(), null)
    await drafts.idle()
    await drafts.run(draftInputOf({ title: 'Online log parsing', papers: [DRAIN_ID, LOGHUB_ID], length: 'medium' }), id)
    await drafts.idle()
    expect(provider.chatCalls[1].input).toContain(`key: ${LOGHUB_ID}`)
    const view = await drafts.open(id)
    expect(view.versions.map((v) => v.text)).toEqual(['First version.', 'Second version.'])
    expect(view.input).toMatchObject({ title: 'Online log parsing', papers: [DRAIN_ID, LOGHUB_ID], length: 'medium' })
    expect(view.summary.costUsd).toBe(0.07)
    expect(await store.readDraft(id)).toMatchObject({ ok: true, value: { meta: { versions: [{}, {}] } } })
  })

  it('saves an edit of the current version and checks its citations again', async () => {
    const { drafts } = await setupDrafts()
    const id = await drafts.run(draftInputOf(), null)
    await drafts.idle()
    const check = await drafts.edit(id, `${DRAIN_DRAFT}\n\nAlso [[${LOGHUB_ID}|p. 1|"${LOGHUB_QUOTE}"]] and [[${DRAIN_ID}|p. 1|"not in the paper"]].`)
    expect(check).toMatchObject({ unverified: 1, outside: 1 })
    const view = await drafts.open(id)
    expect(view.versions[0]).toMatchObject({ editedAt: DRAFT_AT, check: { unverified: 1, outside: 1 } })
    expect(view.versions[0].text).toContain('Also')
  })

  it('lists, searches, renames, archives and deletes (only when confirmed)', async () => {
    const { store, drafts } = await setupDrafts()
    await store.writeDraft(draftFile(['A text about parsing trees.'], { id: '20261022-110000-c3d4', title: 'Trees', updated_at: '2026-10-22T11:00:00.000Z' }), null)
    await store.writeDraft(draftFile(['Datasets.'], { updated_at: '2026-10-22T11:30:00.000Z' }), null)
    await drafts.reindex()
    expect(drafts.list().map((d) => d.title)).toEqual(['Log parsing', 'Trees'])
    expect(drafts.list({ text: 'PÁRSING trees' }).map((d) => d.title)).toEqual(['Trees'])
    await drafts.rename(DRAFT_ID_A, '  Log   datasets ')
    await drafts.setArchived(DRAFT_ID_A, true)
    expect(drafts.list()[0]).toMatchObject({ id: DRAFT_ID_A, title: 'Log datasets', archived: true })
    await expect(drafts.rename(DRAFT_ID_A, ' ')).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(drafts.remove(DRAFT_ID_A, false)).rejects.toMatchObject({ code: 'invalid_edit' })
    await drafts.remove(DRAFT_ID_A, true)
    expect(await store.listDraftIds()).toEqual(['20261022-110000-c3d4'])
    await expect(drafts.open(DRAFT_ID_A)).rejects.toMatchObject({ code: 'draft_not_found' })
  })

  it('names a copy the sync split off, and shows an unreadable file as a problem', async () => {
    const { store, drafts } = await setupDrafts()
    await store.writeDraft(draftFile(undefined, { id: `${DRAFT_ID_A}-abcdef`, copy_of: { id: DRAFT_ID_A, machine: 'desktop' } }), null)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(store.draftPath(DRAFT_ID_A), '<<<<<<< ours\nbroken\n')
    expect(await drafts.reindexIfChanged()).toBe(true)
    expect(drafts.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `${DRAFT_ID_A}-abcdef`, copyOf: { machine: 'desktop' } }), expect.objectContaining({ id: DRAFT_ID_A, problem: true })])
    )
    await expect(drafts.open(DRAFT_ID_A)).rejects.toMatchObject({ code: 'draft_invalid' })
    expect(await drafts.reindexIfChanged()).toBe(false)
  })

  it('stops a running draft when the project closes, keeping no empty version', async () => {
    const { drafts } = await setupDrafts({
      responses: [
        (req) =>
          new Promise((_resolve, reject) => {
            const stop = (): void => reject(new DOMException('aborted', 'AbortError'))
            if (req.signal!.aborted) stop()
            else req.signal!.addEventListener('abort', stop)
          })
      ]
    })
    const id = await drafts.run(draftInputOf(), null)
    await drafts.close()
    expect((await drafts.open(id)).versions).toEqual([])
    await expect(drafts.run(draftInputOf(), id)).rejects.toMatchObject({ code: 'draft_busy' })
  })
})
