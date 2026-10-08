import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { routeFetch, type Route } from '../../helpers/fakeFetch'
import { tmpDir } from '../../helpers/tmp'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const DRAIN_ROUTES: Route[] = [
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/vnd.citationstyles.csl+json', body: fx('drain.csl.json') },
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/x-bibtex', body: fx('drain.bib') },
  { url: 'https://api.openalex.org/works/doi:10.1109/icws.2017.13', body: fx('drain.openalex.json') }
]

describe('ProjectSession', () => {
  it('runs an ingest job end to end and survives a reopen', async () => {
    const root = await tmpDir()
    const opts = { contactEmail: '', fetch: routeFetch(DRAIN_ROUTES), watch: false }
    const session = await ProjectSession.create(root, 'Thesis', opts)
    let jobsChanged = 0
    session.on('jobs', () => jobsChanged++)
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/ICWS.2017.13' })
    await session.queue.whenIdle()
    expect(session.queue.list()[0]).toMatchObject({ state: 'done', paperId: 'he2017drain', message: 'added' })
    expect(jobsChanged).toBeGreaterThan(0)
    await session.close()

    const reopened = await ProjectSession.open(root, opts)
    expect(reopened.library.list().map((r) => r.id)).toEqual(['he2017drain'])
    expect(reopened.queue.list()).toHaveLength(1)
    await reopened.close()
  })

  it('records a failed job with its user-facing code', async () => {
    const session = await ProjectSession.create(await tmpDir(), 'Thesis', { contactEmail: '', fetch: routeFetch([]), watch: false })
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.9999/nothing' })
    await session.queue.whenIdle()
    expect(session.queue.list()[0]).toMatchObject({ state: 'failed', message: 'not_found' })
    await session.close()
  })

  it('reindexes a paper edited outside the app', async () => {
    const root = await tmpDir()
    const session = await ProjectSession.create(root, 'Thesis', { contactEmail: '', fetch: routeFetch(DRAIN_ROUTES) })
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/icws.2017.13' })
    await session.queue.whenIdle()
    const file = join(root, 'papers/he2017drain/paper.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^title: .*$/m, 'title: Edited in Emacs'))
    const start = Date.now()
    while (session.library.list()[0].title !== 'Edited in Emacs') {
      if (Date.now() - start > 3000) throw new Error('watcher did not reindex')
      await new Promise((r) => setTimeout(r, 50))
    }
    await session.close()
  })
})
