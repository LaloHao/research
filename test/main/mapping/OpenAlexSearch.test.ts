import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HttpClient } from '../../../src/main/ingest/http'
import { invertedIndexToText } from '../../../src/main/ingest/MetadataResolver'
import { openAlexFilter, OpenAlexSearch, searchFilter } from '../../../src/main/mapping/OpenAlexSearch'
import { routeFetch } from '../../helpers/fakeFetch'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const client = (routes: Parameters<typeof routeFetch>[0]) => {
  const fetch = routeFetch(routes)
  return { fetch, search: new OpenAlexSearch(new HttpClient({ fetch, sleep: async () => {}, contactEmail: 'me@uni.test', openalexApiKey: 'secret' })) }
}

describe('openAlexFilter', () => {
  it('writes the year range and the types the way OpenAlex reads them', () => {
    expect(openAlexFilter({ fromYear: 2015, toYear: 2026, types: ['article', 'preprint'] })).toBe('publication_year:2015-2026,type:article|preprint')
    expect(openAlexFilter({ fromYear: 2015, toYear: null, types: [] })).toBe('publication_year:>2014')
    expect(openAlexFilter({ fromYear: null, toYear: 2020, types: [] })).toBe('publication_year:<2021')
    expect(openAlexFilter({ fromYear: null, toYear: null, types: [] })).toBeNull()
  })
})

describe('searchFilter', () => {
  it('searches title and abstract with the exact (no-stem) search, before the year and type filters', () => {
    expect(searchFilter('log anonymization', 'publication_year:2015-2026')).toBe('title_and_abstract.search.exact:log anonymization,publication_year:2015-2026')
    expect(searchFilter('logs', null)).toBe('title_and_abstract.search.exact:logs')
  })

  it('keeps boolean operators, quotes and wildcards as typed', () => {
    const q = '(log OR logs OR "log data") AND (anonymi* OR sanitiz* OR "de-identif*" OR PII)'
    expect(searchFilter(q, null)).toBe(`title_and_abstract.search.exact:${q}`)
  })

  it('refuses a comma or a pipe, which OpenAlex reads as filter separators', () => {
    expect(() => searchFilter('logs, traces', null)).toThrow('search_query_separator')
    expect(() => searchFilter('logs|traces', null)).toThrow('search_query_separator')
    expect(() => searchFilter(' !logs', null)).toThrow('search_query_separator')
    expect(searchFilter('logs AND NOT traces!', null)).toBe('title_and_abstract.search.exact:logs AND NOT traces!')
  })
})

describe('OpenAlexSearch', () => {
  it('reads a page of results as candidates, with abstracts, DOIs, kinds and the cursor of the next page', async () => {
    const { search, fetch } = client([{ url: /\/works\?filter=title_and_abstract\.search\.exact%3Alog\+anonymization%2Cpublication_year%3A2015-2026&select=.*cursor=\*/, body: fx('mapping.search-1.openalex.json') }])
    const page = await search.page('log anonymization', 'publication_year:2015-2026', '*')
    expect(page.total).toBe(3)
    expect(page.next).toBe('IlsxMDAuMCwgJ1czMDAwMDAwMDAxJ10i')
    expect(page.works).toEqual([
      {
        title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
        authors: [
          { family: 'He', given: 'Pinjia' },
          { family: 'Zhu', given: 'Jieming' }
        ],
        year: 2017,
        venue: '2017 IEEE International Conference on Web Services (ICWS)',
        abstract: 'Logs record what a system does.',
        kind: 'article',
        identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2754665629' }
      },
      {
        title: 'Anonymizing operational logs with language models',
        authors: [{ family: 'López', given: 'Ana María' }],
        year: 2024,
        venue: null,
        abstract: null,
        kind: 'preprint',
        identifiers: { openalex: 'W3000000001' }
      }
    ])
    expect(fetch.calls[0].url).toContain('per-page=100')
    expect(fetch.calls[0].url).toContain('mailto=me%40uni.test')
  })

  it('logs the request without the contact email or the API key', () => {
    const { search } = client([])
    expect(search.requestUrl('log anonymization', 'publication_year:2015-2026')).toBe(
      'https://api.openalex.org/works?filter=title_and_abstract.search.exact%3Alog+anonymization%2Cpublication_year%3A2015-2026'
    )
    expect(search.requestUrl('logs', null)).toBe('https://api.openalex.org/works?filter=title_and_abstract.search.exact%3Alogs')
  })

  it('reads the last page and a review as an article', async () => {
    const { search } = client([{ url: /cursor=IlsxMDAu/, body: fx('mapping.search-2.openalex.json') }])
    const page = await search.page('log anonymization', null, 'IlsxMDAuMCwgJ1czMDAwMDAwMDAxJ10i')
    expect(page.next).toBeNull()
    expect(page.works[0]).toMatchObject({ kind: 'article', identifiers: { doi: '10.5555/mask.2023', openalex: 'W3000000002' }, abstract: 'We mask secrets in logs.' })
  })

  it('reads a conference paper as a conference paper', async () => {
    const body = JSON.stringify({
      meta: { count: 1, next_cursor: null },
      results: [{ id: 'https://openalex.org/W4384345635', title: 'Recommending Root-Cause and Mitigation Steps for Cloud Incidents', publication_year: 2023, type: 'conference-paper' }]
    })
    const { search } = client([{ url: /cursor=/, body }])
    const page = await search.page('incidents', null, '*')
    expect(page.works[0]).toMatchObject({ kind: 'conference', identifiers: { openalex: 'W4384345635' } })
  })

  it('looks works up by id, 100 per request, leaving out works without a title', async () => {
    const { search, fetch } = client([{ url: /filter=ids\.openalex%3A/, body: fx('mapping.works.openalex.json') }])
    const ids = Array.from({ length: 150 }, (_, i) => `W${3000000003 + i}`)
    const works = await search.works(ids)
    expect(fetch.calls).toHaveLength(2)
    expect(decodeURIComponent(fetch.calls[0].url)).toContain(`ids.openalex:${ids.slice(0, 100).join('|')}`)
    expect(works.map((w) => w.identifiers.openalex)).toEqual(['W3000000003', 'W3000000003'])
  })

  it('sends the contact email and the API key only in the fetched URL, never in the logged one', async () => {
    const { search, fetch } = client([{ url: /cursor=/, body: fx('mapping.search-2.openalex.json') }])
    await search.page('logs', null, '*')
    expect(fetch.calls[0].url).toContain('api_key=secret')
    const logged = search.requestUrl('logs', null)
    expect(logged).not.toContain('mailto')
    expect(logged).not.toContain('me%40uni.test')
    expect(logged).not.toContain('api_key')
    expect(logged).not.toContain('secret')
  })

  it('never sends the search string as `search` (full text, stemmed: OpenAlex refuses wildcards there)', async () => {
    const { search, fetch } = client([{ url: /cursor=/, body: fx('mapping.search-2.openalex.json') }])
    await search.page('anonymi*', null, '*')
    expect(fetch.calls[0].url).not.toMatch(/[?&]search=/)
    expect(decodeURIComponent(fetch.calls[0].url.replace(/\+/g, ' '))).toContain('filter=title_and_abstract.search.exact:anonymi*&')
  })

  it('makes no request for a query with a filter separator', async () => {
    const { search, fetch } = client([])
    await expect(search.search('logs, traces', null, 10)).rejects.toThrow('search_query_separator')
    expect(fetch.calls).toHaveLength(0)
  })

  it('makes no request for an empty id list', async () => {
    const { search, fetch } = client([])
    expect(await search.works([])).toEqual([])
    expect(fetch.calls).toHaveLength(0)
  })

  it('pages up to the cap, says when OpenAlex had more, and stops on the last page', async () => {
    const routes = [
      { url: /cursor=\*/, body: fx('mapping.search-1.openalex.json') },
      { url: /cursor=IlsxMDAu/, body: fx('mapping.search-2.openalex.json') }
    ]
    const all = client(routes)
    const done = await all.search.search('logs', null, 500)
    expect(done).toMatchObject({ total: 3, capped: false })
    expect(done.works.map((w) => w.identifiers.openalex)).toEqual(['W2754665629', 'W3000000001', 'W3000000002'])
    expect(all.fetch.calls).toHaveLength(2)

    const capped = client(routes)
    const one = await capped.search.search('logs', null, 1)
    expect(one).toMatchObject({ total: 3, capped: true })
    expect(one.works).toHaveLength(1)
    expect(capped.fetch.calls).toHaveLength(1)
    expect(capped.fetch.calls[0].url).toContain('per-page=1&')
  })

  it('never pages past the maximum cap and stops when OpenAlex repeats a cursor', async () => {
    const page = (n: number) =>
      JSON.stringify({
        meta: { count: 1_000_000, next_cursor: 'same' },
        results: Array.from({ length: 100 }, (_, i) => ({ id: `https://openalex.org/W${n * 100 + i + 1}`, title: `Work ${n * 100 + i}` }))
      })
    const loop = client([{ url: /cursor=/, body: page(0) }])
    const looped = await loop.search.search('logs', null, 5000)
    expect(loop.fetch.calls).toHaveLength(2)
    expect(looped.capped).toBe(true)

    let n = 0
    const fetch = async (): Promise<Response> => new Response(JSON.stringify({ meta: { count: 1_000_000, next_cursor: `c${++n}` }, results: JSON.parse(page(n)).results }))
    const big = new OpenAlexSearch(new HttpClient({ fetch, sleep: async () => {} }))
    const res = await big.search('logs', null, 1_000_000)
    expect(n).toBe(50)
    expect(res.works).toHaveLength(5000)
    expect(res.capped).toBe(true)
  })

  it('keeps a work whose abstract index is malformed, with what can be read of it', async () => {
    const body = JSON.stringify({
      meta: { count: 1, next_cursor: null },
      results: [
        { id: 'https://openalex.org/W1', title: 'A', abstract_inverted_index: { ok: [1], first: [0], bad: 'x', neg: [-1], frac: [1.5], huge: [1e12], nul: null } },
        { id: 'https://openalex.org/W2', title: 'B', abstract_inverted_index: ['not', 'an', 'object'], authorships: 'nope', primary_location: { source: { display_name: 7 } } },
        { id: 7, title: 'C' },
        { id: 'https://openalex.org/W3', title: '  ', display_name: 'D', publication_year: '2020', doi: 42, type: 'review' }
      ]
    })
    const { search } = client([{ url: /cursor=/, body }])
    const { works } = await search.page('x', null, '*')
    expect(works.map((w) => [w.title, w.abstract, w.year, w.kind, w.identifiers])).toEqual([
      ['A', 'first ok', null, null, { openalex: 'W1' }],
      ['B', null, null, null, { openalex: 'W2' }],
      ['D', null, null, 'article', { openalex: 'W3' }]
    ])
    expect(works[1].authors).toEqual([])
    expect(works[1].venue).toBeNull()
  })

  it('reads a page without results or meta as an empty last page', async () => {
    const { search } = client([{ url: /cursor=/, body: '{}' }])
    expect(await search.page('x', null, '*')).toEqual({ works: [], next: null, total: 0 })
  })
})

describe('invertedIndexToText', () => {
  it('ignores malformed positions and words, and holes do not allocate', () => {
    expect(invertedIndexToText({ b: [2], a: [0], gap: [1e12], '': [1] })).toBe('a b')
    expect(invertedIndexToText(null as never)).toBe('')
    expect(invertedIndexToText({ x: 'y' } as never)).toBe('')
  })
})
