import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { PAGE_CSP, sanitizePageHtml } from '../../../src/main/capture/page'
import { PAGE_PARTITION, pageWindowOptions, READER_PARTITION } from '../../../src/main/capture/policy'
import { asSeenPrintOptions, layoutWidth, withScreenMedia } from '../../../src/main/capture/screen'

const FONT = 'data:font/woff2;base64,d09GMgABAAAAAA=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('sanitizePageHtml', () => {
  const page = `<!DOCTYPE html><html lang="en" class="js"><head><meta charset="windows-1252"><meta http-equiv="refresh" content="0;url=https://evil.test">
    <meta http-equiv="Content-Security-Policy" content="style-src 'none'"><base href="https://evil.test/"><link rel="stylesheet" href="https://cdn.test/s.css">
    <link rel="preload" href="https://cdn.test/f.woff2"><style>@font-face{font-family:W;src:url(${FONT}) format("woff2")} body{font-family:W}</style>
    <script>alert(1)</script></head><body onload="alert(1)" style="background:#fff">
    <h1 onclick="x()">Title</h1><noscript><img src="https://evil.test/pixel.gif"></noscript>
    <a href="https://example.org/ref">ref</a> <a href="javascript:alert(1)">js</a> <a href="#sec">sec</a> <a href="mailto:a@b.test">mail</a>
    <img src="${PNG}" srcset="${PNG} 1x, https://cdn.test/big.png 2x" alt="fig"> <img src="https://cdn.test/remote.png" alt="remote">
    <form action="https://evil.test/post"><input type="image" src="https://evil.test/i.png"><button formaction="https://evil.test">Go</button></form>
    <object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x"><iframe src="https://ads.test/frame"></iframe>
    <iframe srcdoc="&lt;p onclick=&quot;x()&quot;&gt;inner&lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;"></iframe>
    <svg><script>alert(3)</script><use href="#icon"/><use href="https://evil.test/s.svg#a"/><a href="javascript:alert(4)"><image href="${PNG}"/></a></svg>
    <video poster="${PNG}" src="https://cdn.test/v.mp4"></video></body></html>`

  const clean = sanitizePageHtml(page)
  const { document } = parseHTML(clean)

  it('keeps the page: its doctype, classes, inline styles, data: fonts and images, links to the web and fragments', () => {
    expect(clean.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(document.documentElement.getAttribute('class')).toBe('js')
    expect(document.querySelector('style')!.textContent).toContain(`url(${FONT})`)
    expect(document.body.getAttribute('style')).toBe('background:#fff')
    expect(document.querySelector('img[alt="fig"]')!.getAttribute('src')).toBe(PNG)
    expect(Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'))).toEqual(['https://example.org/ref', '#sec', 'mailto:a@b.test'])
    expect(document.querySelector('svg use[href="#icon"]')).not.toBeNull()
    expect(document.querySelector('svg image')!.getAttribute('href')).toBe(PNG)
    expect(document.querySelector('video')!.getAttribute('poster')).toBe(PNG)
  })

  it('removes everything active or remote: scripts, noscript, handlers, base, links, http-equiv metas, objects, remote frames and URLs', () => {
    expect(clean).not.toMatch(/<script|<noscript|onload|onclick|<base|<link|refresh|<object|<embed|javascript:|evil\.test|cdn\.test|ads\.test|style-src 'none'|windows-1252/)
    // A remote image keeps its place without its source; a srcset with a remote candidate goes.
    expect(document.querySelector('img[alt="remote"]')!.hasAttribute('src')).toBe(false)
    expect(document.querySelector('img[alt="fig"]')!.hasAttribute('srcset')).toBe(false)
    expect(document.querySelector('iframe:not([srcdoc])')!.hasAttribute('src')).toBe(false)
  })

  it('cleans a frame inlined as srcdoc the same way, with the same policy', () => {
    const inner = document.querySelector('iframe[srcdoc]')!.getAttribute('srcdoc')!
    expect(inner).toContain('inner</p>')
    expect(inner).not.toMatch(/onclick|<script/)
    expect(inner).toContain(PAGE_CSP)
  })

  it('starts <head> with the charset and a policy that loads nothing but inline styles and data: resources', () => {
    const [charset, csp] = Array.from(document.head.children)
    expect(charset!.outerHTML).toBe('<meta charset="utf-8">')
    expect(csp!.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(csp!.getAttribute('content')).toBe(PAGE_CSP)
    expect(PAGE_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:")
  })

  it('adds a head to a fragment without one', () => {
    const out = sanitizePageHtml('<p>Only text</p>')
    expect(out).toContain(PAGE_CSP)
    expect(out).toContain('<p>Only text</p>')
  })
})

describe('the page print window', () => {
  it('runs without JavaScript, sandboxed, in its own in-memory session, as wide as the browser window was', () => {
    const options = pageWindowOptions(1366)
    expect(options).toMatchObject({ show: false, width: 1366 })
    expect(options.webPreferences).toMatchObject({ javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: PAGE_PARTITION })
    expect(options.webPreferences!.preload).toBeUndefined()
    expect(PAGE_PARTITION).not.toMatch(/^persist:/)
    expect(PAGE_PARTITION).not.toBe(READER_PARTITION)
  })
})

describe('printing as seen', () => {
  it('lays the page out at its window width (within limits), scaled onto A4 with backgrounds', () => {
    expect(layoutWidth(1280)).toBe(1280)
    expect(layoutWidth(100)).toBe(320)
    expect(layoutWidth(99999)).toBe(2560)
    expect(layoutWidth('wide')).toBe(1280)
    expect(asSeenPrintOptions(1280)).toEqual({
      pageSize: 'A4',
      printBackground: true,
      scale: 0.56,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      generateTaggedPDF: true,
      generateDocumentOutline: true
    })
    // A narrow page is printed at its own width, up to twice the size.
    expect(asSeenPrintOptions(360).scale).toBe(1.992)
  })

  it('emulates the screen media while printing and restores it, and still prints when the protocol is busy', async () => {
    const calls: string[] = []
    const contents = {
      debugger: {
        isAttached: () => false,
        attach: (version: string) => void calls.push(`attach ${version}`),
        sendCommand: async (method: string, params: { media: string }) => void calls.push(`${method} ${params.media || '(none)'}`),
        detach: () => void calls.push('detach')
      }
    }
    expect(await withScreenMedia(contents as never, async () => (calls.push('print'), 'pdf'))).toBe('pdf')
    expect(calls).toEqual(['attach 1.3', 'Emulation.setEmulatedMedia screen', 'print', 'Emulation.setEmulatedMedia (none)', 'detach'])

    calls.length = 0
    contents.debugger.attach = () => {
      throw new Error('Another debugger is already attached')
    }
    await expect(withScreenMedia(contents as never, async () => (calls.push('print'), 'pdf'))).resolves.toBe('pdf')
    expect(calls).toEqual(['print'])

    // Already attached (by this app): used, not detached.
    calls.length = 0
    contents.debugger.isAttached = () => true
    await withScreenMedia(contents as never, async () => calls.push('print'))
    expect(calls).toEqual(['Emulation.setEmulatedMedia screen', 'print', 'Emulation.setEmulatedMedia (none)'])
  })
})
