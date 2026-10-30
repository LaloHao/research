import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionApi } from '../../extension/src/browser'
import type { ConnectorPage } from '../../extension/src/content'
import type { Detection } from '../../extension/src/detect'
import { capture, inspect, pdfPermission, type Inspected } from '../../extension/src/flow'

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
