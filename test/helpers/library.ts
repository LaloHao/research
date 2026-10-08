import { join } from 'node:path'
import { IndexCache } from '../../src/main/cache/IndexCache'
import { PdfjsExtractor } from '../../src/main/extract/PdfExtractor'
import { HttpClient, HttpError } from '../../src/main/ingest/http'
import type { MetadataSource } from '../../src/main/ingest/MetadataResolver'
import type { ResolvedMetadata } from '../../src/main/ingest/types'
import { LibraryService } from '../../src/main/library/LibraryService'
import { ProjectStore } from '../../src/main/project/ProjectStore'
import type { PdfPolicy } from '../../src/shared/schemas'
import { routeFetch, type Route } from './fakeFetch'
import { tmpDir } from './tmp'

export const DRAIN: ResolvedMetadata = {
  kind: 'conference',
  title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
  authors: [
    { family: 'He', given: 'Pinjia' },
    { family: 'Zhu', given: 'Jieming' }
  ],
  year: 2017,
  venue: 'ICWS',
  identifiers: { doi: '10.1109/icws.2017.13' },
  bibtex: ' @inproceedings{He_2017, title={Drain}, year={2017} }',
  complete: true
}

export const LOGHUB_PREPRINT: ResolvedMetadata = {
  kind: 'preprint',
  title: 'Loghub: A Large Collection of System Log Datasets',
  authors: [{ family: 'Zhu', given: 'Jieming' }],
  year: 2020,
  identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' },
  oa_pdf_url: 'https://arxiv.org/pdf/2008.06448',
  bibtex: '@misc{https://doi.org/10.48550/arxiv.2008.06448,\n  title = {Loghub},\n  year = {2020}\n}',
  complete: true
}

/** Test-only published version of the preprint above (10.5555 is a test DOI prefix). */
export const LOGHUB_PUBLISHED: ResolvedMetadata = {
  kind: 'conference',
  title: 'Loghub: A Large Collection of System Log Datasets',
  authors: [{ family: 'Zhu', given: 'Jieming' }],
  year: 2023,
  venue: 'ISSRE',
  identifiers: { doi: '10.5555/loghub.2023' },
  bibtex: '@inproceedings{Zhu_2023, title={Loghub}, year={2023} }',
  complete: true
}

export class FakeResolver implements MetadataSource {
  readonly calls: string[] = []
  private readonly map: Map<string, ResolvedMetadata>

  constructor(entries: Record<string, ResolvedMetadata> = {}) {
    this.map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  }

  set(doi: string, meta: ResolvedMetadata): void {
    this.map.set(doi.toLowerCase(), meta)
  }

  async byDoi(doi: string): Promise<ResolvedMetadata> {
    this.calls.push(doi)
    const meta = this.map.get(doi.toLowerCase())
    if (!meta) throw new HttpError(404, `https://doi.org/${doi}`)
    return structuredClone(meta)
  }

  byArxiv(id: string): Promise<ResolvedMetadata> {
    return this.byDoi(`10.48550/arxiv.${id}`)
  }
}

export async function setupLibrary(opts: { resolver?: Record<string, ResolvedMetadata>; routes?: Route[]; policy?: PdfPolicy } = {}) {
  const root = await tmpDir()
  const store = await ProjectStore.create(root, 'Thesis')
  if (opts.policy) await store.updateConfig({ pdfs: { policy: opts.policy } })
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  const resolver = new FakeResolver(opts.resolver)
  const fetch = routeFetch(opts.routes ?? [])
  const http = new HttpClient({ fetch, sleep: async () => {} })
  const library = new LibraryService({
    store,
    cache,
    resolver,
    http,
    extractor: new PdfjsExtractor(),
    now: () => new Date('2026-10-07T12:00:00.000Z')
  })
  return { root, store, cache, resolver, library, fetch }
}
