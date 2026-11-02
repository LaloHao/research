import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { HttpClient } from '../../../src/main/ingest/http'
import { invertedIndexToText, MetadataResolver } from '../../../src/main/ingest/MetadataResolver'
import { routeFetch, type Route } from '../../helpers/fakeFetch'

const CSL = 'application/vnd.citationstyles.csl+json'
const BIB = 'application/x-bibtex'
const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')

function routes(prefix: string, doi: string, openalex = true): Route[] {
  return [
    { url: `https://doi.org/${doi}`, accept: CSL, body: fx(`${prefix}.csl.json`) },
    { url: `https://doi.org/${doi}`, accept: BIB, body: fx(`${prefix}.bib`) },
    ...(openalex ? [{ url: `https://api.openalex.org/works/doi:${doi}`, body: fx(`${prefix}.openalex.json`) }] : [])
  ]
}

const resolver = (r: Route[], contactEmail?: string): MetadataResolver =>
  new MetadataResolver(new HttpClient({ fetch: routeFetch(r), contactEmail, sleep: async () => {} }))

describe('MetadataResolver', () => {
  it('resolves a Crossref DOI with BibTeX and OpenAlex enrichment', async () => {
    const meta = await resolver(routes('drain', '10.1109/icws.2017.13')).byDoi('10.1109/ICWS.2017.13')
    expect(meta).toMatchObject({
      kind: 'conference',
      title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
      year: 2017,
      venue: '2017 IEEE International Conference on Web Services (ICWS)',
      identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2754665629' },
      complete: true
    })
    expect(meta.authors[0]).toEqual({ family: 'He', given: 'Pinjia' })
    expect(meta.bibtex).toMatch(/^@inproceedings\{/)
    expect(meta.abstract?.length).toBeGreaterThan(50)
    expect(meta.oa_pdf_url).toBeUndefined()
  })

  it('resolves an arXiv id as a preprint with its PDF', async () => {
    const meta = await resolver(routes('loghub', '10.48550/arxiv.2008.06448')).byArxiv('2008.06448')
    expect(meta).toMatchObject({
      kind: 'preprint',
      year: 2020,
      identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448', openalex: 'W3049160591' },
      oa_pdf_url: 'https://arxiv.org/pdf/2008.06448'
    })
    expect(meta.title).toContain('Loghub')
    expect(meta.bibtex).toMatch(/^@misc\{/)
  })

  it('still resolves when OpenAlex is unavailable', async () => {
    const meta = await resolver(routes('drain', '10.1109/icws.2017.13', false)).byDoi('10.1109/icws.2017.13')
    expect(meta.identifiers.openalex).toBeUndefined()
    expect(meta.title).toContain('Drain')
  })

  it('rejects when the DOI does not exist', async () => {
    await expect(resolver([]).byDoi('10.9999/missing')).rejects.toMatchObject({ name: 'HttpError', status: 404 })
  })

  it('asks OpenAlex through the polite pool when an email is set', async () => {
    const r: Route[] = [
      ...routes('drain', '10.1109/icws.2017.13', false),
      { url: /^https:\/\/api\.openalex\.org\/works\/doi:10\.1109\/icws\.2017\.13\?mailto=me%40uni\.test$/, body: fx('drain.openalex.json') }
    ]
    const meta = await resolver(r, 'me@uni.test').byDoi('10.1109/icws.2017.13')
    expect(meta.identifiers.openalex).toBe('W2754665629')
  })
})

describe('MetadataResolver.byOpenAlex', () => {
  it('builds the metadata from OpenAlex for a work without a DOI', async () => {
    const meta = await resolver([{ url: /api\.openalex\.org\/works\/W2132031035\?select=/, body: fx('consolelogs.openalex.json') }]).byOpenAlex('W2132031035')
    expect(meta).toEqual({
      kind: 'article',
      title: 'System problem detection by mining console logs',
      authors: [
        { family: 'Patterson', given: 'David A.' },
        { family: 'Xu', given: 'Wei' }
      ],
      year: 2010,
      abstract: 'Surprisingly, console logs rarely help operators detect problems',
      identifiers: { openalex: 'W2132031035' },
      complete: true
    })
  })

  it('goes through the DOI when the OpenAlex work has one', async () => {
    const meta = await resolver([
      ...routes('drain', '10.1109/icws.2017.13'),
      { url: /api\.openalex\.org\/works\/W2754665629\?select=/, body: fx('drain.openalex.json') }
    ]).byOpenAlex('W2754665629')
    expect(meta).toMatchObject({
      title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
      identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2754665629' }
    })
  })
})

describe('invertedIndexToText', () => {
  it('rebuilds the abstract word order', () => {
    expect(invertedIndexToText({ logs: [1], parsing: [2], Online: [0], logs2: [] })).toBe('Online logs parsing')
  })
})

describe('MetadataResolver.byIsbn', () => {
  const OL = 'https://openlibrary.org/api/books?bibkeys=ISBN:9781491929124&format=json&jscmd=data'
  const GOOGLE = 'https://www.googleapis.com/books/v1/volumes?q=isbn:9781491929124'

  it('resolves a book from Open Library as an edited @book with publisher and ISBN', async () => {
    const fetch = routeFetch([{ url: OL, body: fx('sre-book.openlibrary.json') }])
    const meta = await new MetadataResolver(new HttpClient({ fetch, sleep: async () => {} })).byIsbn('9781491929124')
    expect(meta).toMatchObject({
      kind: 'book',
      title: 'Site Reliability Engineering: How Google Runs Production Systems',
      year: 2016,
      venue: "O'Reilly Media, Inc.",
      identifiers: { isbn: '9781491929124' },
      complete: true
    })
    expect(meta.authors.slice(0, 2)).toEqual([
      { family: 'Beyer', given: 'Betsy' },
      { family: 'Jones', given: 'Chris' }
    ])
    expect(meta.bibtex).toMatch(/^@book\{isbn,/)
    expect(meta.bibtex).toMatch(/editor = \{Beyer, Betsy and Jones, Chris and/)
    expect(meta.bibtex).not.toMatch(/\bauthor =/)
    expect(meta.bibtex).toContain('isbn = {9781491929124}')
    expect(meta.bibtex).toContain('year = {2016}')
    // Open Library had everything: Google Books is not asked.
    expect(fetch.calls.map((c) => c.url)).toEqual([OL])
  })

  it('fills what Open Library lacks from Google Books', async () => {
    const google = { items: [{ volumeInfo: { title: 'Postmortems', authors: ['Ana López'], publisher: 'Acme Press', publishedDate: '2021-05-02', description: '<p>About <b>incidents</b>.</p>' } }] }
    const meta = await resolver([
      { url: OL, body: JSON.stringify({ 'ISBN:9781491929124': { title: 'Postmortems' } }) },
      { url: GOOGLE, body: JSON.stringify(google) }
    ]).byIsbn('9781491929124')
    expect(meta).toMatchObject({ title: 'Postmortems', authors: [{ family: 'López', given: 'Ana' }], year: 2021, venue: 'Acme Press', abstract: 'About incidents .', complete: true })
    expect(meta.bibtex).toMatch(/author = \{López, Ana\}/)
  })

  it('uses Google Books alone when Open Library has no such book, and fails as not found when neither has it', async () => {
    const google = { items: [{ volumeInfo: { title: 'Only in Google', authors: ['X Y'], publishedDate: '2019' } }] }
    expect((await resolver([{ url: OL, body: '{}' }, { url: GOOGLE, body: JSON.stringify(google) }]).byIsbn('9781491929124')).title).toBe('Only in Google')
    // Google Books without quota (429) and nothing in Open Library.
    await expect(resolver([{ url: OL, body: '{}' }, { url: GOOGLE, status: 429, body: '{}' }]).byIsbn('9781491929124')).rejects.toMatchObject({ status: 404, url: OL })
  })

  it("reports Open Library's own failure, not «not found», when Google Books can't fill in", async () => {
    await expect(resolver([{ url: OL, status: 503, body: 'down' }, { url: GOOGLE, status: 429, body: '{}' }]).byIsbn('9781491929124')).rejects.toMatchObject({ status: 503 })
  })
})
