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
