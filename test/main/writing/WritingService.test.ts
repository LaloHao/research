import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { WritingService } from '../../../src/main/writing/WritingService'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { samplePaper } from '../../helpers/papers'
import { typedRelation } from '../../helpers/relations'
import { sampleSummary } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

const NOTEXT_ID = 'doe2021notext'

/** Drain and Loghub with text, a third paper without text, one paper in the trash and a mapping including Loghub. */
async function setup() {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const noText = samplePaper({ id: NOTEXT_ID, title: 'A Paper Without Text', year: 2021, bibtex: '@article{whatever,\n  title = {No text},\n  author = {Doe, Jane}\n}' })
  await store.writePaper(noText, null)
  cache.upsertPaper(noText, 'h', false)
  cache.replaceTrash([{ id: 'old2010gone', title: 'Gone', authors_label: '', year: 2010, doi: null, openalex_id: null, trashed_at: null, device: null, problem: null }])
  const writing = new WritingService({ store, cache, includedPapers: (id) => (id === 'm1' ? [LOGHUB_ID] : []) })
  return { store, cache, writing }
}

describe('WritingService', () => {
  it('lists the keys the library knows, with whether their text is indexed, and the trashed ones', async () => {
    const { writing } = await setup()
    const library = writing.library()
    expect(library.papers.map((p) => [p.id, p.hasText]).sort()).toEqual([
      [NOTEXT_ID, false],
      [DRAIN_ID, true],
      [LOGHUB_ID, true]
    ])
    expect(library.trashed).toEqual([{ id: 'old2010gone', title: 'Gone' }])
  })

  it('builds the chapter .bib of pasted text with the library export’s entries, rekeyed', async () => {
    const { writing } = await setup()
    const bib = await writing.bibFromText(`Text \\cite{${LOGHUB_ID}, ${DRAIN_ID}} and \\cite{old2010gone,he2017drian,${NOTEXT_ID}}.`, 'latex')
    expect(bib.citations).toBe(2)
    expect(bib.report.entries.map((e) => e.key)).toEqual([LOGHUB_ID, DRAIN_ID, NOTEXT_ID])
    expect(bib.report.entries[2].bibtex.startsWith(`@article{${NOTEXT_ID},`)).toBe(true)
    expect(bib.report.trashed).toEqual(['old2010gone'])
    expect(bib.report.unknown).toEqual([{ key: 'he2017drian', suggestion: { key: DRAIN_ID, title: expect.stringContaining('Drain') } }])
    expect(bib.report.incomplete.map((i) => [i.key, i.missing])).toEqual([
      [LOGHUB_ID, ['year', 'authors', 'venue']],
      [DRAIN_ID, ['authors', 'venue']],
      [NOTEXT_ID, ['year', 'venue']]
    ])
  })

  it('builds the chapter .bib of a file and what it includes', async () => {
    const { writing } = await setup()
    const dir = await tmpDir()
    await mkdir(join(dir, 'ch'))
    await writeFile(join(dir, 'thesis.org'), `* Intro\nText [cite:@${DRAIN_ID}].\n#+INCLUDE: "ch/one.org"`)
    await writeFile(join(dir, 'ch/one.org'), `[cite/t:@${LOGHUB_ID}]`)
    const bib = await writing.bibFromFile(join(dir, 'thesis.org'))
    expect(bib.report.entries.map((e) => e.key)).toEqual([DRAIN_ID, LOGHUB_ID])
    expect(bib.files.map((f) => f.path)).toEqual(['thesis.org', 'ch/one.org'])
  })

  it('gathers the outline data: facets of the form, values, one-liners and confirmed relations in the set', async () => {
    const { store, cache, writing } = await setup()
    await store.updateConfig({
      extraction_form: {
        facets: [
          { key: 'task', type: 'single', description: 'Task', values: ['parsing', 'anomaly'] },
          { key: 'notes', type: 'text', description: 'Notes' }
        ],
        value_aliases: {}
      }
    })
    cache.setFacets(DRAIN_ID, [{ facet: 'task', value: 'parsing', reviewed: true }], null)
    cache.setFacets(LOGHUB_ID, [{ facet: 'task', value: 'anomaly', reviewed: false }], null)
    await store.writeSummary(DRAIN_ID, sampleSummary({ tldr: { value: 'An online parser.', status: 'verified', evidence: [] } }), '', null)
    cache.replaceTypedRelations([typedRelation({ status: 'confirmed' }), typedRelation({ type: 'contradicts', status: 'suggested' })])
    const all = await writing.outlineData({ kind: 'library' })
    expect(all.facets).toEqual([{ key: 'task', values: ['parsing', 'anomaly'] }])
    const drain = all.papers.find((p) => p.id === DRAIN_ID)!
    expect(drain).toMatchObject({ tldr: 'An online parser.', facets: { task: { values: ['parsing'], reviewed: true } } })
    expect(all.papers.find((p) => p.id === NOTEXT_ID)?.tldr).toBeNull()
    expect(all.relations).toEqual([{ from: LOGHUB_ID, to: DRAIN_ID, type: 'extends' }])
    const filtered = await writing.outlineData({ kind: 'papers', ids: [DRAIN_ID] })
    expect(filtered.papers.map((p) => p.id)).toEqual([DRAIN_ID])
    expect(filtered.relations).toEqual([])
    expect((await writing.outlineData({ kind: 'mapping', mappingId: 'm1' })).papers.map((p) => p.id)).toEqual([LOGHUB_ID])
  })
})
