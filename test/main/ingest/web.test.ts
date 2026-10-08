import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { captureWebPage, findScholarlyIds, parseByline, webMetadata } from '../../../src/main/ingest/web'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8')
const URL_ = 'https://eng.acme.test/posts/database-outage'

describe('findScholarlyIds', () => {
  it('reads citation_doi meta tags', () => {
    expect(findScholarlyIds(fx('scholarly.html'))).toEqual({ doi: '10.1109/icws.2017.13' })
  })

  it('reads citation_arxiv_id meta tags', () => {
    expect(findScholarlyIds('<html><head><meta name="citation_arxiv_id" content="2008.06448v2"></head></html>')).toEqual({ arxiv: '2008.06448' })
  })

  it('finds nothing on an ordinary blog post', () => {
    expect(findScholarlyIds(fx('postmortem.html'))).toEqual({})
  })
})

describe('captureWebPage', () => {
  it('extracts the article as markdown with its metadata, without navigation chrome', () => {
    const capture = captureWebPage(fx('postmortem.html'), URL_)
    expect(capture).toMatchObject({
      title: 'Database outage postmortem',
      site: 'Acme Engineering',
      date: '2024-03-01',
      year: 2024,
      authors: [{ family: 'Roe', given: 'Jane' }]
    })
    expect(capture!.markdown).toContain('## Summary')
    expect(capture!.markdown).toMatch(/^-\s+09:12 config push$/m)
    expect(capture!.markdown).not.toContain('Home')
    expect(capture!.markdown).not.toContain('© Acme')
  })

  it('returns null when there is no readable article', () => {
    expect(captureWebPage('<html><body><p>Hi</p></body></html>', URL_)).toBeNull()
  })

  it('falls back to the hostname when the page names no site', () => {
    const html = fx('postmortem.html').replace('<meta property="og:site_name" content="Acme Engineering" />', '')
    expect(captureWebPage(html, 'https://www.eng.acme.test/x')!.site).toBe('eng.acme.test')
  })
})

describe('parseByline', () => {
  it('splits a multi-author byline and drops an editor clause', () => {
    expect(parseByline('Written by John Lunney and Sue Lueder Edited by Gary O’Connor')).toEqual([
      { family: 'Lunney', given: 'John' },
      { family: 'Lueder', given: 'Sue' }
    ])
  })

  it('strips a leading "By" and splits given/family', () => {
    expect(parseByline('By Jane Roe')).toEqual([{ family: 'Roe', given: 'Jane' }])
  })

  it('splits Spanish-style "y" lists with accented names', () => {
    expect(parseByline('Ana Pérez, Luis Gómez y Marta Ruiz')).toEqual([
      { family: 'Pérez', given: 'Ana' },
      { family: 'Gómez', given: 'Luis' },
      { family: 'Ruiz', given: 'Marta' }
    ])
  })

  it('keeps an organization name as a single family', () => {
    expect(parseByline('The Google SRE Team')).toEqual([{ family: 'The Google SRE Team' }])
  })

  it('returns an empty list for an empty byline', () => {
    expect(parseByline('')).toEqual([])
  })
})

describe('webMetadata', () => {
  it('maps a capture to library metadata', () => {
    const capture = captureWebPage(fx('postmortem.html'), URL_)!
    expect(webMetadata(capture, URL_)).toMatchObject({
      kind: 'web',
      title: 'Database outage postmortem',
      year: 2024,
      identifiers: { url: URL_ },
      web: { site: 'Acme Engineering', date: '2024-03-01' },
      complete: true
    })
  })
})
