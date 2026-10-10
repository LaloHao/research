import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { toYaml } from '../../../src/main/project/yamlFile'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { routeFetch } from '../../helpers/fakeFetch'
import { FakeLlmProvider, llmOutputFor } from '../../helpers/llm'
import { DRAIN_ID, drainPaper, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { agentResult, typedRelation } from '../../helpers/relations'
import { tmpDir } from '../../helpers/tmp'

const base = { contactEmail: '', watch: false, citationPauseMs: 0, fetch: routeFetch([]) }
const ID = 'he2017drain__zhu2020loghub__extends'

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ProjectSession typed relations', () => {
  it('suggests through the queue and shows the result in the library, the graph and the review queue', async () => {
    const llm = new FakeLlmProvider([], [agentResult()])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
    await s.relations.request(LOGHUB_ID)
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => [j.spec.type, j.state, j.message])).toEqual([['suggest_relations', 'done', 'relations_suggested']])
    expect(s.library.list().find((r) => r.id === LOGHUB_ID)?.relations_pending).toBe(1)
    expect(s.map.graph().typed).toEqual([{ id: ID, source: LOGHUB_ID, target: DRAIN_ID, type: 'extends', status: 'suggested', directed: true }])
    expect(await s.reviewQueue()).toEqual([{ paperId: DRAIN_ID, title: drainPaper().title, section: 'relation', key: ID }])
    expect(llm.agentCalls[0].mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    await s.close()
  })

  it('suggests automatically after a summary when the setting is on', async () => {
    const llm = new FakeLlmProvider([{ value: llmOutputFor(DEFAULT_EXTRACTION_FORM), costUsd: 0.01, model: 'm' }], [agentResult()])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
    await s.summaries.ensureForm()
    await s.store.updateConfig({ llm: { ...s.store.config.llm, auto_suggest_relations: true } })
    await s.summaries.request(LOGHUB_ID)
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => [j.spec.type, j.state])).toEqual([
      ['suggest_relations', 'done'],
      ['summarize', 'done']
    ])
    await s.close()
  })

  it('does not suggest after a summary when the setting is off', async () => {
    const llm = new FakeLlmProvider([{ value: llmOutputFor(DEFAULT_EXTRACTION_FORM), costUsd: 0.01, model: 'm' }], [agentResult()])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    await seedPair(s.store, s.cache, { index: (id) => s.library.indexPaper(id) })
    await s.summaries.ensureForm()
    await s.summaries.request(LOGHUB_ID)
    await s.queue.whenIdle()
    expect(llm.agentCalls).toHaveLength(0)
    await s.close()
  })

  it('picks up relations.yaml edited outside the app', async () => {
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, watch: true, llm: new FakeLlmProvider([]) })
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(s.store.root, 'relations.yaml'), toYaml({ schema_version: 1, relations: [typedRelation({ status: 'confirmed' })] }))
    await waitFor(() => s.cache.typedRelations().length === 1)
    expect(s.relations.fileState()).toEqual({ status: 'ok' })
    await s.close()
  })
})
