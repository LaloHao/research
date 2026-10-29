import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { bareWebMetadata, captureWebPage, cleanPageTitle, findScholarlyIds, normalizePageUrl, parseByline, readArticle, slugTitle, webMetadata } from '../../../src/main/ingest/web'

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

describe('slugTitle', () => {
  it.each([
    [
      'https://towardsdatascience.com/how-to-validate-openai-gpt-model-performance-with-text-summarization-298978fea764/',
      'How to Validate OpenAI GPT Model Performance with Text Summarization'
    ],
    ['https://medium.com/@ana/a-guide-to-the-llm-stack-1a2b3c4d5e6f', 'A Guide to the LLM Stack'],
    ['https://blog.acme.test/2024/05/why_logs_matter.html', 'Why Logs Matter'],
    ['https://news.acme.test/story/123456', 'Story'],
    ['https://acme.test/posts/Sanitizing-Logs-With-NER', 'Sanitizing Logs With NER'],
    ['https://acme.test/es/c%C3%B3mo-anonimizar-logs', 'Cómo Anonimizar Logs'],
    ['https://www.acme.test/', 'acme.test'],
    ['https://acme.test/p/298978fea764', 'acme.test']
  ])('%s → %s', (url, title) => {
    expect(slugTitle(url)).toBe(title)
  })
})

describe('cleanPageTitle', () => {
  it('drops the site name after a separator, unless the rest is too short to be a title', () => {
    expect(cleanPageTitle('How to Validate GPT Models | Towards Data Science')).toBe('How to Validate GPT Models')
    expect(cleanPageTitle('Postmortem of the database outage - Acme Engineering')).toBe('Postmortem of the database outage')
    expect(cleanPageTitle('Home | Acme')).toBe('Home | Acme')
    expect(cleanPageTitle('  Self-Attention   explained ')).toBe('Self-Attention explained')
  })
})

describe('bareWebMetadata', () => {
  it('takes the page title (og:title first) and the site, incomplete', () => {
    const html = '<html><head><title>Ignored | Site</title><meta property="og:title" content="Logs at scale - Acme Blog"></head><body></body></html>'
    expect(bareWebMetadata(html, 'https://www.acme.test/logs-at-scale')).toEqual({
      kind: 'web',
      title: 'Logs at scale',
      authors: [],
      venue: 'acme.test',
      identifiers: { url: 'https://www.acme.test/logs-at-scale' },
      web: { site: 'acme.test' },
      complete: false
    })
  })

  it('guesses the title from the URL when the page has none', () => {
    expect(bareWebMetadata('<html><body>…</body></html>', 'https://acme.test/why-logs-matter-0a1b2c3d4e5f').title).toBe('Why Logs Matter')
    expect(bareWebMetadata(null, 'https://acme.test/why-logs-matter').title).toBe('Why Logs Matter')
  })
})

describe('normalizePageUrl', () => {
  it('gives two captures of the same page the same form', () => {
    const base = normalizePageUrl('https://towardsdatascience.com/how-to-validate-298978fea764/')
    expect(base).toBe('towardsdatascience.com/how-to-validate-298978fea764')
    for (const same of [
      'http://www.towardsdatascience.com/how-to-validate-298978fea764',
      'https://TowardsDataScience.com/how-to-validate-298978fea764/#section',
      'https://towardsdatascience.com/how-to-validate-298978fea764/?utm_source=x&utm_medium=y&source=rss&fbclid=1'
    ]) {
      expect(normalizePageUrl(same)).toBe(base)
    }
  })

  it('keeps what tells pages apart: the path, real parameters (sorted) and the port', () => {
    expect(normalizePageUrl('https://acme.test/a?b=2&a=1')).toBe('acme.test/a?a=1&b=2')
    expect(normalizePageUrl('https://acme.test/a?page=2')).not.toBe(normalizePageUrl('https://acme.test/a'))
    expect(normalizePageUrl('http://127.0.0.1:8080/post')).toBe('127.0.0.1:8080/post')
    for (const bad of ['file:///etc/passwd', 'not a url', '']) expect(normalizePageUrl(bad)).toBeNull()
  })
})

describe('readArticle', () => {
  it('returns the article HTML with what the page says about itself', () => {
    const article = readArticle(fx('postmortem.html'), URL_)!
    expect(article.content).toContain('Timeline')
    expect(article.title.length).toBeGreaterThan(0)
    expect(readArticle('<html><body><p>Hi</p></body></html>', URL_)).toBeNull()
  })
})
