import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toYaml } from '../../../src/main/project/yamlFile'
import { DRAIN, LOGHUB_PREPRINT, LOGHUB_PUBLISHED, setupLibrary } from '../../helpers/library'
import { makePdf } from '../../helpers/pdf'
import { samplePaper } from '../../helpers/papers'

describe('LibraryService.ingestIdentifier', () => {
  it('adds a paper by DOI, indexes it and exports library.bib', async () => {
    const { root, store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    let changes = 0
    library.onChange(() => changes++)
    expect(await library.ingestIdentifier('https://doi.org/10.1109/ICWS.2017.13')).toEqual({ status: 'added', paperId: 'he2017drain' })
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value.bibtex.startsWith('@inproceedings{he2017drain,')).toBe(true)
    expect(await readFile(join(root, 'exports/library.bib'), 'utf8')).toContain('@inproceedings{he2017drain,')
    expect(library.list().map((r) => r.id)).toEqual(['he2017drain'])
    expect(library.list()[0]).toMatchObject({ text_status: 'no_source', has_pdf: false })
    expect(changes).toBeGreaterThan(0)
  })

  it('reports a duplicate instead of adding twice', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/ICWS.2017.13')
    expect(await library.ingestIdentifier('doi:10.1109/icws.2017.13')).toEqual({ status: 'duplicate', paperId: 'he2017drain' })
    expect(await store.listPaperIds()).toEqual(['he2017drain'])
  })

  it('serializes concurrent adds of the same paper', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const outcomes = await Promise.all([library.ingestIdentifier('10.1109/icws.2017.13'), library.ingestIdentifier('10.1109/icws.2017.13')])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['added', 'duplicate'])
    expect(await store.listPaperIds()).toEqual(['he2017drain'])
  })

  it('downloads the open-access PDF of an arXiv preprint and indexes its text', async () => {
    const pdf = await makePdf([['Loghub collects system logs for research on software reliability analysis.']])
    const { store, library } = await setupLibrary({
      resolver: { '10.48550/arxiv.2008.06448': LOGHUB_PREPRINT },
      routes: [{ url: 'https://arxiv.org/pdf/2008.06448', body: pdf }]
    })
    expect(await library.ingestIdentifier('arXiv:2008.06448')).toEqual({ status: 'added', paperId: 'zhu2020loghub' })
    expect(existsSync(join(store.paperDir('zhu2020loghub'), 'paper.pdf'))).toBe(true)
    expect(library.list()[0]).toMatchObject({ has_pdf: true, text_status: 'ok' })
    expect(library.list('system logs').map((r) => r.id)).toEqual(['zhu2020loghub'])
  })

  it('merges the published version into the preprint, keeping the citation key', async () => {
    const { store, library } = await setupLibrary({
      resolver: { '10.48550/arxiv.2008.06448': { ...LOGHUB_PREPRINT, oa_pdf_url: undefined }, '10.5555/loghub.2023': LOGHUB_PUBLISHED }
    })
    await library.ingestIdentifier('2008.06448')
    expect(await library.ingestIdentifier('10.5555/loghub.2023')).toEqual({ status: 'merged', paperId: 'zhu2020loghub' })
    const read = await store.readPaper('zhu2020loghub')
    expect(read.ok && read.value).toMatchObject({ kind: 'conference', venue: 'ISSRE', identifiers: { doi: '10.5555/loghub.2023', arxiv: '2008.06448' } })
    expect(await store.listPaperIds()).toEqual(['zhu2020loghub'])
  })

  it('rejects invalid input and unknown DOIs with user-facing codes', async () => {
    const { library } = await setupLibrary()
    await expect(library.ingestIdentifier('hello')).rejects.toMatchObject({ code: 'invalid_identifier' })
    await expect(library.ingestIdentifier('10.9999/nothing')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('LibraryService.reindexAll', () => {
  it('syncs the cache with the folder: new, removed and broken papers', async () => {
    const { root, store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')

    // Another device synced a new paper, removed one and left a merge conflict in a third.
    await mkdir(join(root, 'papers/zhu2020loghub'), { recursive: true })
    await writeFile(join(root, 'papers/zhu2020loghub/paper.yaml'), toYaml(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' })))
    await rm(store.paperDir('he2017drain'), { recursive: true })
    await mkdir(join(root, 'papers/broken2020x'), { recursive: true })
    await writeFile(join(root, 'papers/broken2020x/paper.yaml'), 'id: x\n<<<<<<< HEAD\ntitle: a\n=======\ntitle: b\n>>>>>>> theirs\n')

    await library.reindexAll()
    const rows = library.list()
    expect(rows.map((r) => r.id).sort()).toEqual(['broken2020x', 'zhu2020loghub'])
    expect(rows.find((r) => r.id === 'broken2020x')?.problem).toMatch(/^conflict_markers/)
    const bib = await readFile(join(root, 'exports/library.bib'), 'utf8')
    expect(bib).toContain('zhu2020loghub')
    expect(bib).not.toContain('he2017drain')
  })
})

describe('LibraryService.detail', () => {
  it('returns the paper and its status', async () => {
    const { library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')
    expect(await library.detail('he2017drain')).toMatchObject({ id: 'he2017drain', problem: null, hasPdf: false, textStatus: 'no_source', content: null })
  })
})

describe('LibraryService cancellation', () => {
  it('writes nothing when the job was cancelled before the paper is added', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const controller = new AbortController()
    controller.abort()
    await expect(library.ingestIdentifier('10.1109/icws.2017.13', controller.signal)).rejects.toBeDefined()
    expect(await store.listPaperIds()).toEqual([])
  })
})

describe('LibraryService.exportBib', () => {
  it('coalesces overlapping exports into one run plus one trailing rerun', async () => {
    const { root, store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')
    let runs = 0
    const listPaperIds = store.listPaperIds.bind(store)
    store.listPaperIds = () => {
      runs++
      return listPaperIds()
    }
    await Promise.all([library.exportBib(), library.exportBib(), library.exportBib(), library.exportBib()])
    expect(runs).toBe(2)
    // A call made after a change always gets a run that starts after it.
    await rm(join(root, 'papers/he2017drain'), { recursive: true })
    await library.exportBib()
    expect(runs).toBe(3)
    expect(await readFile(join(root, 'exports/library.bib'), 'utf8')).not.toContain('he2017drain')
  })
})
