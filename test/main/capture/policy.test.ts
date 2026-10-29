import { describe, expect, it } from 'vitest'
import {
  CAPTURE_PARTITION,
  CAPTURE_WORLD_ID,
  fromToolbar,
  guardPage,
  hardenSession,
  isWebUrl,
  MAX_CAPTURE_HTML,
  pageWebPreferences,
  readCapture,
  READER_PARTITION,
  readerWindowOptions,
  routeCapture,
  toolbarWindowOptions
} from '../../../src/main/capture/policy'
import { CONSENT_CSS, HIDE_ATTRIBUTE, MARK_FIXED_OVERLAYS, OVERLAY_NAME } from '../../../src/main/capture/consent'

type Listener = (...args: any[]) => void

/** Records what the policy registers, so a test can call it like Electron would. */
function fakeEmitter() {
  const listeners = new Map<string, Listener[]>()
  return {
    listeners,
    on(name: string, listener: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return this
    },
    emit(name: string, ...args: unknown[]) {
      for (const l of listeners.get(name) ?? []) l(...args)
    }
  }
}

const event = (url?: string) => {
  const e = { url, prevented: false, preventDefault: () => void (e.prevented = true) }
  return e
}

describe('app browser window options', () => {
  it('runs the page sandboxed and isolated, without preload or Node, in its own persistent session', () => {
    const prefs = pageWebPreferences()
    expect(prefs).toMatchObject({
      partition: CAPTURE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
    expect(CAPTURE_PARTITION).toMatch(/^persist:/)
    expect(prefs).not.toHaveProperty('preload')
    // Electron's own user agent: nothing pretends to be another browser.
    expect(prefs).not.toHaveProperty('userAgent')
  })

  it('gives only the toolbar a preload, sandboxed and isolated too', () => {
    const options = toolbarWindowOptions('/app/out/preload/capture.js')
    expect(options.webPreferences).toMatchObject({ preload: '/app/out/preload/capture.js', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(options.webPreferences).not.toHaveProperty('partition')
  })

  it('opens only http and https pages', () => {
    expect(isWebUrl('https://towardsdatascience.com/x')).toBe(true)
    expect(isWebUrl('http://acme.test')).toBe(true)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'research://x', 'data:text/html,hi', 'not a url', '']) expect(isWebUrl(bad)).toBe(false)
  })
})

describe('hardenSession', () => {
  function fakeSession() {
    const emitter = fakeEmitter()
    const handlers: Record<string, Listener> = {}
    return {
      ...emitter,
      handlers,
      setPermissionRequestHandler: (h: Listener) => void (handlers.request = h),
      setPermissionCheckHandler: (h: Listener) => void (handlers.check = h),
      setDevicePermissionHandler: (h: Listener) => void (handlers.device = h)
    }
  }

  it('denies every permission and every download', () => {
    const session = fakeSession()
    const blocked: string[] = []
    hardenSession(session as never, (url) => blocked.push(url))
    for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'midi', 'openExternal']) {
      let granted: boolean | undefined
      session.handlers.request(null, permission, (ok: boolean) => (granted = ok))
      expect(granted).toBe(false)
    }
    expect(session.handlers.check(null, 'media')).toBe(false)
    expect(session.handlers.device({})).toBe(false)
    const download = event()
    session.emit('will-download', download, { getURL: () => 'https://acme.test/file.zip' })
    expect(download.prevented).toBe(true)
    expect(blocked).toEqual(['https://acme.test/file.zip'])
  })

  it('hardens a session once', () => {
    const session = fakeSession()
    hardenSession(session as never)
    hardenSession(session as never)
    expect(session.listeners.get('will-download')).toHaveLength(1)
  })
})

describe('guardPage', () => {
  function fakeContents() {
    const emitter = fakeEmitter()
    const loaded: string[] = []
    let openHandler: ((d: { url: string }) => { action: string }) | null = null
    return {
      ...emitter,
      loaded,
      open: (url: string) => openHandler!({ url }),
      setWindowOpenHandler: (h: typeof openHandler) => void (openHandler = h),
      loadURL: async (url: string) => void loaded.push(url)
    }
  }

  it('loads new-window links in the same view, and never opens a window', () => {
    const contents = fakeContents()
    guardPage(contents as never)
    expect(contents.open('https://acme.test/next')).toEqual({ action: 'deny' })
    expect(contents.open('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(contents.loaded).toEqual(['https://acme.test/next'])
  })

  it('stops navigation and redirects away from the web, and <webview> tags', () => {
    const contents = fakeContents()
    guardPage(contents as never)
    for (const name of ['will-navigate', 'will-redirect']) {
      const ok = event('https://acme.test/a')
      const bad = event('file:///home/me/.ssh/id_rsa')
      contents.emit(name, ok)
      contents.emit(name, bad)
      expect([ok.prevented, bad.prevented]).toEqual([false, true])
    }
    // Older Electron passes the URL as a second argument.
    const legacy = event()
    contents.emit('will-navigate', legacy, 'javascript:alert(1)')
    expect(legacy.prevented).toBe(true)
    const webview = event()
    contents.emit('will-attach-webview', webview)
    expect(webview.prevented).toBe(true)
  })
})

describe('fromToolbar', () => {
  it('accepts only the open window toolbar', () => {
    const toolbar = { isDestroyed: () => false }
    expect(fromToolbar({ sender: toolbar } as never, toolbar as never)).toBe(true)
    expect(fromToolbar({ sender: { isDestroyed: () => false } } as never, toolbar as never)).toBe(false)
    expect(fromToolbar({ sender: toolbar } as never, null)).toBe(false)
    expect(fromToolbar({ sender: toolbar } as never, { isDestroyed: () => true } as never)).toBe(false)
  })
})

describe('readCapture', () => {
  function page(url: string, html: unknown, pdf: Buffer | Error) {
    const worlds: number[] = []
    const calls: string[] = []
    const css: string[] = []
    return {
      worlds,
      calls,
      css,
      getURL: () => url,
      executeJavaScriptInIsolatedWorld: async (world: number, scripts: { code: string }[]) => {
        worlds.push(world)
        const code = scripts[0]!.code
        if (code.includes(HIDE_ATTRIBUTE)) {
          calls.push(code === MARK_FIXED_OVERLAYS ? 'mark' : 'unmark')
          return 1
        }
        calls.push('html')
        return html
      },
      insertCSS: async (text: string) => (calls.push('insertCSS'), css.push(text), 'css-key'),
      removeInsertedCSS: async (key: string) => void calls.push(`removeCSS:${key}`),
      printToPDF: async () => {
        calls.push('print')
        if (pdf instanceof Error) throw pdf
        return pdf
      }
    }
  }
  const pageMode = { mode: 'page' as const, printReader: async () => null }

  it('reads the URL, the HTML from an isolated world and the printed PDF', async () => {
    const contents = page('https://acme.test/a', '<html>hi</html>', Buffer.from('%PDF-1.7'))
    const capture = await readCapture(contents as never, pageMode)
    expect(capture).toEqual({ url: 'https://acme.test/a', html: '<html>hi</html>', pdf: new Uint8Array(Buffer.from('%PDF-1.7')) })
    expect(new Set(contents.worlds)).toEqual(new Set([CAPTURE_WORLD_ID]))
  })

  it('treats what the page returns as data: a non-string is no HTML, a huge one is cut, a failed print is no PDF', async () => {
    expect(await readCapture(page('https://acme.test/a', { evil: true }, new Error('print')) as never, pageMode)).toEqual({ url: 'https://acme.test/a', html: '', pdf: null })
    const huge = await readCapture(page('https://acme.test/a', 'x'.repeat(MAX_CAPTURE_HTML + 10), Buffer.from('%PDF')) as never, pageMode)
    expect(huge.html).toHaveLength(MAX_CAPTURE_HTML)
  })

  it('refuses a page that is not on the web', async () => {
    await expect(readCapture(page('file:///etc/passwd', '', Buffer.from('')) as never, pageMode)).rejects.toThrow()
  })

  it('prints the page as it looks with consent overlays hidden by CSS, and takes the style and marks away afterwards', async () => {
    const contents = page('https://acme.test/a', '<html>hi</html>', Buffer.from('%PDF-1.7'))
    await readCapture(contents as never, pageMode)
    expect(contents.calls).toEqual(['html', 'mark', 'insertCSS', 'print', 'removeCSS:css-key', 'unmark'])
    const [css] = contents.css
    for (const selector of ['#onetrust-consent-sdk', '#CybotCookiebotDialog', '#didomi-host', '#qc-cmp2-container', '#truste-consent-track', '#usercentrics-root', '[id^="sp_message_container"]', '.osano-cm-window', '#termly-code-snippet-support', '#cmplz-cookiebanner-container', '.cky-consent-container']) {
      expect(css).toContain(selector)
    }
    expect(css).toContain(`[${HIDE_ATTRIBUTE}] { display: none !important;`)
    expect(css).toMatch(/html, body \{ overflow: visible !important;/)
    expect(CONSENT_CSS).toBe(css)
    // Only hiding: nothing in what runs in the page clicks a button.
    expect(MARK_FIXED_OVERLAYS).not.toMatch(/click|submit|accept/i)
    expect(MARK_FIXED_OVERLAYS).toMatch(/position !== 'fixed' && position !== 'sticky'/)
    // The empty full-window backdrop of a dialog goes too.
    expect(MARK_FIXED_OVERLAYS).toMatch(/0\.8 \* area && \(el\.textContent \|\| ''\)\.trim\(\)\.length === 0/)
  })

  it('marks only fixed or sticky elements named like a consent banner', () => {
    for (const name of ['cookie-banner', 'ConsentModal', 'gdpr-popup', 'privacy-banner', 'privacy_banner']) expect(OVERLAY_NAME.test(name)).toBe(true)
    for (const name of ['article-body', 'privacy-policy-link', 'site-header']) expect(OVERLAY_NAME.test(name)).toBe(false)
  })

  it('prints the reader view in reader mode, without touching the page', async () => {
    const contents = page('https://acme.test/a', '<html>article</html>', Buffer.from('%PDF-page'))
    const seen: string[][] = []
    const capture = await readCapture(contents as never, { mode: 'reader', printReader: async (html, url) => (seen.push([html, url]), new TextEncoder().encode('%PDF-reader')) })
    expect(seen).toEqual([['<html>article</html>', 'https://acme.test/a']])
    expect(new TextDecoder().decode(capture.pdf!)).toBe('%PDF-reader')
    expect(contents.calls).toEqual(['html'])
  })

  it('falls back to the page as it looks (overlays hidden) when there is no article or the reader print fails', async () => {
    for (const printReader of [async () => null, async () => Promise.reject(new Error('timeout'))]) {
      const contents = page('https://acme.test/a', '<html>nav only</html>', Buffer.from('%PDF-page'))
      const capture = await readCapture(contents as never, { mode: 'reader', printReader })
      expect(new TextDecoder().decode(capture.pdf!)).toBe('%PDF-page')
      expect(contents.calls).toContain('insertCSS')
    }
  })
})

describe('reader print window', () => {
  it('runs without JavaScript, sandboxed and isolated, hidden, in its own in-memory session', () => {
    const options = readerWindowOptions()
    expect(options.show).toBe(false)
    expect(options.webPreferences).toMatchObject({ partition: READER_PARTITION, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(options.webPreferences).not.toHaveProperty('preload')
    expect(READER_PARTITION).not.toMatch(/^persist:/)
  })
})

describe('routeCapture', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7')
  const capture = { url: 'https://acme.test/post/', html: '<html></html>', pdf }

  it('holds a page already in the library for «Actualizar su PDF» instead of ingesting a duplicate', async () => {
    const ingested: string[] = []
    const routed = await routeCapture(capture, {
      findExisting: async (url) => (url === capture.url ? 'roe2024post' : null),
      ingest: async (c) => (ingested.push(c.url), { paperId: 'new' })
    })
    expect(routed).toEqual({ existing: 'roe2024post', pdf })
    expect(ingested).toEqual([])
  })

  it('ingests a new page, and a page without a PDF even when known (nothing to replace)', async () => {
    const ingest = async () => ({ paperId: 'roe2024post' })
    expect(await routeCapture(capture, { findExisting: async () => null, ingest })).toEqual({ added: 'roe2024post' })
    const looked: string[] = []
    expect(await routeCapture({ ...capture, pdf: null }, { findExisting: async (u) => (looked.push(u), 'roe2024post'), ingest })).toEqual({ added: 'roe2024post' })
    expect(looked).toEqual([])
  })
})
