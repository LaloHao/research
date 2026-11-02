import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionApi } from '../../extension/src/browser'
import type { ConnectorPage } from '../../extension/src/content'
import type { Detection } from '../../extension/src/detect'
import { capture, inspect, pdfPermission, updatePdf, type Inspected } from '../../extension/src/flow'

const scope = globalThis as unknown as { chrome?: ExtensionApi; __researchConnector?: ConnectorPage }

const article: Detection = { url: 'https://blog.example.org/post', title: 'Post', kind: 'article', doi: null, arxiv: null, pdfUrl: null, isPdf: false, authors: [], date: null, meta: {} }

/** A tab whose page answers like the content script; `scriptable: false` is a page the browser does not let it into. */
function fakeBrowser(page: Partial<ConnectorPage>, scriptable = true): { calls: string[] } {
  const calls: string[] = []
  scope.__researchConnector = page as ConnectorPage
  scope.chrome = {
    scripting: {
      executeScript: async (details: { files?: string[]; func?: (...a: never[]) => unknown; args?: unknown[] }) => {
        if (!scriptable) throw new Error('Missing host permission for the tab')
        if (details.files) return [{}]
        calls.push(String((details.args as [string])[0]))
        return [{ result: await (details.func as (...a: unknown[]) => unknown)(...(details.args ?? [])) }]
      }
    }
  } as unknown as ExtensionApi
  return { calls }
}

afterEach(() => {
  delete scope.chrome
  delete scope.__researchConnector
})

describe('inspect', () => {
  it('asks the page what it is', async () => {
    fakeBrowser({ detectPage: () => article })
    expect(await inspect({ id: 3, url: article.url })).toEqual({ tabId: 3, detection: article, scriptable: true })
  })

  it('judges a PDF it cannot script by its address, and refuses other pages it cannot read', async () => {
    fakeBrowser({}, false)
    const pdf = await inspect({ id: 1, url: 'https://files.example.org/paper.pdf', title: 'paper.pdf' })
    expect(pdf).toMatchObject({ scriptable: false, detection: { kind: 'pdf', isPdf: true, pdfUrl: 'https://files.example.org/paper.pdf', title: 'paper.pdf' } })
    await expect(inspect({ id: 1, url: 'https://blog.example.org/post' })).rejects.toMatchObject({ code: 'restricted' })
    await expect(inspect({ id: 1, url: 'about:preferences' })).rejects.toMatchObject({ code: 'restricted' })
  })
})

describe('pdfPermission', () => {
  const at = (detection: Partial<Detection>, scriptable = true): Inspected => ({ tabId: 1, scriptable, detection: { ...article, ...detection } })
  it('is needed only for a PDF the page cannot fetch itself', () => {
    expect(pdfPermission(at({}))).toBeNull()
    expect(pdfPermission(at({ pdfUrl: 'https://blog.example.org/post.pdf' }))).toBeNull()
    expect(pdfPermission(at({ pdfUrl: 'https://cdn.example.net/post.pdf' }))).toBe('https://cdn.example.net/*')
    expect(pdfPermission(at({ isPdf: true, pdfUrl: 'https://files.example.org/x.pdf', url: 'https://files.example.org/x.pdf' }, false))).toBe('https://files.example.org/*')
  })
})

describe('capture', () => {
  const conn = { apiUrl: 'http://127.0.0.1:1', token: 't' }

  it('says a PDF tab needs the site permission when nothing could fetch it', async () => {
    fakeBrowser({}, false)
    const inspected = await inspect({ id: 1, url: 'https://files.example.org/paper.pdf' })
    // The extension's own fetch is refused (no permission; tests have no network) and the page can't be scripted.
    await expect(capture(conn, inspected)).rejects.toMatchObject({ code: 'pdf_permission' })
  })

  it('gathers a linked PDF through the page, and no images when it has one', async () => {
    const asked: { images: boolean }[] = []
    const { calls } = fakeBrowser({
      detectPage: () => ({ ...article, kind: 'doi', doi: '10.1/x', pdfUrl: 'https://blog.example.org/x.pdf' }),
      fetchPdf: async () => 'JVBERi0=',
      collectPage: async (options) => (asked.push(options), { html: '<html></html>', images: [] })
    })
    const inspected = await inspect({ id: 1, url: article.url })
    // Port 1 refuses: the capture gets as far as sending.
    await expect(capture(conn, inspected)).rejects.toMatchObject({ code: 'unreachable' })
    expect(calls).toEqual(['detectPage', 'fetchPdf', 'collectPage'])
    expect(asked).toEqual([{ images: false }])
  })
})

describe('«Página tal como se ve»', () => {
  const sent: { endpoint: string; body: Record<string, unknown> }[] = []
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    sent.length = 0
  })
  /** The app: records what is sent and answers that the page is in the library already (so nothing is awaited). */
  function fakeApp(): void {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const endpoint = String(url).split('/ext/v1/')[1]!
      sent.push({ endpoint, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      const answer = endpoint === 'capture_update_pdf' ? { task: 't1' } : endpoint === 'capture_status' ? { state: 'done', key: 'k2026', title: 'T', outcome: 'pdf_updated', error: null, job: null } : { task: null, existing: { key: 'k2026', title: 'T' } }
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }
  const conn = { apiUrl: 'http://127.0.0.1:47823', token: 't' }
  const SERIALIZED = { html: '<!DOCTYPE html><html><body>as seen</body></html>', viewportWidth: 1366, missing: 0 }

  it('serializes the page in the tab and sends it with its width; no images are collected', async () => {
    const asked: { images: boolean }[] = []
    const steps: string[] = []
    const { calls } = fakeBrowser({
      detectPage: () => article,
      serializePage: async () => SERIALIZED,
      collectPage: async (options) => (asked.push(options), { html: '<html>text</html>', images: [] })
    })
    fakeApp()
    const inspected = await inspect({ id: 1, url: article.url })
    expect(await capture(conn, inspected, (s) => steps.push(s), undefined, 'page')).toEqual({ existing: { key: 'k2026', title: 'T' } })
    expect(calls).toEqual(['detectPage', 'serializePage', 'collectPage'])
    expect(asked).toEqual([{ images: false }])
    expect(steps).toEqual(['serializing', 'reading', 'sending'])
    expect(sent[0]).toMatchObject({ endpoint: 'capture_page', body: { html: '<html>text</html>', page_html: SERIALIZED.html, viewport_width: 1366 } })
  })

  it('falls back to the reader view (with images) when the page is too large to serialize', async () => {
    const asked: { images: boolean }[] = []
    fakeBrowser({
      detectPage: () => article,
      serializePage: async () => ({ error: 'too_large' as const }),
      collectPage: async (options) => (asked.push(options), { html: '<html>text</html>', images: [] })
    })
    fakeApp()
    await capture(conn, await inspect({ id: 1, url: article.url }), undefined, undefined, 'page')
    expect(asked).toEqual([{ images: true }])
    expect(sent[0]!.body).not.toHaveProperty('page_html')
  })

  it('never serializes in reader mode, and serializes to update the PDF of a known paper even with a DOI', async () => {
    const { calls } = fakeBrowser({ detectPage: () => article, serializePage: async () => SERIALIZED, collectPage: async () => ({ html: '<html></html>', images: [] }) })
    fakeApp()
    await capture(conn, await inspect({ id: 1, url: article.url }))
    expect(calls).not.toContain('serializePage')

    const doiPage = fakeBrowser({ detectPage: () => ({ ...article, kind: 'doi', doi: '10.1/x' }), serializePage: async () => SERIALIZED, collectPage: async () => ({ html: '<html></html>', images: [] }) })
    sent.length = 0
    expect(await updatePdf(conn, await inspect({ id: 1, url: article.url }), 'k2026', undefined, 'page')).toMatchObject({ state: 'done', key: 'k2026' })
    expect(doiPage.calls).toEqual(['detectPage', 'serializePage', 'collectPage'])
    expect(sent[0]).toMatchObject({ endpoint: 'capture_update_pdf', body: { key: 'k2026', page_html: SERIALIZED.html, viewport_width: 1366 } })
  })
})
