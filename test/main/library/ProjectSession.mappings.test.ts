import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { routeFetch } from '../../helpers/fakeFetch'
import { FakeLlmProvider } from '../../helpers/llm'
import { tmpDir } from '../../helpers/tmp'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')

describe('ProjectSession mappings', () => {
  it('runs an OpenAlex search of a mapping as a job, and finds the mapping again after a reopen', async () => {
    const root = await tmpDir()
    const opts = {
      contactEmail: '',
      fetch: routeFetch([
        { url: /\/works\?search=.*cursor=\*/, body: fx('mapping.search-1.openalex.json') },
        { url: /\/works\?search=.*cursor=IlsxMDAu/, body: fx('mapping.search-2.openalex.json') }
      ]),
      watch: false,
      citationPauseMs: 0,
      llm: new FakeLlmProvider([])
    }
    const session = await ProjectSession.create(root, 'Thesis', opts)
    let events = 0
    session.on('mappings', () => events++)
    const id = await session.mappings.create('Logs')
    session.mappings.requestSearch(id, { query: 'log anonymization', fromYear: null, toYear: null, types: [], cap: 100 })
    await session.queue.whenIdle()
    expect(session.queue.list().find((j) => j.spec.type === 'mapping_search')).toMatchObject({ state: 'done', message: 'mapping_searched' })
    expect(session.mappings.list()[0]).toMatchObject({ id, records: 3, pending: 3 })
    expect(events).toBeGreaterThan(1)
    await session.close()
    const reopened = await ProjectSession.open(root, opts)
    expect(reopened.mappings.list()[0]).toMatchObject({ id, records: 3 })
    await reopened.close()
  })
})
