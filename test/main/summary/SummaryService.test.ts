import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { toYaml } from '../../../src/main/project/yamlFile'
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
    expect(s.summaries.plan()).toMatchObject({ count: 3, batchLimitUsd: 10 })
    const { count } = await s.summaries.requestBatch()
    expect(count).toBe(3)
    await s.queue.whenIdle()
    const states = s.queue.list().map((j) => j.state).sort()
    expect(states).toEqual(['cancelled', 'cancelled', 'failed'])
    const failed = s.library.list().find((r) => r.summary_status === 'failed')
    expect(failed).toBeDefined()
    expect(s.summaries.plan().count).toBe(3)
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

  it('updateThesis renumbers the questions, saves project.yaml and marks summarized papers stale', async () => {
    const s = await session()
    expect(s.summaries.thesis()).toEqual({ title: '', description: '', research_questions: [] })
    await s.summaries.request('he2017drain')
    await s.queue.whenIdle()
    expect(s.library.list()[0].summary_status).toBe('generated')
    await s.summaries.updateThesis({
      title: 'Privacy-preserving log analysis',
      description: 'd',
      research_questions: [
        { id: 'RQ7', text: 'First?' },
        { id: 'RQ3', text: 'Second?' }
      ]
    })
    const expected = { title: 'Privacy-preserving log analysis', description: 'd', research_questions: [{ id: 'RQ1', text: 'First?' }, { id: 'RQ2', text: 'Second?' }] }
    expect(s.summaries.thesis()).toEqual(expected)
    expect(parse(await readFile(join(s.store.root, 'project.yaml'), 'utf8')).thesis).toEqual(expected)
    expect(s.library.list()[0].summary_status).toBe('stale')
    await expect(s.summaries.updateThesis({ ...expected, research_questions: [{ id: 'RQ1', text: '' }] })).rejects.toMatchObject({ name: 'InvalidEdit' })
    expect(s.summaries.thesis()).toEqual(expected)
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
