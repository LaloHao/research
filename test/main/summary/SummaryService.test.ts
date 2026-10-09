import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { toYaml } from '../../../src/main/project/yamlFile'
import { thesisHash } from '../../../src/main/summary/thesis'
import { FakeLlmProvider, llmOutputFor, PAPER_TEXT } from '../../helpers/llm'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'
import { sampleThesis } from '../../helpers/summaries'
import { parse } from 'yaml'

const ok = (form = DEFAULT_EXTRACTION_FORM) => ({ value: llmOutputFor(form), costUsd: 0.03, model: 'claude-sonnet-5' })

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

  it('marks summaries stale when the form changes', async () => {
    const s = await session()
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    const form = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, { key: 'venue_type', type: 'text' as const, description: 'Kind of venue' }] }
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
    const venue = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, { key: 'venue_type', type: 'text' as const, description: 'Kind of venue' }] }
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
    raw.extraction_form.facets.push({ key: 'venue_type', type: 'text', description: 'Kind of venue' })
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
      raw.extraction_form.facets.push({ key: 'venue_type', type: 'text', description: 'Kind of venue' })
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
})
