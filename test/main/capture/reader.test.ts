import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readArticle } from '../../../src/main/ingest/web'
import { buildReaderHtml, embedImages, isPrivateHost, READER_CSP, sanitizeArticle, sniffImage, suppliedImageFetcher } from '../../../src/main/capture/reader'

const BASE = 'https://blog.acme.test/posts/outage/'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1])

describe('sanitizeArticle', () => {
  it('strips scripts, styles, frames, forms, objects and media with their content', () => {
    const html = sanitizeArticle(
      `<p>Kept</p><script>alert(1)</script><style>body{background:url(https://evil.test/x)}</style><iframe src="https://evil.test"></iframe>
       <form action="https://evil.test"><input name="q"><button>Go</button></form><object data="x.swf"></object><embed src="x"><svg><script>1</script></svg>
       <noscript><img src="https://evil.test/track.gif"></noscript><video src="v.mp4"></video><link rel="stylesheet" href="https://evil.test/s.css"><!-- note -->`,
      BASE
    )
    expect(html.trim()).toBe('<p>Kept</p>')
  })

  it('drops event handlers, class, id and style attributes, and javascript: links', () => {
    const html = sanitizeArticle(
      `<p onclick="steal()" class="lead" id="x" style="background:url(https://evil.test/y)">Text <a href="javascript:alert(1)" onmouseover="x()">bad</a> <a href="/about" target="_blank" rel="x">good</a></p>
       <img src="pic.png" onerror="steal()" alt="A chart" width="640" height="abc" style="x" loading="lazy">`,
      BASE
    )
    expect(html).not.toMatch(/onclick|onerror|onmouseover|class=|id=|style=|javascript:|target=|loading=|height=/)
    expect(html).toContain('<a>bad</a>')
    expect(html).toContain('<a href="https://blog.acme.test/about">good</a>')
    expect(html).toContain('<img src="https://blog.acme.test/posts/outage/pic.png" alt="A chart" width="640">')
  })

  it('keeps the structure a reader needs: headings, lists, code, tables, quotes, figures and captions', () => {
    const source = `<h2>Timeline</h2><ol start="3"><li>One</li></ol><ul><li>Two</li></ul><pre><code class="language-sql">SELECT 1;</code></pre>
      <table><caption>Costs</caption><thead><tr><th scope="col" colspan="2">H</th></tr></thead><tbody><tr><td rowspan="2">1</td></tr></tbody></table>
      <blockquote><p>Quote</p></blockquote><figure><img src="/a.jpg" alt="x"><figcaption>Figure 1. Latency</figcaption></figure>`
    const html = sanitizeArticle(source, BASE)
    for (const part of ['<h2>Timeline</h2>', '<ol start="3">', '<li>Two</li>', '<pre><code>SELECT 1;</code></pre>', '<caption>Costs</caption>', '<th scope="col" colspan="2">H</th>', '<td rowspan="2">1</td>', '<blockquote><p>Quote</p></blockquote>', '<figcaption>Figure 1. Latency</figcaption>']) {
      expect(html).toContain(part)
    }
  })

  it('unwraps unknown tags, keeping their text', () => {
    expect(sanitizeArticle('<custom-card><font color="red">Inside <marquee>moving</marquee></font></custom-card>', BASE)).toBe('Inside moving')
  })

  it('resolves lazy images and srcset against the page, and removes images without a web source', () => {
    const html = sanitizeArticle(
      `<img data-src="../img/lazy.png"><img srcset="//cdn.acme.test/a-400.jpg 400w, //cdn.acme.test/a-800.jpg 800w"><img src="file:///etc/passwd"><img src="javascript:alert(1)">`,
      BASE
    )
    expect(html).toBe('<img src="https://blog.acme.test/posts/img/lazy.png"><img src="https://cdn.acme.test/a-400.jpg">')
  })
})

describe('buildReaderHtml', () => {
  const article = { title: 'Postmortem: the <database> outage', byline: 'Jane Roe & Ann Lee', site: 'Acme Engineering', date: '2024-05-02' }
  const source = { url: 'https://blog.acme.test/posts/outage?x=1&y=2', accessed: new Date('2026-10-29T12:00:00Z') }

  it('puts the site, title, byline, date, source URL and access date in a header, escaped', () => {
    const html = buildReaderHtml(article, '<p>Body text.</p>', source)
    expect(html).toContain('<p class="site">Acme Engineering</p>')
    expect(html).toContain('<h1>Postmortem: the &lt;database&gt; outage</h1>')
    expect(html).toContain('<title>Postmortem: the &lt;database&gt; outage</title>')
    expect(html).toContain('<p class="byline">Jane Roe &amp; Ann Lee</p>')
    expect(html).toContain('<p class="date">2024-05-02</p>')
    expect(html).toContain('Source: https://blog.acme.test/posts/outage?x=1&amp;y=2 · Accessed: 2026-10-29')
    expect(html).toContain('<main><p>Body text.</p></main>')
  })

  it('ships a policy without scripts, loading only data: images, and leaves out empty header lines', () => {
    const html = buildReaderHtml({ ...article, byline: '', date: undefined }, '<p>x</p>', source)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">`)
    expect(READER_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    expect(html).not.toContain('class="byline"')
    expect(html).not.toContain('class="date"')
    expect(html).not.toMatch(/<script/i)
  })

  it('drops a first heading that repeats the title and a first paragraph that repeats the byline', () => {
    const html = buildReaderHtml(article, '<h1>Postmortem:  the &lt;database&gt; outage</h1><p>By Jane Roe &amp; Ann Lee</p><p>Body</p>', source)
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).toContain('<main><p>Body</p></main>')
  })

  it('builds the reader view of a real article: header from Readability, sanitized content', () => {
    const page = readFileSync(new URL('../../fixtures/web/postmortem.html', import.meta.url), 'utf8')
    const found = readArticle(page, 'https://eng.acme.test/posts/database-outage')!
    const html = buildReaderHtml(found, sanitizeArticle(found.content, 'https://eng.acme.test/posts/database-outage'), source)
    expect(html).toContain(`<h1>${found.title}</h1>`)
    expect(html).toContain('Timeline')
    expect(html).not.toMatch(/<script|<nav|<form/i)
  })
})

describe('embedImages', () => {
  it('embeds fetched images as data:, once per URL, and removes those it cannot fetch or that are not raster images', async () => {
    const asked: string[] = []
    const images: Record<string, Uint8Array> = { 'https://cdn.acme.test/a.png': PNG, 'https://blog.acme.test/b.jpg': JPEG, 'https://cdn.acme.test/c.svg': new TextEncoder().encode('<svg onload="x()"/>') }
    const html = await embedImages(
      '<img src="https://cdn.acme.test/a.png" alt="a"><img src="https://cdn.acme.test/a.png"><img src="https://blog.acme.test/b.jpg"><img src="https://cdn.acme.test/c.svg"><img src="https://cdn.acme.test/404.png">',
      BASE,
      async (url) => (asked.push(url), images[url] ?? null)
    )
    expect(asked).toEqual(['https://cdn.acme.test/a.png', 'https://blog.acme.test/b.jpg', 'https://cdn.acme.test/c.svg', 'https://cdn.acme.test/404.png'])
    const pngData = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    expect(html).toBe(`<img src="${pngData}" alt="a"><img src="${pngData}"><img src="data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}">`)
  })

  it('never fetches a private or loopback host unless the page itself is there, and keeps to the limits', async () => {
    const asked: string[] = []
    const fetcher = async (url: string) => (asked.push(url), PNG)
    const html = await embedImages('<img src="http://127.0.0.1:8080/a.png"><img src="http://192.168.1.2/b.png"><img src="http://localhost/c.png">', BASE, fetcher)
    expect(html).toBe('')
    expect(asked).toEqual([])
    const local = await embedImages('<img src="http://127.0.0.1:8080/a.png">', 'http://127.0.0.1:8080/post', fetcher)
    expect(local).toContain('data:image/png;base64,')
    asked.length = 0
    const many = await embedImages('<img src="https://cdn.acme.test/1.png"><img src="https://cdn.acme.test/2.png"><img src="https://cdn.acme.test/3.png">', BASE, fetcher, { count: 2, bytes: 100, total: 1000 })
    expect(many.match(/<img/g)).toHaveLength(2)
    expect(asked).toHaveLength(2)
  })

  it('embeds the images the browser extension sent, matched by URL, and drops the rest', async () => {
    const fetcher = suppliedImageFetcher([
      { url: 'https://cdn.acme.test/a.png#frag', data: PNG },
      { url: 'not a url', data: JPEG }
    ])
    const html = await embedImages('<img src="https://cdn.acme.test/a.png"><img src="https://cdn.acme.test/b.png">', BASE, fetcher)
    expect(html).toBe(`<img src="data:image/png;base64,${Buffer.from(PNG).toString('base64')}">`)
    // Larger than what is left of the limits: left out like a fetched one.
    expect(await fetcher('https://cdn.acme.test/a.png', PNG.byteLength - 1)).toBeNull()
  })

  it('tells raster images by their bytes and private hosts by their address', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPEG)).toBe('jpeg')
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('gif')
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '[::1]', 'fd00::1']) expect(isPrivateHost(host)).toBe(true)
    for (const host of ['cdn.acme.test', '8.8.8.8', '172.32.0.1', 'miro.medium.com']) expect(isPrivateHost(host)).toBe(false)
  })
})
