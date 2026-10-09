import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { routeFetch } from '../../helpers/fakeFetch'
import { FakeLlmProvider, llmOutputFor } from '../../helpers/llm'
import { makePdf } from '../../helpers/pdf'
import { tmpDir } from '../../helpers/tmp'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('auto summarize', () => {
  it('summarizes a new paper after ingest when enabled', async () => {
    const root = await tmpDir()
    const llm = new FakeLlmProvider([{ value: llmOutputFor(DEFAULT_EXTRACTION_FORM), costUsd: 0.01, model: 'm' }])
    const s = await ProjectSession.create(root, 'Thesis', { contactEmail: '', watch: false, fetch: routeFetch([]), llm })
    await s.store.updateConfig({ llm: { ...s.store.config.llm, auto_summarize: true } })
    const pdf = join(await tmpDir(), 'p.pdf')
    await writeFile(pdf, await makePdf([['A study of pseudonymization for production logs and incident reviews in large systems.']], { title: 'Pseudonymization of logs' }))
    s.queue.enqueue({ type: 'ingest_pdf', path: pdf })
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => j.spec.type).sort()).toEqual(['ingest_pdf', 'summarize'])
    expect(llm.calls).toHaveLength(1)
    await s.close()
  })

  it('does nothing extra when disabled', async () => {
    const llm = new FakeLlmProvider([{ value: {}, costUsd: 0, model: 'm' }])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { contactEmail: '', watch: false, fetch: routeFetch([]), llm })
    const pdf = join(await tmpDir(), 'p.pdf')
    await writeFile(pdf, await makePdf([['A study of pseudonymization for production logs and incident reviews in large systems.']]))
    s.queue.enqueue({ type: 'ingest_pdf', path: pdf })
    await s.queue.whenIdle()
    expect(llm.calls).toHaveLength(0)
    await s.close()
  })
})
