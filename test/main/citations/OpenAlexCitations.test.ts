import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { OpenAlexCitations } from '../../../src/main/citations/OpenAlexCitations'
import { HttpClient } from '../../../src/main/ingest/http'
import { routeFetch, type Route } from '../../helpers/fakeFetch'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')

function client(routes: Route[]) {
  const fetch = routeFetch(routes)
  return { fetch, openalex: new OpenAlexCitations(new HttpClient({ fetch, sleep: async () => {} })) }
}

describe('OpenAlexCitations', () => {
  it('reads the references of a work by id, without URL prefixes', async () => {
    const { openalex, fetch } = client([{ url: /\/works\/W2754665629\?select=/, body: fx('drain.refs.openalex.json') }])
    expect(await openalex.work('W2754665629')).toEqual({
      openalexId: 'W2754665629',
      doi: '10.1109/icws.2017.13',
      references: ['W66551789', 'W1532325895', 'W2153470728', 'W2527994611'],
      citedByCount: 904
    })
    expect(decodeURIComponent(fetch.calls[0].url)).toBe('https://api.openalex.org/works/W2754665629?select=id,doi,referenced_works,cited_by_count')
  })

  it('resolves a work by DOI and returns null for an unknown one', async () => {
    const { openalex } = client([{ url: /\/works\/doi:10\.48550\/arxiv\.2008\.06448\?/, body: fx('loghub.refs.openalex.json') }])
    expect((await openalex.workByDoi('10.48550/arXiv.2008.06448'))?.openalexId).toBe('W3049160591')
    expect(await openalex.workByDoi('10.9999/nothing')).toBeNull()
  })

  it('finds a work by exact title and year, and only when the match is unambiguous', async () => {
    const { openalex, fetch } = client([{ url: /\/works\?search=/, body: fx('drain.search.openalex.json') }])
    expect(await openalex.findByTitle('Drain: an online log parsing approach with fixed depth tree', 2017)).toBe('W2754665629')
    expect(decodeURIComponent(fetch.calls[0].url)).toContain('filter=publication_year:2017')
    expect(await openalex.findByTitle('Drain', 2017)).toBeNull()
  })

  it('pages through the works citing a paper with the cursor', async () => {
    const { openalex } = client([
      { url: /filter=cites%3AW3049160591.*cursor=\*/, body: fx('loghub.cites-1.openalex.json') },
      { url: /cursor=IlsxMDAu/, body: fx('loghub.cites-2.openalex.json') }
    ])
    const first = await openalex.citingPage('W3049160591', '*')
    expect(first).toEqual({ ids: ['W3199174176', 'W4226128225'], next: 'IlsxMDAuMCwgMjU0LCAnaHR0cHM6Ly9vcGVuYWxleC5vcmcvVzQyMjYxMjgyMjUnXSI=' })
    expect(await openalex.citingPage('W3049160591', first.next!)).toEqual({ ids: ['W3121951581'], next: null })
  })

  it('fetches metadata in batches of at most 100 ids', async () => {
    const { openalex, fetch } = client([{ url: /\/works\?filter=ids\.openalex/, body: fx('refs.batch.openalex.json') }])
    const ids = Array.from({ length: 150 }, (_, i) => `W${i + 1}`)
    const works = await openalex.worksByIds(ids)
    expect(fetch.calls).toHaveLength(2)
    expect(decodeURIComponent(fetch.calls[0].url)).toContain(`filter=ids.openalex:${ids.slice(0, 100).join('|')}`)
    expect(decodeURIComponent(fetch.calls[1].url)).toContain(`filter=ids.openalex:${ids.slice(100).join('|')}`)
    expect(works.find((w) => w.openalexId === 'W2153470728')).toEqual({
      openalexId: 'W2153470728',
      title: 'LogSig',
      year: 2011,
      authors: 'Tang et al.',
      doi: '10.1145/2063576.2063690',
      citedByCount: 249
    })
    expect(await openalex.worksByIds([])).toEqual([])
  })

  it('lets the daily-limit 429 through', async () => {
    const { openalex } = client([{ url: /\/works\/W1\?/, status: 429, headers: { 'x-ratelimit-remaining': '0' } }])
    await expect(openalex.work('W1')).rejects.toMatchObject({ status: 429 })
  })
})
