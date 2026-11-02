import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { isSvgBytes, sniffFont } from '../../extension/src/detect'
import { PageTooLargeError, serializePage, VIEWPORT_META, type ResourceFetcher } from '../../extension/src/serialize'

const BASE = 'https://blog.example.org/posts/math/'
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 9, 9])
const WOFF = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0])
const TTF = new Uint8Array([0, 1, 0, 0, 0, 0x10])
const OTF = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 9])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The site the page comes from: what the content script would fetch with the page's credentials. */
function site(files: Record<string, Uint8Array>): { fetch: ResourceFetcher; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: async (url, maxBytes) => {
      asked.push(url)
      const bytes = files[url]
      return bytes && bytes.byteLength <= maxBytes ? { bytes } : null
    }
  }
}

function page(html: string, extra: { fonts?: { family: string; status: string }[] } = {}): Document {
  const { document } = parseHTML(html)
  Object.defineProperty(document, 'baseURI', { value: BASE })
  if (extra.fonts) Object.defineProperty(document, 'fonts', { value: extra.fonts })
  return document as unknown as Document
}

const ARTICLE = `<!DOCTYPE html><html lang="en" class="js"><head><meta charset="iso-8859-1"><title>Math</title>
<link rel="stylesheet" href="/css/site.css" media="screen"><link rel="alternate stylesheet" href="/css/alt.css"><link rel="preload" href="/f.woff2" as="font">
<link rel="icon" href="/favicon.ico"><base href="https://evil.test/"><meta http-equiv="refresh" content="1;url=https://evil.test">
<style>@font-face { font-family: "Body"; src: url("../fonts/body.woff2") format("woff2"), url(../fonts/body.woff) format("woff"); }
@font-face { font-family: Unused; src: url(/fonts/unused.woff2) format("woff2"); }
body { font-family: Body, serif; background: url('/img/bg.png') }</style>
<script>document.write('x')</script></head>
<body onload="track()"><header class="cookie-banner" id="onetrust-consent-sdk">We use cookies</header>
<h1 onclick="x()">Title</h1><p>See <a href="../other/">other</a>, <a href="#s2">below</a> and <a href="javascript:alert(1)">this</a>.</p>
<picture><source srcset="/img/fig.avif" type="image/avif"><img src="/img/fig.png" srcset="/img/fig.png 1x, /img/fig@2x.png 2x" loading="lazy" alt="Figure"></picture>
<img src="https://cdn.example.net/missing.png" alt="gone"><img src="/img/logo.svg" alt="logo">
<div style="background-image: url(/img/bg.png)">styled</div>
<form><input name="q" value="typed"><input type="password" value="hunter2"><input type="checkbox" checked><textarea>notes</textarea></form>
<noscript><img src="/pixel.gif"></noscript><iframe src="https://ads.example.net/frame"></iframe><object data="/x.swf"></object>
<canvas id="chart" width="300" height="100" class="chart"></canvas>
</body></html>`

const FILES = {
  'https://blog.example.org/css/site.css': text('@import url("print.css") print;\n@import "base.css";\nh1 { color: red; background: url(../img/h1.png) }'),
  'https://blog.example.org/css/base.css': text('p { margin: 0 } .icon { background: url("icons/i.svg") }'),
  'https://blog.example.org/css/print.css': text('body { color: black }'),
  'https://blog.example.org/css/icons/i.svg': SVG,
  'https://blog.example.org/posts/fonts/body.woff2': WOFF2,
  'https://blog.example.org/posts/fonts/body.woff': WOFF,
  'https://blog.example.org/fonts/unused.woff2': WOFF2,
  'https://blog.example.org/img/bg.png': PNG,
  'https://blog.example.org/img/h1.png': PNG,
  'https://blog.example.org/img/fig.png': PNG,
  'https://blog.example.org/img/logo.svg': SVG
}

describe('serializePage', () => {
  it('inlines stylesheets (imports too, in order, with their media), used fonts and images as data: URIs', async () => {
    const { fetch, asked } = site(FILES)
    const doc = page(ARTICLE, { fonts: [{ family: 'Body', status: 'loaded' }, { family: 'Unused', status: 'unloaded' }] })
    const { html, viewportWidth, missing } = await serializePage({ doc, fetch })
    const out = parseHTML(html).document
    const styles = Array.from(out.querySelectorAll('style')).map((s) => s.textContent ?? '')
    // The linked sheet, then the page's own <style>, then the overlay rules last.
    expect(styles[0]).toContain('@media print {\nbody { color: black }\n}')
    expect(styles[0]).toContain('p { margin: 0 }')
    expect(styles[0]).toContain(`url("data:image/svg+xml;base64,${b64(SVG)}")`)
    expect(styles[0]).toContain(`h1 { color: red; background: url("data:image/png;base64,${b64(PNG)}") }`)
    expect(out.querySelectorAll('style')[0]!.getAttribute('media')).toBe('screen')
    expect(styles[1]).toContain(`src: url("data:font/woff2;base64,${b64(WOFF2)}") format("woff2"), url(../fonts/body.woff) format("woff")`)
    expect(styles[1]).not.toContain('Unused')
    expect(styles[1]).toContain(`background: url("data:image/png;base64,${b64(PNG)}")`)
    expect(styles.at(-1)).toContain('#onetrust-consent-sdk')
    // Only what is used: not the unused font, the second font source, the alternate sheet or the avif source.
    expect(asked).not.toContain('https://blog.example.org/fonts/unused.woff2')
    expect(asked).not.toContain('https://blog.example.org/posts/fonts/body.woff')
    expect(asked).not.toContain('https://blog.example.org/pixel.gif')
    expect(asked).not.toContain('https://blog.example.org/css/alt.css')
    expect(asked).not.toContain('https://blog.example.org/img/fig.avif')
    expect(asked.filter((u) => u.endsWith('bg.png'))).toHaveLength(1)
    expect(viewportWidth).toBe(1280)
    expect(missing).toBe(1)

    const fig = out.querySelector('img[alt="Figure"]')!
    expect(fig.getAttribute('src')).toBe(`data:image/png;base64,${b64(PNG)}`)
    expect(fig.hasAttribute('srcset') || fig.hasAttribute('loading')).toBe(false)
    expect(out.querySelector('picture source')).toBeNull()
    expect(out.querySelector('img[alt="logo"]')!.getAttribute('src')).toBe(`data:image/svg+xml;base64,${b64(SVG)}`)
    // An image that could not be fetched keeps its absolute address (the app shows nothing there).
    expect(out.querySelector('img[alt="gone"]')!.getAttribute('src')).toBe('https://cdn.example.net/missing.png')
    expect(out.querySelector('div[style]')!.getAttribute('style')).toBe(`background-image: url("data:image/png;base64,${b64(PNG)}")`)
  })

  it('leaves out scripts, noscript, handlers, frames, objects, base, refresh, consent overlays and javascript: links; makes links absolute', async () => {
    const { fetch } = site(FILES)
    const { html } = await serializePage({ doc: page(ARTICLE), fetch })
    expect(html).not.toMatch(/<script|<noscript|onload|onclick|<object|<base|refresh|evil\.test|javascript:|We use cookies|rel="preload"|rel="icon"|<link/)
    const out = parseHTML(html).document
    expect(Array.from(out.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://blog.example.org/posts/other/', '#s2', null])
    expect(out.querySelector('iframe')!.hasAttribute('src')).toBe(false)
  })

  it('keeps the doctype and the root, says the width in a meta tag, uses utf-8, the form as it is, but never a typed password', async () => {
    const { fetch } = site(FILES)
    const doc = page(ARTICLE)
    // What the user did on the page, which the attributes don't show.
    Object.defineProperty(doc.querySelector('input[name="q"]'), 'value', { value: 'what I typed' })
    Object.defineProperty(doc.querySelector('input[type="checkbox"]'), 'checked', { value: false })
    Object.defineProperty(doc.querySelector('textarea'), 'value', { value: 'my notes' })
    const { html } = await serializePage({ doc, fetch })
    expect(html.startsWith('<!DOCTYPE html><html lang="en" class="js">')).toBe(true)
    const out = parseHTML(html).document
    const [charset, width] = Array.from(out.head.children)
    expect(charset!.outerHTML).toBe('<meta charset="utf-8">')
    expect(width!.getAttribute('name')).toBe(VIEWPORT_META)
    expect(width!.getAttribute('content')).toBe('1280')
    expect(out.querySelectorAll('meta[charset]')).toHaveLength(1)
    expect(out.querySelector('input[name="q"]')!.getAttribute('value')).toBe('what I typed')
    expect(out.querySelector('input[type="password"]')!.hasAttribute('value')).toBe(false)
    expect(out.querySelector('input[type="checkbox"]')!.hasAttribute('checked')).toBe(false)
    expect(out.querySelector('textarea')!.textContent).toBe('my notes')
  })

  it('turns a canvas into an image of what it shows, keeping its id, class and size', async () => {
    const doc = page(ARTICLE)
    const canvas = doc.querySelector('canvas')!
    Object.defineProperty(Object.getPrototypeOf(canvas), 'toDataURL', { configurable: true, value: () => `data:image/png;base64,${b64(PNG)}` })
    const { html } = await serializePage({ doc, fetch: site(FILES).fetch })
    const img = parseHTML(html).document.querySelector('img#chart')!
    expect(img.getAttribute('class')).toBe('chart')
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['300', '100'])
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${b64(PNG)}`)
    expect(parseHTML(html).document.querySelector('canvas')).toBeNull()
  })

  it('keeps to its limits: a font or image past the size, the total or the count stays a link; a page too large is refused', async () => {
    const big = new Uint8Array(2000).fill(1)
    big.set(PNG)
    const { fetch } = site({ ...FILES, 'https://blog.example.org/img/fig.png': big })
    const { html, missing } = await serializePage({ doc: page(ARTICLE), fetch, limits: { resource: 1000 } })
    expect(parseHTML(html).document.querySelector('img[alt="Figure"]')!.getAttribute('src')).toBe('https://blog.example.org/img/fig.png')
    expect(missing).toBeGreaterThanOrEqual(2)
    const few = await serializePage({ doc: page(ARTICLE), fetch: site(FILES).fetch, limits: { resources: 1 } })
    // One resource inlined (used maybe more than once), the rest left as links.
    expect(new Set(few.html.match(/data:(image|font)\/[^"')]+/g)).size).toBe(1)
    await expect(serializePage({ doc: page(ARTICLE), fetch: site(FILES).fetch, limits: { html: 1000 } })).rejects.toBeInstanceOf(PageTooLargeError)
  })

  it('only inlines what really is a font or an image', async () => {
    const { fetch } = site({ ...FILES, 'https://blog.example.org/posts/fonts/body.woff2': text('<html>404</html>'), 'https://blog.example.org/img/fig.png': text('<script>x</script>') })
    const { html } = await serializePage({ doc: page(ARTICLE), fetch })
    // The second source of the font is tried when the first is not a font.
    expect(html).toContain(`url("data:font/woff;base64,${b64(WOFF)}") format("woff")`)
    expect(parseHTML(html).document.querySelector('img[alt="Figure"]')!.getAttribute('src')).toBe('https://blog.example.org/img/fig.png')
  })
})

describe('sniffing', () => {
  it('tells web fonts by their first bytes', () => {
    expect(sniffFont(WOFF2)).toBe('woff2')
    expect(sniffFont(WOFF)).toBe('woff')
    expect(sniffFont(TTF)).toBe('ttf')
    expect(sniffFont(text('true....'))).toBe('ttf')
    expect(sniffFont(OTF)).toBe('otf')
    expect(sniffFont(PNG)).toBeNull()
    expect(sniffFont(text('<html>'))).toBeNull()
    expect(sniffFont(new Uint8Array([0x77]))).toBeNull()
  })

  it('tells an SVG image from other markup', () => {
    expect(isSvgBytes(SVG)).toBe(true)
    expect(isSvgBytes(text('<!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg viewBox="0 0 1 1"></svg>'))).toBe(true)
    expect(isSvgBytes(text('<html><svg></svg></html>'))).toBe(false)
    expect(isSvgBytes(PNG)).toBe(false)
  })
})
