import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { FACET_SUGGESTIONS_FILE } from '../../../src/main/project/facetSuggestionsFile'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import type { LlmOutput } from '../../../src/main/summary/llmOutput'
import { InvalidEdit } from '../../../src/main/summary/merge'
import { routeFetch } from '../../helpers/fakeFetch'
import { facetAgentAnswer, facetAgentResult } from '../../helpers/facets'
import { FakeLlmProvider, llmOutputFor, type AgentResponse } from '../../helpers/llm'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { tmpDir } from '../../helpers/tmp'

const base = { contactEmail: '', watch: false, citationPauseMs: 0, fetch: routeFetch([]) }
const ALIAS = 'alias__sanitization_technique__rules_regex'
const FACET = 'new_facet__data_source'
const VALUE = 'new_value__data_type__metrics'

/** A summary whose sanitization_technique proposes regex_rules (the source of the alias suggestion). */
function proposing(): LlmOutput {
  const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
  out.facets.sanitization_technique = { values: ['ner'], proposed: ['regex_rules'], evidence: [] }
  return out
}
const summary = (value: LlmOutput) => ({ value, costUsd: 0.03, model: 'claude-sonnet-5' })

async function summarize(s: ProjectSession, id: string, force = false): Promise<void> {
  await s.summaries.request(id, force ? { force: true } : {})
  await s.queue.whenIdle()
}

/** Drain and Loghub summarized (both proposing regex_rules), then one suggestion run. */
async function suggested(agent: AgentResponse[] = [facetAgentResult()]) {
  const llm = new FakeLlmProvider([summary(proposing())], agent)
  const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
  await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
  await summarize(s, DRAIN_ID)
  await summarize(s, LOGHUB_ID)
  await s.facets.request()
  await s.queue.whenIdle()
  return { s, llm }
}

const statuses = async (s: ProjectSession) => (await s.facets.list()).suggestions.map((v) => [v.suggestion.id, v.suggestion.status])

describe('FacetSuggestionService', () => {
  it('suggests through the queue and lists every suggestion with whether it still applies', async () => {
    const { s, llm } = await suggested()
    expect(s.queue.list()[0]).toMatchObject({ spec: { type: 'suggest_facets' }, state: 'done', message: 'facets_suggested' })
    const list = await s.facets.list()
    expect(list.suggestions.map((v) => [v.suggestion.id, v.suggestion.status, v.validity])).toEqual([
      [ALIAS, 'suggested', 'ok'],
      [FACET, 'suggested', 'ok'],
      [VALUE, 'suggested', 'ok']
    ])
    expect(list).toMatchObject({ pending: 3, running: false, file: { status: 'ok' }, lastRun: { ok: true, summarized: 2, model: 'claude-sonnet-5' } })
    expect(s.facets.plan()).toMatchObject({ capUsd: 2, papers: 2 })
    expect(llm.agentCalls[0]).toMatchObject({ maxTurns: 20, maxUsd: 2 })
    await s.close()
  })

  it('reads the papers for the list only while an alias suggestion waits for review', async () => {
    const { s } = await suggested()
    let reads = 0
    const read = s.store.readExtraction.bind(s.store)
    s.store.readExtraction = (id) => {
      reads++
      return read(id)
    }
    await s.facets.list()
    expect(reads).toBe(2)
    await s.facets.reject(ALIAS)
    reads = 0
    const list = await s.facets.list()
    expect(reads).toBe(0)
    expect(list.suggestions.filter((v) => v.suggestion.status === 'suggested').map((v) => [v.suggestion.id, v.validity])).toEqual([
      [FACET, 'ok'],
      [VALUE, 'ok']
    ])
    await s.close()
  })

  it('accepting a new facet adds it without making summaries stale, and undo takes it out again', async () => {
    const { s } = await suggested()
    let projectEvents = 0
    s.on('project', () => projectEvents++)
    const token = await s.facets.accept(FACET)
    expect(projectEvents).toBe(1)
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.facets.map((f) => f.key)).toContain('data_source')
    expect(s.library.list().map((r) => [r.id, r.summary_status, r.unfilled_facets])).toEqual([
      [DRAIN_ID, 'generated', 1],
      [LOGHUB_ID, 'generated', 1]
    ])
    expect(s.summaries.fillPlan()).toMatchObject({ count: 2 })
    expect(await statuses(s)).toContainEqual([FACET, 'accepted'])
    await s.facets.revert(token)
    const back = s.summaries.formInfo()
    expect(back.status === 'ok' && back.form.facets.some((f) => f.key === 'data_source')).toBe(false)
    expect(projectEvents).toBe(2)
    expect(s.library.list().every((r) => r.unfilled_facets === 0)).toBe(true)
    expect((await s.facets.list()).pending).toBe(3)
    await expect(s.facets.revert(token)).rejects.toBeInstanceOf(InvalidEdit)
    await s.close()
  })

  it('accepting an alias maps the proposal in entries still to review, never in a verified one, and undo puts the papers back', async () => {
    const { s } = await suggested()
    await s.summaries.setStatus(DRAIN_ID, 'facets', 'sanitization_technique', 'verified')
    const before = await s.store.readExtraction(LOGHUB_ID)
    const token = await s.facets.accept(ALIAS)
    const drain = await s.store.readExtraction(DRAIN_ID)
    const loghub = await s.store.readExtraction(LOGHUB_ID)
    expect(drain?.ok && drain.value.facets.sanitization_technique).toMatchObject({ values: ['ner'], proposed: ['regex_rules'], status: 'verified' })
    expect(loghub?.ok && loghub.value.facets.sanitization_technique).toMatchObject({ values: ['ner', 'rules_regex'], proposed: [], status: 'generated' })
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({ sanitization_technique: { regex_rules: 'rules_regex' } })
    await s.facets.revert(token)
    const restored = await s.store.readExtraction(LOGHUB_ID)
    expect(restored?.ok && restored.value).toEqual(before?.ok && before.value)
    const back = s.summaries.formInfo()
    expect(back.status === 'ok' && back.form.value_aliases).toEqual({})
    await s.close()
  })

  it('accepts an edited proposal under the same id, and refuses an edit of another kind', async () => {
    const { s } = await suggested()
    await s.facets.accept(VALUE, { kind: 'new_value', value: 'system_metrics' })
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.facets.find((f) => f.key === 'data_type')).toMatchObject({ values: expect.arrayContaining(['system_metrics']) })
    expect((await s.facets.list()).suggestions.find((v) => v.suggestion.id === VALUE)?.suggestion).toMatchObject({ status: 'accepted', value: 'system_metrics' })
    await expect(s.facets.accept(ALIAS, { kind: 'new_value', value: 'x' })).rejects.toBeInstanceOf(InvalidEdit)
    await s.close()
  })

  it('marks a suggestion the form overtook and refuses to accept it, changing nothing', async () => {
    const { s } = await suggested()
    const form = s.summaries.formInfo()
    if (form.status !== 'ok') throw new Error('no form')
    await s.summaries.updateForm({ ...form.form, facets: [...form.form.facets, { key: 'data_source', type: 'text', description: 'Typed by hand' }] })
    expect((await s.facets.list()).suggestions.find((v) => v.suggestion.id === FACET)?.validity).toBe('facet_exists')
    await expect(s.facets.accept(FACET)).rejects.toMatchObject({ code: 'suggestion_outdated' })
    const after = s.summaries.formInfo()
    expect(after.status === 'ok' && after.form.facets.find((f) => f.key === 'data_source')).toMatchObject({ type: 'text' })
    expect(await statuses(s)).toContainEqual([FACET, 'suggested'])
    await s.close()
  })

  it('a new run replaces only what is still to review and is told what was rejected; restore and its undo', async () => {
    const { s, llm } = await suggested([facetAgentResult(), facetAgentResult(facetAgentAnswer({ new_values: [], aliases: [] }))])
    await s.facets.reject(VALUE)
    await s.facets.accept(ALIAS)
    await s.facets.request()
    await s.queue.whenIdle()
    expect(await statuses(s)).toEqual([
      [ALIAS, 'accepted'],
      [FACET, 'suggested'],
      [VALUE, 'rejected']
    ])
    expect(llm.agentCalls[1].input).toContain('- new_value data_type: metrics')
    const token = await s.facets.restore(VALUE)
    expect(await statuses(s)).toContainEqual([VALUE, 'suggested'])
    await s.facets.revert(token)
    expect(await statuses(s)).toContainEqual([VALUE, 'rejected'])
    await s.close()
  })

  it('refuses to suggest or decide while facet-suggestions.yaml has a conflict', async () => {
    const { s } = await suggested()
    await writeFile(join(s.store.root, FACET_SUGGESTIONS_FILE), 'schema_version: 1\n<<<<<<< HEAD\nsuggestions: []\n=======\nsuggestions: []\n>>>>>>> other\n')
    expect(await s.facets.reindexIfChanged()).toBe(true)
    expect((await s.facets.list()).file).toEqual({ status: 'conflict' })
    await expect(s.facets.accept(FACET)).rejects.toMatchObject({ code: 'facet_suggestions_conflict' })
    await expect(s.facets.request()).rejects.toMatchObject({ code: 'facet_suggestions_conflict' })
    await s.close()
  })

  it('an acceptance whose suggestion file cannot be written leaves the form and the papers as they were', async () => {
    const { s } = await suggested()
    const drain = await s.store.readExtraction(DRAIN_ID)
    const loghub = await s.store.readExtraction(LOGHUB_ID)
    const failing = Object.assign(s.store, { writeFacetSuggestions: () => Promise.reject(new Error('disk full')) })
    await expect(s.facets.accept(ALIAS)).rejects.toThrow('disk full')
    expect((await s.store.readExtraction(DRAIN_ID))?.hash).toBe(drain?.hash)
    expect((await s.store.readExtraction(LOGHUB_ID))?.hash).toBe(loghub?.hash)
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({})
    expect(s.library.list().every((r) => r.summary_status === 'generated')).toBe(true)
    delete (failing as { writeFacetSuggestions?: unknown }).writeFacetSuggestions
    expect(await statuses(s)).toContainEqual([ALIAS, 'suggested'])
    await s.facets.accept(ALIAS)
    expect(await statuses(s)).toContainEqual([ALIAS, 'accepted'])
    await s.close()
  })

  it('an acceptance that cannot rewrite every paper puts back the ones it wrote and leaves the form alone', async () => {
    const { s } = await suggested()
    const drain = await s.store.readExtraction(DRAIN_ID)
    const loghub = await s.store.readExtraction(LOGHUB_ID)
    const write = s.store.writeExtraction.bind(s.store)
    let calls = 0
    Object.assign(s.store, {
      writeExtraction: (...args: Parameters<typeof write>) => (++calls === 2 ? Promise.reject(new Error('disk full')) : write(...args))
    })
    await expect(s.facets.accept(ALIAS)).rejects.toThrow('disk full')
    expect((await s.store.readExtraction(DRAIN_ID))?.hash).toBe(drain?.hash)
    expect((await s.store.readExtraction(LOGHUB_ID))?.hash).toBe(loghub?.hash)
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({})
    expect(await statuses(s)).toContainEqual([ALIAS, 'suggested'])
    await s.close()
  })

  it('an undo whose suggestion file cannot be written keeps the acceptance whole, and can be retried', async () => {
    const { s } = await suggested()
    const token = await s.facets.accept(ALIAS)
    const accepted = await s.store.readExtraction(LOGHUB_ID)
    const failing = Object.assign(s.store, { writeFacetSuggestions: () => Promise.reject(new Error('disk full')) })
    await expect(s.facets.revert(token)).rejects.toThrow('disk full')
    expect((await s.store.readExtraction(LOGHUB_ID))?.hash).toBe(accepted?.hash)
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({ sanitization_technique: { regex_rules: 'rules_regex' } })
    expect(await statuses(s)).toContainEqual([ALIAS, 'accepted'])
    delete (failing as { writeFacetSuggestions?: unknown }).writeFacetSuggestions
    await s.facets.revert(token)
    const back = s.summaries.formInfo()
    expect(back.status === 'ok' && back.form.value_aliases).toEqual({})
    expect(await statuses(s)).toContainEqual([ALIAS, 'suggested'])
    await s.close()
  })

  it('refuses to undo an acceptance once a rewritten paper changed, without touching anything', async () => {
    const { s } = await suggested()
    const token = await s.facets.accept(ALIAS)
    await s.summaries.setStatus(LOGHUB_ID, 'facets', 'sanitization_technique', 'verified')
    const edited = await s.store.readExtraction(LOGHUB_ID)
    await expect(s.facets.revert(token)).rejects.toBeInstanceOf(InvalidEdit)
    expect((await s.store.readExtraction(LOGHUB_ID))?.hash).toBe(edited?.hash)
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({ sanitization_technique: { regex_rules: 'rules_regex' } })
    expect(await statuses(s)).toContainEqual([ALIAS, 'accepted'])
    await expect(s.facets.revert(token)).rejects.toBeInstanceOf(InvalidEdit)
    await s.close()
  })

  it('a decision whose file was written stays made even when reading the file back fails', async () => {
    const { s } = await suggested()
    const read = s.store.readFacetSuggestions.bind(s.store)
    // Fails every second read: the one right after each write (the first read of a decision is its check).
    let calls = 0
    const flaky = Object.assign(s.store, {
      readFacetSuggestions: () => (++calls % 2 === 0 ? Promise.reject(new Error('io error')) : read())
    })
    const token = await s.facets.accept(ALIAS)
    const accepted = await s.store.readExtraction(LOGHUB_ID)
    expect(accepted?.ok && accepted.value.facets.sanitization_technique).toMatchObject({ values: ['ner', 'rules_regex'] })
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({ sanitization_technique: { regex_rules: 'rules_regex' } })
    expect((await read())?.ok && (await read())).toMatchObject({ value: { suggestions: expect.arrayContaining([expect.objectContaining({ id: ALIAS, status: 'accepted' })]) } })

    calls = 0
    await s.facets.revert(token)
    const back = s.summaries.formInfo()
    expect(back.status === 'ok' && back.form.value_aliases).toEqual({})
    expect((await read())?.ok && (await read())).toMatchObject({ value: { suggestions: expect.arrayContaining([expect.objectContaining({ id: ALIAS, status: 'suggested' })]) } })
    delete (flaky as { readFacetSuggestions?: unknown }).readFacetSuggestions
    expect(await s.facets.reindexIfChanged()).toBe(true)
    expect(await statuses(s)).toContainEqual([ALIAS, 'suggested'])
    await s.close()
  })

  it('an acceptance overtaken by a form saved meanwhile puts the papers back and keeps that form', async () => {
    const { s } = await suggested()
    const drain = await s.store.readExtraction(DRAIN_ID)
    const loghub = await s.store.readExtraction(LOGHUB_ID)
    const form = s.summaries.formInfo()
    if (form.status !== 'ok') throw new Error('no form')
    const edited = { ...form.form, facets: [...form.form.facets, { key: 'notes_by_hand', type: 'text' as const, description: 'Saved by the form editor' }] }
    const write = s.store.writeExtraction.bind(s.store)
    let saved = false
    const racing = Object.assign(s.store, {
      writeExtraction: async (...args: Parameters<typeof write>) => {
        if (!saved) {
          saved = true
          await s.summaries.updateForm(edited)
        }
        return write(...args)
      }
    })
    await expect(s.facets.accept(ALIAS)).rejects.toMatchObject({ code: 'suggestion_outdated' })
    delete (racing as { writeExtraction?: unknown }).writeExtraction
    expect((await s.store.readExtraction(DRAIN_ID))?.hash).toBe(drain?.hash)
    expect((await s.store.readExtraction(LOGHUB_ID))?.hash).toBe(loghub?.hash)
    const after = s.summaries.formInfo()
    expect(after.status === 'ok' && after.form.facets.map((f) => f.key)).toContain('notes_by_hand')
    expect(after.status === 'ok' && after.form.value_aliases).toEqual({})
    expect(await statuses(s)).toContainEqual([ALIAS, 'suggested'])
    await s.close()
  })
})

describe('automatic facet suggestions', () => {
  async function auto(agent: AgentResponse[], clock: { now: Date }, on = true): Promise<ProjectSession> {
    const llm = new FakeLlmProvider([summary(llmOutputFor(DEFAULT_EXTRACTION_FORM))], agent)
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm, now: () => clock.now })
    await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
    await s.summaries.ensureForm()
    await s.store.updateConfig({ llm: { ...s.store.config.llm, auto_suggest_facets: on, auto_suggest_facets_after: 2 } })
    return s
  }
  const runs = (s: ProjectSession) => s.queue.list().filter((j) => j.spec.type === 'suggest_facets')

  it('runs after enough new summaries, at most once a day, and never when the setting is off', async () => {
    const clock = { now: new Date('2026-10-11T09:00:00.000Z') }
    const s = await auto([facetAgentResult()], clock)
    await summarize(s, DRAIN_ID)
    expect(runs(s)).toHaveLength(0)
    await summarize(s, LOGHUB_ID)
    expect(runs(s).map((j) => [j.state, j.spec])).toEqual([['done', { type: 'suggest_facets', auto: true, batchId: 'auto-2026-10-11' }]])
    expect((await s.facets.list()).pending).toBe(2)
    await summarize(s, DRAIN_ID, true)
    expect(runs(s)).toHaveLength(1)
    // The next day: nothing new was summarized since the last run.
    clock.now = new Date('2026-10-12T09:00:00.000Z')
    await summarize(s, DRAIN_ID, true)
    expect(runs(s)).toHaveLength(1)
    await s.close()

    const off = await auto([facetAgentResult()], { now: new Date('2026-10-11T09:00:00.000Z') }, false)
    await summarize(off, DRAIN_ID)
    await summarize(off, LOGHUB_ID)
    expect(runs(off)).toHaveLength(0)
    await off.close()
  })

  it('after a failed run, waits for the next day before trying again', async () => {
    const clock = { now: new Date('2026-10-11T09:00:00.000Z') }
    const s = await auto([new LlmError('llm_unavailable'), facetAgentResult()], clock)
    await summarize(s, DRAIN_ID)
    await summarize(s, LOGHUB_ID)
    expect(runs(s).map((j) => [j.state, j.message])).toEqual([['failed', 'llm_unavailable']])
    expect((await s.facets.list()).lastRun).toMatchObject({ at: '2026-10-11T09:00:00.000Z', ok: false, summarized: 0 })
    await summarize(s, DRAIN_ID, true)
    expect(runs(s)).toHaveLength(1)
    clock.now = new Date('2026-10-12T09:00:00.000Z')
    await summarize(s, DRAIN_ID, true)
    expect(runs(s).map((j) => j.state)).toEqual(['done', 'failed'])
    expect((await s.facets.list()).lastRun).toMatchObject({ ok: true, summarized: 2 })
    await s.close()
  })

  it('an automatic run cancelled while queued still counts for the day', async () => {
    const clock = { now: new Date('2026-10-11T09:00:00.000Z') }
    const s = await auto([facetAgentResult()], clock)
    // Cancelled the moment it is queued, before the queue starts it.
    const stop = s.queue.onChange(() => {
      for (const j of runs(s)) if (j.state === 'queued') s.queue.cancel(j.id)
    })
    await summarize(s, DRAIN_ID)
    await summarize(s, LOGHUB_ID)
    stop()
    expect(runs(s).map((j) => j.state)).toEqual(['cancelled'])
    await summarize(s, DRAIN_ID, true)
    expect(runs(s)).toHaveLength(1)
    await s.close()
  })

  it('an automatic run aborted while running is recorded, so not even a reopened project runs it again that day', async () => {
    const clock = { now: new Date('2026-10-11T09:00:00.000Z') }
    const s = await auto([facetAgentResult()], clock)
    const stop = s.queue.onChange(() => {
      for (const j of runs(s)) if (j.state === 'running') s.queue.cancel(j.id)
    })
    await summarize(s, DRAIN_ID)
    await summarize(s, LOGHUB_ID)
    stop()
    expect(runs(s).map((j) => j.state)).toEqual(['cancelled'])
    expect((await s.facets.list()).lastRun).toMatchObject({ at: '2026-10-11T09:00:00.000Z', ok: false, summarized: 0 })
    await summarize(s, DRAIN_ID, true)
    expect(runs(s)).toHaveLength(1)
    const root = s.store.root
    await s.close()

    const llm = new FakeLlmProvider([summary(llmOutputFor(DEFAULT_EXTRACTION_FORM))], [facetAgentResult()])
    const again = await ProjectSession.open(root, { ...base, llm, now: () => clock.now })
    await summarize(again, LOGHUB_ID, true)
    expect(runs(again)).toHaveLength(1)
    await again.close()
  })
})
