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
    const opts = { contactEmail: '', fetch: routeFetch(DRAIN_ROUTES), watch: false, citationPauseMs: 0 }
    const session = await ProjectSession.create(root, 'Thesis', opts)
    let jobsChanged = 0
    session.on('jobs', () => jobsChanged++)
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/ICWS.2017.13' })
    await session.queue.whenIdle()
    expect(session.queue.list().find((j) => j.spec.type === 'ingest_identifier')).toMatchObject({ state: 'done', paperId: 'he2017drain', message: 'added' })
    expect(jobsChanged).toBeGreaterThan(0)
    await session.close()

    const reopened = await ProjectSession.open(root, opts)
    expect(reopened.library.list().map((r) => r.id)).toEqual(['he2017drain'])
    expect(reopened.queue.list().map((j) => j.spec.type).sort()).toEqual(['citations', 'ingest_identifier'])
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
    const session = await ProjectSession.create(root, 'Thesis', { contactEmail: '', fetch: routeFetch(DRAIN_ROUTES), citationPauseMs: 0 })
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/icws.2017.13' })
    await session.queue.whenIdle()
    const file = join(root, 'papers/he2017drain/paper.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^title: .*$/m, 'title: Edited in another editor'))
    const start = Date.now()
    while (session.library.list()[0].title !== 'Edited in another editor') {
      if (Date.now() - start > 3000) throw new Error('watcher did not reindex')
      await new Promise((r) => setTimeout(r, 50))
    }
    await session.close()
  })

  it('waits for tracked work before closing the cache', async () => {
    const session = await ProjectSession.create(await tmpDir(), 'Thesis', { contactEmail: '', fetch: routeFetch([]), watch: false })
    let release!: () => void
    let finished = false
    const pending = session.track(
      new Promise<void>((resolve) => (release = resolve)).then(() => {
        session.library.list()
        finished = true
      })
    )
    const closing = session.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(finished).toBe(false)
    release()
    await closing
    await pending
    expect(finished).toBe(true)
  })

  it('reindexes but does not re-export the bibliography when only notes change', async () => {
    const root = await tmpDir()
    const session = await ProjectSession.create(root, 'Thesis', { contactEmail: '', fetch: routeFetch(DRAIN_ROUTES), citationPauseMs: 0 })
    session.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/icws.2017.13' })
    await session.queue.whenIdle()
    await new Promise((r) => setTimeout(r, 500))
    let exports = 0
    let changes = 0
    const exportBib = session.library.exportBib.bind(session.library)
    session.library.exportBib = () => {
      exports++
      return exportBib()
    }
    session.on('library', () => changes++)

    await writeFile(join(root, 'papers/he2017drain/notes.md'), 'a note')
    await waitFor(() => changes > 0)
    expect(exports).toBe(0)

    const file = join(root, 'papers/he2017drain/paper.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^title: .*$/m, 'title: Renamed'))
    await waitFor(() => exports > 0)
    await session.close()
  })

  it('reports an external edit of project.yaml', async () => {
    const root = await tmpDir()
    const session = await ProjectSession.create(root, 'Thesis', { contactEmail: '', fetch: routeFetch([]) })
    let changes = 0
    session.on('project', () => changes++)
    const file = join(root, 'project.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^name: .*$/m, 'name: Renamed'))
    await waitFor(() => changes > 0)
    expect(session.store.config.name).toBe('Renamed')
    await session.close()
  })
})

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
