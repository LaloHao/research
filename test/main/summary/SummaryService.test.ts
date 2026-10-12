import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { ConflictError } from '../../../src/main/project/errors'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { DEFAULT_EXTRACTION_FORM, loadForm } from '../../../src/main/summary/extractionForm'
import { toYaml } from '../../../src/main/project/yamlFile'
import { thesisHash } from '../../../src/main/summary/thesis'
import { FakeLlmProvider, fillOutputFor, llmOutputFor, PAPER_TEXT } from '../../helpers/llm'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'
import { sampleThesis } from '../../helpers/summaries'
import { parse } from 'yaml'

const ok = (form = DEFAULT_EXTRACTION_FORM) => ({ value: llmOutputFor(form), costUsd: 0.03, model: 'claude-sonnet-5' })
const DATA_SOURCE = { key: 'data_source', type: 'multi' as const, description: 'Where the analyzed data comes from', values: ['production_logs', 'public_dataset'] }

/** A session whose papers have indexed text, without network or PDFs. */
async function session(responses: ConstructorParameters<typeof FakeLlmProvider>[0] = [ok()], ids = ['he2017drain']) {
  const root = await tmpDir()
  const s = await ProjectSession.create(root, 'Thesis', { contactEmail: '', watch: false, llm: new FakeLlmProvider(responses) })
  for (const id of ids) {
    await s.store.writePaper(samplePaper({ id, title: `Paper ${id} about log anonymization methods` }), null)
    await s.store.writeContent(id, PAPER_TEXT)
    await s.library.indexPaper(id)
  }
  return s
}

describe('SummaryService', () => {
  it('summarizes through the queue, writes the default form and indexes the state', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    expect(s.queue.list()[0]).toMatchObject({ state: 'done', message: 'summarized', paperId: 'he2017drain' })
    expect(s.store.config.extraction_form).toBeDefined()
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated' })
    expect(s.library.list()[0].pending_review).toBeGreaterThan(0)
    const detail = await s.detail('he2017drain')
    expect(detail.summaryStatus).toBe('generated')
    expect(detail.summary?.fields.tldr.value).toBe('tldr text')
    expect(s.library.list()[0].summary_model).toBe('claude-sonnet-5')
    await s.close()
  })

  it('indexes the single/multi facets of the classification for the map', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const rows = s.cache.facetRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.paperId === 'he2017drain' && !r.reviewed && ['sanitization_technique', 'data_type', 'llm_usage', 'task'].includes(r.facet))).toBe(true)
    await s.close()
  })

  it('requestBatch with ids queues only those papers, even if already summarized, with the given model', async () => {
    const s = await session([ok(), ok()], ['a2020x', 'b2020x'])
    await s.summaries.request('a2020x')
    await s.queue.whenIdle()
    expect(s.library.list().find((r) => r.id === 'a2020x')?.summary_status).not.toBe('none')
    const { count } = await s.summaries.requestBatch({ ids: ['a2020x'], model: 'opus' })
    expect(count).toBe(1)
    expect(s.queue.list().filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'done').map((j) => j.spec)).toContainEqual(
      expect.objectContaining({ type: 'summarize', paperId: 'a2020x', model: 'opus' })
    )
    await s.close()
  })

  it('records a failure and cancels the rest of a batch on quota errors', async () => {
    const s = await session([new LlmError('llm_quota')], ['a2020x', 'b2020x', 'c2020x'])
    expect(await s.summaries.plan()).toMatchObject({ count: 3, batchLimitUsd: 10 })
    const { count } = await s.summaries.requestBatch()
    expect(count).toBe(3)
    await s.queue.whenIdle()
    const states = s.queue.list().map((j) => j.state).sort()
    expect(states).toEqual(['cancelled', 'cancelled', 'failed'])
    const failed = s.library.list().find((r) => r.summary_status === 'failed')
    expect(failed).toBeDefined()
    expect((await s.summaries.plan()).count).toBe(3)
    await s.close()
  })

  it('does not queue the same paper twice', async () => {
    const s = await session()
    await s.queue.stop()
    await s.summaries.request('he2017drain')
    await s.summaries.request('he2017drain')
    expect(s.queue.list()).toHaveLength(1)
    await s.close()
  })

  it('edits, verifies and lists what is left to review', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const before = await s.summaries.reviewQueue()
    expect(before[0]).toMatchObject({ paperId: 'he2017drain', section: 'fields', key: 'tldr' })
    await s.summaries.edit('he2017drain', 'fields', 'tldr', 'my own words')
    await s.summaries.setStatus('he2017drain', 'facets', 'rigor', 'verified')
    const after = await s.summaries.reviewQueue()
    expect(after).toHaveLength(before.length - 2)
    await expect(s.summaries.edit('he2017drain', 'fields', 'research_type', 'essay')).rejects.toMatchObject({ name: 'InvalidEdit' })
    await s.summaries.verifyAll('he2017drain')
    expect(await s.summaries.reviewQueue()).toEqual([])
    expect(s.library.list()[0].summary_status).toBe('reviewed')
    await s.close()
  })

  it('accepts and maps proposed values across papers and remembers aliases', async () => {
    const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
    out.facets.sanitization_technique = { values: [], proposed: ['tokenization'], evidence: [] }
    const s = await session([{ value: out, costUsd: 0.01, model: 'm' }], ['a2020x', 'b2020x'])
    await s.summaries.requestBatch()
    await s.queue.whenIdle()
    await s.summaries.mapProposed('sanitization_technique', 'tokenization', 'pseudonymization')
    for (const id of ['a2020x', 'b2020x']) {
      const e = await s.store.readExtraction(id)
      expect(e?.ok && e.value.facets.sanitization_technique).toMatchObject({ values: ['pseudonymization'], proposed: [] })
    }
    const form = s.summaries.formInfo()
    expect(form.status === 'ok' && form.form.value_aliases).toEqual({ sanitization_technique: { tokenization: 'pseudonymization' } })
    await s.close()
  })

  it('accepts a proposed value in every paper and adds it to the form', async () => {
    const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
    out.facets.sanitization_technique = { values: ['ner'], proposed: ['tokenization'], evidence: [] }
    const s = await session([{ value: out, costUsd: 0.01, model: 'm' }], ['a2020x', 'b2020x'])
    await s.summaries.requestBatch()
    await s.queue.whenIdle()
    await s.summaries.acceptProposed('sanitization_technique', 'tokenization')
    for (const id of ['a2020x', 'b2020x']) {
      const e = await s.store.readExtraction(id)
      expect(e?.ok && e.value.facets.sanitization_technique).toMatchObject({ values: ['ner', 'tokenization'], proposed: [] })
    }
    const form = s.summaries.formInfo()
    const facet = form.status === 'ok' ? form.form.facets.find((f) => f.key === 'sanitization_technique') : undefined
    expect(facet && 'values' in facet && facet.values).toContain('tokenization')
    for (const row of s.library.list()) expect(row.summary_status).not.toBe('stale')
    await s.close()
  })

  it('changes no paper and not the form when one affected paper cannot be read', async () => {
    const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
    out.facets.sanitization_technique = { values: [], proposed: ['tokenization'], evidence: [] }
    const s = await session([{ value: out, costUsd: 0.01, model: 'm' }], ['a2020x', 'b2020x'])
    await s.summaries.requestBatch()
    await s.queue.whenIdle()
    await writeFile(join(s.store.paperDir('b2020x'), 'summary.md'), '<<<<<<< HEAD\nbroken\n=======\nother\n>>>>>>> theirs\n')
    const extractions = async () => Promise.all(['a2020x', 'b2020x'].map((id) => readFile(join(s.store.paperDir(id), 'extraction.yaml'), 'utf8')))
    const before = await extractions()
    const formBefore = structuredClone(s.store.config.extraction_form)
    await expect(s.summaries.acceptProposed('sanitization_technique', 'tokenization')).rejects.toMatchObject({ code: 'file_problem' })
    await expect(s.summaries.mapProposed('sanitization_technique', 'tokenization', 'ner')).rejects.toMatchObject({ code: 'file_problem' })
    expect(await extractions()).toEqual(before)
    expect(s.store.config.extraction_form).toEqual(formBefore)
    await s.close()
  })

  it('marks summaries stale when a facet they have changes', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const form = { ...DEFAULT_EXTRACTION_FORM, facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f)) }
    await s.store.updateConfig({ extraction_form: form })
    await s.library.indexPaper('he2017drain')
    expect(s.library.list()[0].summary_status).toBe('stale')
    await s.close()
  })

  it('reports form errors without blocking the project', async () => {
    const s = await session()
    const text = toYaml({ ...s.store.config, extraction_form: { facets: [{ key: 'Bad Key', type: 'text' }] } })
    await writeFile(join(s.store.root, 'project.yaml'), text)
    await s.store.reloadConfig()
    expect(s.summaries.formInfo().status).toBe('invalid')
    await expect(s.summaries.request('he2017drain')).rejects.toMatchObject({ code: 'invalid_form' })
    await s.close()
  })

  describe('editing the extraction form', () => {
    it('adding a facet leaves summaries up to date with the facet unfilled; changing or removing a facet they have makes them stale', async () => {
      const s = await session()
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      const added = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, DATA_SOURCE] }
      expect(await s.summaries.formImpact(added)).toEqual({ staleCount: 0, removedValuesInUse: [] })
      await s.summaries.updateForm(added)
      expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated', unfilled_facets: 1 })
      // Rewording the unfilled facet touches nothing the paper has.
      const reworded = { ...added, facets: added.facets.map((f) => (f.key === 'data_source' ? { ...f, description: 'Origin of the data' } : f)) }
      expect(await s.summaries.formImpact(reworded)).toMatchObject({ staleCount: 0 })
      const removed = { ...added, facets: added.facets.filter((f) => f.key !== 'rigor') }
      expect(await s.summaries.formImpact(removed)).toMatchObject({ staleCount: 1 })
      const changed = { ...added, facets: added.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f)) }
      expect(await s.summaries.formImpact(changed)).toMatchObject({ staleCount: 1 })
      await s.summaries.updateForm(changed)
      // A stale summary is regenerated whole, so it counts no unfilled facets even though data_source is still missing.
      expect(s.library.list()[0]).toMatchObject({ summary_status: 'stale', unfilled_facets: 0 })
      await s.close()
    })

    it('formImpact: adding or removing allowed values does not make summaries stale', async () => {
      const s = await session()
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      const next = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'data_type' && 'values' in f ? { ...f, values: [...f.values, 'metrics'] } : f))
      }
      expect(await s.summaries.formImpact(next)).toEqual({ staleCount: 0, removedValuesInUse: [] })
      await s.close()
    })

    it('formImpact: a description change counts the up-to-date summaries as newly stale', async () => {
      const s = await session([ok(), ok()], ['a2020x', 'b2020x'])
      await s.summaries.requestBatch()
      await s.queue.whenIdle()
      expect(s.library.list().map((r) => r.summary_status)).toEqual(['generated', 'generated'])
      const next = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed description' } : f))
      }
      expect(await s.summaries.formImpact(next)).toMatchObject({ staleCount: 2 })
      // A paper that is already stale (not up to date with the current form) does not count again.
      await s.summaries.updateForm(next)
      expect(await s.summaries.formImpact(DEFAULT_EXTRACTION_FORM)).toMatchObject({ staleCount: 0 })
      await s.close()
    })

    it('formImpact: reports removed values still used by papers, and how many', async () => {
      const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
      out.facets.data_type = { values: ['logs', 'traces'], proposed: [], evidence: [] }
      const outB = llmOutputFor(DEFAULT_EXTRACTION_FORM)
      outB.facets.data_type = { values: ['logs'], proposed: [], evidence: [] }
      const s = await session(
        [{ value: out, costUsd: 0.01, model: 'm' }, { value: outB, costUsd: 0.01, model: 'm' }],
        ['a2020x', 'b2020x']
      )
      await s.summaries.requestBatch()
      await s.queue.whenIdle()
      const next = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'data_type' && 'values' in f ? { ...f, values: f.values.filter((v) => v !== 'logs') } : f))
      }
      const impact = await s.summaries.formImpact(next)
      expect(impact.removedValuesInUse).toEqual([{ facet: 'data_type', value: 'logs', papers: 2 }])
      await s.close()
    })

    it('formImpact: a same-key type change is not reported as a removed value, even if the old values look dropped', async () => {
      const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
      out.facets.data_type = { values: ['logs'], proposed: [], evidence: [] }
      const s = await session([{ value: out, costUsd: 0.01, model: 'm' }])
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      // "data_type" (multi, with "logs" among its values) is recreated under the same key as a text facet.
      const retyped = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'data_type' ? { key: 'data_type', type: 'text' as const, description: 'd' } : f))
      }
      const impact = await s.summaries.formImpact(retyped)
      expect(impact.removedValuesInUse).toEqual([])
      await s.close()
    })

    it('updateForm rejects an invalid form with invalid_form and does not change project.yaml', async () => {
      const s = await session()
      const before = structuredClone(s.store.config.extraction_form)
      await expect(s.summaries.updateForm({ facets: [{ key: 'dup', type: 'text', description: 'd' }, { key: 'dup', type: 'text', description: 'd' }], value_aliases: {} })).rejects.toMatchObject({
        code: 'invalid_form'
      })
      expect(s.store.config.extraction_form).toEqual(before)
      await s.close()
    })

    it('updateForm prunes aliases whose facet or target value no longer exists, and refreshes states', async () => {
      const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
      out.facets.sanitization_technique = { values: [], proposed: ['tokenization'], evidence: [] }
      const s = await session([{ value: out, costUsd: 0.01, model: 'm' }])
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      await s.summaries.mapProposed('sanitization_technique', 'tokenization', 'ner')
      expect(s.summaries.formInfo()).toMatchObject({ form: { value_aliases: { sanitization_technique: { tokenization: 'ner' } } } })

      const dropValue = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'sanitization_technique' && 'values' in f ? { ...f, values: f.values.filter((v) => v !== 'ner') } : f))
      }
      await s.summaries.updateForm(dropValue)
      expect(s.summaries.formInfo()).toMatchObject({ form: { value_aliases: {} } })
      expect(s.library.list()[0].summary_status).toBe('generated')
      await s.close()
    })

    it('updateForm marks up-to-date summaries stale when the hash changes', async () => {
      const s = await session()
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      const next = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f))
      }
      await s.summaries.updateForm(next)
      expect(s.library.list()[0].summary_status).toBe('stale')
      await s.close()
    })

    it('resetForm restores the default draft', async () => {
      const s = await session()
      const changed = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, { key: 'venue_type', type: 'text' as const, description: 'd' }] }
      await s.summaries.updateForm(changed)
      await s.summaries.resetForm()
      expect(s.summaries.formInfo()).toMatchObject({ form: DEFAULT_EXTRACTION_FORM })
      await s.close()
    })

    it('a facet recreated with a different type ignores the old entry everywhere, even when verified, and replaces it on regeneration', async () => {
      let form = DEFAULT_EXTRACTION_FORM
      const s = await session([() => ok(form)])
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      await s.summaries.verifyAll('he2017drain')
      expect(s.library.list()[0].summary_status).toBe('reviewed')

      // Remove the scale facet "rigor" and recreate it under the same key as a text facet.
      const asText = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { key: 'rigor', type: 'text' as const, description: 'Now free text' } : f))
      }
      form = asText
      await s.summaries.updateForm(asText)
      // The stored scale entry (score/justification) no longer fits the text facet: treated as absent.
      expect((await s.summaries.reviewQueue()).some((i) => i.key === 'rigor')).toBe(false)
      expect(s.library.list()[0].summary_status).toBe('stale')
      // The paper detail (and so FacetCard) must not render or expose the stale entry at all.
      expect((await s.detail('he2017drain')).extraction?.facets.rigor).toBeUndefined()
      // Nor can it be verified: the stored entry is effectively a different facet now.
      await expect(s.summaries.setStatus('he2017drain', 'facets', 'rigor', 'verified')).rejects.toMatchObject({ name: 'InvalidEdit' })

      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      const e2 = await s.store.readExtraction('he2017drain')
      // Regenerating overwrites the verified-but-type-mismatched entry with the freshly generated text value.
      expect(e2?.ok && e2.value.facets.rigor).toMatchObject({ text: 'not addressed' })
      await s.close()
    })

    it('verifyAll leaves a type-mismatched generated facet entry untouched', async () => {
      let form = DEFAULT_EXTRACTION_FORM
      const s = await session([() => ok(form)])
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()

      const asText = {
        ...DEFAULT_EXTRACTION_FORM,
        facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { key: 'rigor', type: 'text' as const, description: 'Now free text' } : f))
      }
      form = asText
      await s.summaries.updateForm(asText)
      await s.summaries.verifyAll('he2017drain')

      const e = await s.store.readExtraction('he2017drain')
      // The leftover scale entry (score/justification) must not be flipped to "verified": it is not the current facet.
      expect(e?.ok && e.value.facets.rigor.status).toBe('generated')
      // Everything else still gets verified.
      expect(e?.ok && e.value.facets.data_type.status).toBe('verified')
      await s.close()
    })
  })

  it('updateThesis keeps the question ids, saves project.yaml and marks summarized papers stale', async () => {
    const s = await session()
    expect(s.summaries.thesis()).toEqual({ title: '', description: '', research_questions: [], last_rq: 0 })
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    expect(s.library.list()[0].summary_status).toBe('generated')
    const expected = {
      title: 'Privacy-preserving log analysis',
      description: 'd',
      research_questions: [
        { id: 'RQ1', text: 'First?' },
        { id: 'RQ3', text: 'Third, after RQ2 was removed?' }
      ]
    }
    // last_rq is bumped to the highest id in use (RQ3), not just the count of questions (2).
    const saved = { ...expected, last_rq: 3 }
    await s.summaries.updateThesis(expected)
    expect(s.summaries.thesis()).toEqual(saved)
    expect(parse(await readFile(join(s.store.root, 'project.yaml'), 'utf8')).thesis).toEqual(saved)
    expect(s.library.list()[0].summary_status).toBe('stale')
    await expect(s.summaries.updateThesis({ ...expected, research_questions: [{ id: 'RQ1', text: '' }] })).rejects.toMatchObject({ name: 'InvalidEdit' })
    await expect(
      s.summaries.updateThesis({ ...expected, research_questions: [{ id: 'RQ1', text: 'a' }, { id: 'RQ1', text: 'b' }] })
    ).rejects.toMatchObject({ name: 'InvalidEdit' })
    await expect(s.summaries.updateThesis({ ...expected, research_questions: [{ id: 'Q1', text: 'a' }] })).rejects.toMatchObject({ name: 'InvalidEdit' })
    expect(s.summaries.thesis()).toEqual(saved)

    // Deleting RQ3 and adding a new question must not reuse the id RQ3: the counter never decreases.
    await s.summaries.updateThesis({ ...expected, research_questions: [expected.research_questions[0]] })
    await s.summaries.updateThesis({ ...expected, research_questions: [expected.research_questions[0], { id: 'RQ4', text: 'Fourth?' }] })
    expect(s.summaries.thesis().last_rq).toBe(4)
    await s.close()
  })

  it('a reviewed relation goes back to review (not stale, not in batches) after the thesis changes, until verified or edited again', async () => {
    const answer = () => ({ value: llmOutputFor(DEFAULT_EXTRACTION_FORM, undefined, sampleThesis), costUsd: 0.03, model: 'claude-sonnet-5' })
    const s = await session([answer])
    await s.summaries.updateThesis(sampleThesis)
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    await s.summaries.verifyAll('he2017drain')
    expect(s.library.list()[0].summary_status).toBe('reviewed')

    const changed = { ...sampleThesis, research_questions: [...sampleThesis.research_questions, { id: 'RQ3', text: 'A new question?' }] }
    await s.summaries.updateThesis(changed)
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated', pending_review: 1 })
    expect(await s.summaries.reviewQueue()).toEqual([expect.objectContaining({ paperId: 'he2017drain', section: 'thesis', key: 'relation' })])
    expect((await s.summaries.plan()).count).toBe(0)
    expect((await s.detail('he2017drain')).thesisOutdated).toBe(true)
    await s.summaries.setStatus('he2017drain', 'thesis', 'relation', 'verified')
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'reviewed', pending_review: 0 })
    expect((await s.detail('he2017drain')).thesisOutdated).toBe(false)

    await s.summaries.updateThesis(sampleThesis)
    expect(s.library.list()[0].summary_status).toBe('generated')
    // Regenerating keeps the reviewed relation and its old thesis hash: still waiting for review.
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    await s.summaries.verifyAll('he2017drain')
    expect(s.library.list()[0].summary_status).toBe('reviewed')
    await s.summaries.updateThesis(changed)
    await s.summaries.edit('he2017drain', 'thesis', 'relation', { score: 2 })
    expect(s.library.list()[0].summary_status).toBe('reviewed')
    const e = await s.store.readExtraction('he2017drain')
    expect(e?.ok && e.value.thesis_hash).toBe(thesisHash(changed))
    await s.close()
  })

  it('a paper without a relation, or with a generated one, is stale when the thesis changes', async () => {
    const answer = () => ({ value: llmOutputFor(DEFAULT_EXTRACTION_FORM, undefined, sampleThesis), costUsd: 0.03, model: 'claude-sonnet-5' })
    const s = await session([answer])
    await s.summaries.updateThesis(sampleThesis)
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    await s.summaries.updateThesis({ ...sampleThesis, title: 'Another title' })
    expect(s.library.list()[0].summary_status).toBe('stale')
    expect((await s.summaries.plan()).count).toBe(1)
    await s.close()
  })

  it('reviews and edits the relation to the thesis after the facets', async () => {
    const withThesis = { value: llmOutputFor(DEFAULT_EXTRACTION_FORM, undefined, sampleThesis), costUsd: 0.03, model: 'claude-sonnet-5' }
    const s = await session([withThesis])
    await s.summaries.updateThesis(sampleThesis)
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    expect(s.library.list()[0].summary_status).toBe('generated')
    const queue = await s.summaries.reviewQueue()
    expect(queue.at(-1)).toMatchObject({ paperId: 'he2017drain', section: 'thesis', key: 'relation' })
    expect(queue.at(-2)).toMatchObject({ section: 'facets', key: 'rigor' })

    await expect(s.summaries.edit('he2017drain', 'thesis', 'relation', { research_questions: ['RQ9'] })).rejects.toMatchObject({ name: 'InvalidEdit' })
    await expect(s.summaries.edit('he2017drain', 'thesis', 'relation', { score: 9 })).rejects.toMatchObject({ name: 'InvalidEdit' })
    await s.summaries.edit('he2017drain', 'thesis', 'relation', { research_questions: ['RQ2'], score: 5, justification: 'answers RQ2' })
    const e = await s.store.readExtraction('he2017drain')
    expect(e?.ok && e.value.thesis_relation).toMatchObject({ research_questions: ['RQ2'], score: 5, justification: 'answers RQ2', status: 'edited' })
    expect(await readFile(join(s.store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toContain('Score: 5/5 — answers RQ2')
    expect((await s.summaries.reviewQueue()).some((i) => i.section === 'thesis')).toBe(false)

    await expect(s.summaries.setStatus('he2017drain', 'thesis', 'other', 'verified')).rejects.toMatchObject({ name: 'InvalidEdit' })
    await s.summaries.verifyAll('he2017drain')
    expect(s.library.list()[0].summary_status).toBe('reviewed')
    await s.close()
  })

  it('verifies the relation through setStatus', async () => {
    const withThesis = { value: llmOutputFor(DEFAULT_EXTRACTION_FORM, undefined, sampleThesis), costUsd: 0.03, model: 'claude-sonnet-5' }
    const s = await session([withThesis])
    await s.summaries.updateThesis(sampleThesis)
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    await s.summaries.setStatus('he2017drain', 'thesis', 'relation', 'verified')
    const e = await s.store.readExtraction('he2017drain')
    expect(e?.ok && e.value.thesis_relation?.status).toBe('verified')
    expect((await s.summaries.reviewQueue()).some((i) => i.section === 'thesis')).toBe(false)
    await s.close()
  })

  it('undoes an edit, a verification and «Verificar todo» exactly, once, and only while the paper is as they left it', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const tldr = async () => {
      const r = await s.store.readSummary('he2017drain')
      return r?.ok ? r.value.fields.tldr : null
    }
    const files = async () => Promise.all(['summary.md', 'extraction.yaml'].map((f) => readFile(join(s.store.paperDir('he2017drain'), f), 'utf8')))
    const original = await tldr()
    const originalFiles = await files()
    const edited = await s.summaries.edit('he2017drain', 'fields', 'tldr', 'my own words')
    expect(await tldr()).toMatchObject({ value: 'my own words', status: 'edited' })
    await s.summaries.revert(edited)
    expect(await tldr()).toEqual(original)
    expect(await files()).toEqual(originalFiles)
    await expect(s.summaries.revert(edited)).rejects.toMatchObject({ name: 'InvalidEdit' })

    const verified = await s.summaries.setStatus('he2017drain', 'facets', 'rigor', 'verified')
    await s.summaries.edit('he2017drain', 'fields', 'tldr', 'changed after')
    const changedFiles = await files()
    await expect(s.summaries.revert(verified)).rejects.toMatchObject({ name: 'InvalidEdit' })
    expect(await files()).toEqual(changedFiles)
    await expect(s.summaries.revert(verified)).rejects.toMatchObject({ name: 'InvalidEdit' })

    const pending = (await s.summaries.reviewQueue()).length
    const all = await s.summaries.verifyAll('he2017drain')
    expect(await s.summaries.reviewQueue()).toEqual([])
    await s.summaries.revert(all)
    expect(await s.summaries.reviewQueue()).toHaveLength(pending)
    await s.close()
  })

  it('undoes mapping or accepting a proposed value in every paper and the form, and refuses once a paper changed', async () => {
    const out = llmOutputFor(DEFAULT_EXTRACTION_FORM)
    out.facets.sanitization_technique = { values: [], proposed: ['tokenization'], evidence: [] }
    const s = await session([{ value: out, costUsd: 0.01, model: 'm' }], ['a2020x', 'b2020x'])
    await s.summaries.requestBatch()
    await s.queue.whenIdle()
    const extractions = async () => Promise.all(['a2020x', 'b2020x'].map((id) => readFile(join(s.store.paperDir(id), 'extraction.yaml'), 'utf8')))
    const before = await extractions()
    const formBefore = loadForm(s.store.config.extraction_form)
    const mapped = await s.summaries.mapProposed('sanitization_technique', 'tokenization', 'pseudonymization')
    expect(await extractions()).not.toEqual(before)
    await s.summaries.revert(mapped)
    expect(await extractions()).toEqual(before)
    expect(loadForm(s.store.config.extraction_form)).toEqual(formBefore)

    const accepted = await s.summaries.acceptProposed('sanitization_technique', 'tokenization')
    await s.summaries.edit('a2020x', 'facets', 'sanitization_technique', { values: ['ner'] })
    const b = await readFile(join(s.store.paperDir('b2020x'), 'extraction.yaml'), 'utf8')
    const formAfter = loadForm(s.store.config.extraction_form)
    await expect(s.summaries.revert(accepted)).rejects.toMatchObject({ name: 'InvalidEdit' })
    expect(await readFile(join(s.store.paperDir('b2020x'), 'extraction.yaml'), 'utf8')).toBe(b)
    expect(loadForm(s.store.config.extraction_form)).toEqual(formAfter)
    await s.close()
  })

  it('plans a batch over some papers', async () => {
    const s = await session(undefined, ['a2020x', 'b2020x'])
    expect(await s.summaries.plan(['a2020x'])).toMatchObject({ count: 1, estimateUsd: 0.05 })
    expect(await s.summaries.plan()).toMatchObject({ count: 2 })
    await s.close()
  })

  it('counts and queues a paper named twice only once', async () => {
    const s = await session([ok(), ok()], ['a2020x', 'b2020x'])
    expect(await s.summaries.plan(['a2020x', 'a2020x'])).toMatchObject({ count: 1, estimateUsd: 0.05 })
    expect(await s.summaries.requestBatch({ ids: ['a2020x', 'b2020x', 'a2020x'] })).toMatchObject({ count: 2 })
    expect(s.queue.list().filter((j) => j.spec.type === 'summarize' && j.spec.paperId === 'a2020x')).toHaveLength(1)
    await s.queue.whenIdle()
    expect(s.summaries.fillPlan(['a2020x', 'a2020x']).count).toBeLessThanOrEqual(1)
    const queue = await s.summaries.reviewQueue(['a2020x', 'a2020x'])
    expect(queue).toEqual(await s.summaries.reviewQueue(['a2020x']))
    await s.close()
  })

  it('keeps an undo whose write failed halfway usable: the paper is left as the change left it, and a retry undoes it', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const files = async () => Promise.all(['summary.md', 'extraction.yaml'].map((f) => readFile(join(s.store.paperDir('he2017drain'), f), 'utf8')))
    const original = await files()
    // A facet's status writes extraction.yaml and then summary.md, so its undo writes both.
    const token = await s.summaries.setStatus('he2017drain', 'facets', 'rigor', 'verified')
    const after = await files()
    const spy = vi.spyOn(s.store, 'writeSummary').mockRejectedValueOnce(new ConflictError('summary.md'))
    await expect(s.summaries.revert(token)).rejects.toMatchObject({ name: 'ConflictError' })
    spy.mockRestore()
    expect(await files()).toEqual(after)
    await s.summaries.revert(token)
    expect(await files()).toEqual(original)
    await s.close()
  })

  it('spends an undo whose files were restored even when re-indexing them fails', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const tldr = async () => {
      const r = await s.store.readSummary('he2017drain')
      return r?.ok ? r.value.fields.tldr : null
    }
    const original = await tldr()
    const token = await s.summaries.edit('he2017drain', 'fields', 'tldr', 'my own words')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(s.library, 'indexPaper').mockRejectedValueOnce(new Error('index down'))
    await s.summaries.revert(token)
    spy.mockRestore()
    quiet.mockRestore()
    expect(await tldr()).toEqual(original)
    await expect(s.summaries.revert(token)).rejects.toMatchObject({ name: 'InvalidEdit', message: 'Nothing to undo' })
    await s.close()
  })

  it('refuses and spends the undo of a paper moved to the trash, like a proposed-value undo', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const token = await s.summaries.edit('he2017drain', 'fields', 'tldr', 'my own words')
    await s.trash(['he2017drain'])
    await expect(s.summaries.revert(token)).rejects.toMatchObject({ name: 'InvalidEdit' })
    await s.restore(['he2017drain'], { merge: false })
    await expect(s.summaries.revert(token)).rejects.toMatchObject({ name: 'InvalidEdit', message: 'Nothing to undo' })
    await s.close()
  })

  it('keeps the latest 100 undo tokens', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const tokens: string[] = []
    for (let i = 0; i < 101; i++) tokens.push(await s.summaries.setStatus('he2017drain', 'fields', 'tldr', i % 2 === 0 ? 'verified' : 'generated'))
    await expect(s.summaries.revert(tokens[0])).rejects.toMatchObject({ name: 'InvalidEdit', message: 'Nothing to undo' })
    await s.summaries.revert(tokens[100])
    await s.close()
  })
})

describe('SummaryService: papers longer than max_input_chars', () => {
  const tooLong = async (s: ProjectSession) => {
    await s.store.updateConfig({ llm: { ...s.store.config.llm, max_input_chars: 50 } })
    for (const id of await s.store.listPaperIds()) await s.library.indexPaper(id)
  }

  it('batches skip a too-long paper that was never forced, even when asked by id', async () => {
    const s = await session([ok()], ['a2020x', 'b2020x'])
    await tooLong(s)
    expect(s.library.list().map((r) => r.summary_status)).toEqual(['too_long', 'too_long'])
    expect((await s.summaries.plan()).count).toBe(0)
    expect((await s.summaries.requestBatch({ ids: ['a2020x', 'b2020x'] })).count).toBe(0)
    await s.close()
  })

  it('remembers a forced summary was truncated and forces regenerations and stale batches automatically', async () => {
    const venue = { ...DEFAULT_EXTRACTION_FORM, facets: DEFAULT_EXTRACTION_FORM.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f)) }
    let form = DEFAULT_EXTRACTION_FORM
    const s = await session([() => ok(form)], ['a2020x', 'b2020x'])
    await tooLong(s)
    await s.summaries.request('a2020x', { force: true })
    await s.queue.whenIdle()
    const first = await s.store.readSummary('a2020x')
    expect(first?.ok && first.value.generated.truncated).toBe(true)

    // Regenerate (and "Regenerate with…") send no force flag.
    await s.summaries.request('a2020x', { model: 'haiku' })
    await s.queue.whenIdle()
    expect(s.queue.list().filter((j) => j.state === 'failed')).toEqual([])
    expect(s.library.list().find((r) => r.id === 'a2020x')?.summary_status).toBe('generated')

    // The form changes: the stale batch regenerates the forced paper and still skips the never-forced one.
    form = venue
    await s.store.updateConfig({ extraction_form: venue })
    for (const id of ['a2020x', 'b2020x']) await s.library.indexPaper(id)
    expect((await s.summaries.plan()).count).toBe(1)
    const { count } = await s.summaries.requestBatch()
    expect(count).toBe(1)
    await s.queue.whenIdle()
    expect(s.queue.list().filter((j) => j.state === 'failed')).toEqual([])
    const row = s.library.list().find((r) => r.id === 'a2020x')
    expect(row?.summary_status).toBe('generated')
    expect((await s.summaries.requestBatch({ ids: ['a2020x', 'b2020x'] })).count).toBe(1)
    await s.queue.whenIdle()
    await s.close()
  })

  it('a full-text regeneration clears the truncated flag', async () => {
    const s = await session([ok()])
    await s.store.updateConfig({ llm: { ...s.store.config.llm, max_input_chars: 50 } })
    await s.library.indexPaper('he2017drain')
    await s.summaries.request('he2017drain', { force: true })
    await s.queue.whenIdle()
    await s.store.updateConfig({ llm: { ...s.store.config.llm, max_input_chars: 400000 } })
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const summary = await s.store.readSummary('he2017drain')
    expect(summary?.ok && summary.value.generated.truncated).toBeFalsy()
    await s.close()
  })
})

describe('SummaryService: config changes refresh every summary state', () => {
  it('an external edit of project.yaml (e.g. a git pull) recomputes the states', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    expect(s.library.list()[0].summary_status).toBe('generated')
    let libraryEvents = 0
    s.on('library', () => libraryEvents++)
    const raw = parse(await readFile(join(s.store.root, 'project.yaml'), 'utf8'))
    raw.extraction_form.facets.find((f: { key: string }) => f.key === 'rigor').description = 'Changed'
    await writeFile(join(s.store.root, 'project.yaml'), toYaml(raw))
    // What the watcher calls on a change of project.yaml.
    await s.reloadConfig()
    expect(s.library.list()[0].summary_status).toBe('stale')
    expect(libraryEvents).toBe(1)
    // Our own writes also reach the watcher: an unchanged file recomputes nothing.
    await s.reloadConfig()
    expect(libraryEvents).toBe(1)
    await s.close()
  })

  it('the project watcher picks up an in-place edit of project.yaml after the app replaced it', async () => {
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { contactEmail: '', llm: new FakeLlmProvider([ok()]) })
    try {
      await s.store.writePaper(samplePaper({ id: 'he2017drain' }), null)
      await s.store.writeContent('he2017drain', PAPER_TEXT)
      await s.library.indexPaper('he2017drain')
      await s.summaries.request('he2017drain')
      await s.queue.whenIdle()
      // The app's own writes (project.yaml included) reach the watcher too; let them settle so only the edit below can change the state.
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(s.library.list()[0].summary_status).toBe('generated')
      const raw = parse(await readFile(join(s.store.root, 'project.yaml'), 'utf8'))
      raw.extraction_form.facets.find((f: { key: string }) => f.key === 'rigor').description = 'Changed'
      await writeFile(join(s.store.root, 'project.yaml'), toYaml(raw))
      await vi.waitFor(() => expect(s.library.list()[0].summary_status).toBe('stale'), { timeout: 3000, interval: 50 })
    } finally {
      await s.close()
    }
  })

  it('updateLlm recomputes the states (max_input_chars decides too_long)', async () => {
    const s = await session([ok()], ['a2020x'])
    expect(s.library.list()[0].summary_status).toBe('none')
    await s.summaries.updateLlm({ max_input_chars: 50 })
    expect(s.library.list()[0].summary_status).toBe('too_long')
    await s.summaries.updateLlm({ max_input_chars: 400000 })
    expect(s.library.list()[0].summary_status).toBe('none')
    await s.close()
  })

  it('fills new facets through the queue without regenerating the summary', async () => {
    const fill = { value: fillOutputFor([DATA_SOURCE]), costUsd: 0.01, model: 'claude-haiku-5' }
    const s = await session([ok(), fill])
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const before = await s.store.readSummary('he2017drain')
    await s.summaries.updateForm({ ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, DATA_SOURCE] })
    expect(s.summaries.fillPlan()).toMatchObject({ count: 1, batchLimitUsd: 10 })
    expect(s.summaries.requestFill()).toMatchObject({ count: 1 })
    await s.queue.whenIdle()
    expect(s.queue.list()[0]).toMatchObject({ spec: { type: 'fill_facets', paperId: 'he2017drain' }, state: 'done', message: 'facets_filled' })
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated', unfilled_facets: 0 })
    expect(s.summaries.fillPlan().count).toBe(0)
    expect(s.queue.list().filter((j) => j.spec.type === 'summarize')).toHaveLength(1)
    const after = await s.store.readSummary('he2017drain')
    expect(after?.ok && after.value.generated).toEqual(before?.ok && before.value.generated)
    await s.close()
  })

  it('filling a new facet by hand keeps the summary up to date', async () => {
    const s = await session([ok()])
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    await s.summaries.updateForm({ ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, DATA_SOURCE] })
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated', unfilled_facets: 1 })
    await s.summaries.edit('he2017drain', 'facets', 'data_source', { values: ['public_dataset'] })
    expect(s.library.list()[0]).toMatchObject({ summary_status: 'generated', unfilled_facets: 0 })
    expect(s.summaries.fillPlan().count).toBe(0)
    await s.close()
  })
})
