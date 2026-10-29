import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_IPC, type CapturePdfMode, type CaptureState } from '../../../src/shared/capture'
import { BrowserWindow, handlers, WebContentsView, type FakeContents } from '../../helpers/electronFake'

vi.mock('electron', () => import('../../helpers/electronFake'))

const { CaptureWindow } = await import('../../../src/main/capture/CaptureWindow')

const ARTICLE = readFileSync(new URL('../../fixtures/web/postmortem.html', import.meta.url), 'utf8')
const BLOG = 'https://eng.acme.test/posts/database-outage'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

function setup(options: { mode?: CapturePdfMode; existing?: Record<string, string> } = {}) {
  let mode: CapturePdfMode = options.mode ?? 'page'
  const calls = { ingest: [] as string[], replaced: [] as { paperId: string; pdf: string }[], added: [] as string[], lookups: [] as string[] }
  const window = new CaptureWindow({
    preload: '/app/preload/capture.js',
    loadToolbar: async () => undefined,
    ingest: async (capture) => {
      calls.ingest.push(capture.url)
      return { paperId: 'new2024page' }
    },
    onAdded: (id) => void calls.added.push(id),
    findExisting: async (url) => {
      calls.lookups.push(url)
      return options.existing?.[url] ?? null
    },
    replacePdf: async (paperId, pdf) => void calls.replaced.push({ paperId, pdf: Buffer.from(pdf).toString('utf8') }),
    pdfMode: () => mode,
    setPdfMode: async (next) => void (mode = next)
  })
  const open = (url: string, target: string | null = null) => {
    window.open(url, target)
    const win = BrowserWindow.created.at(-1)!
    const page = win.children[0]!.webContents
    return { win, page, toolbar: win.webContents }
  }
  return { window, calls, open }
}

/** Calls a toolbar channel as `sender` would. */
const invoke = (channel: string, sender: unknown, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args)
const stateOf = (toolbar: FakeContents): CaptureState => toolbar.sent.at(-1) as CaptureState

beforeEach(() => {
  handlers.clear()
  BrowserWindow.created.length = 0
  WebContentsView.created.length = 0
})

describe('CaptureWindow: the toolbar channels', () => {
  it('answers the new channels only from its toolbar, and only without arguments', async () => {
    const { open } = setup()
    const { toolbar, page } = open(BLOG)
    for (const channel of [CAPTURE_IPC.update, CAPTURE_IPC.preview, CAPTURE_IPC.showPage]) {
      await expect(invoke(channel, page)).rejects.toThrow('Refused')
      await expect(invoke(channel, {})).rejects.toThrow('Refused')
      await expect(invoke(channel, toolbar, 'he2017drain')).rejects.toThrow('Refused')
      await expect(invoke(channel, toolbar)).resolves.toBeUndefined()
    }
    await expect(invoke(CAPTURE_IPC.pdfMode, toolbar, 'pdf')).rejects.toThrow('Refused')
    await expect(invoke(CAPTURE_IPC.pdfMode, toolbar, 'reader', 'x')).rejects.toThrow('Refused')
  })

  it('does nothing on «Actualizar PDF» for a page that is no paper of the library', async () => {
    const { open, calls } = setup()
    const { toolbar, page } = open(BLOG)
    page.navigate(BLOG)
    await tick()
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(calls.replaced).toEqual([])
    expect(stateOf(toolbar)).toMatchObject({ phase: 'browsing', known: null, target: null })
  })
})

describe('CaptureWindow: a page already in the library', () => {
  it('says so while browsing, and «Actualizar PDF» replaces that paper’s PDF without asking', async () => {
    const { open, calls } = setup({ existing: { [BLOG]: 'roe2024database' } })
    const { toolbar, page, win } = open(BLOG)
    page.navigate(BLOG, 'Postmortem')
    await tick()
    expect(calls.lookups).toEqual([BLOG])
    expect(stateOf(toolbar)).toMatchObject({ known: 'roe2024database', target: null, phase: 'browsing' })
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(calls.replaced).toEqual([{ paperId: 'roe2024database', pdf: `%PDF-1.7 ${BLOG}` }])
    expect(calls.ingest).toEqual([])
    expect(calls.added).toEqual(['roe2024database'])
    expect(win.destroyed).toBe(true)
  })

  it('forgets the match when the page moves on', async () => {
    const { open } = setup({ existing: { [BLOG]: 'roe2024database' } })
    const { toolbar, page } = open(BLOG)
    page.navigate(BLOG)
    await tick()
    page.navigate('https://eng.acme.test/posts/other')
    expect(stateOf(toolbar).known).toBeNull()
    await tick()
    expect(stateOf(toolbar).known).toBeNull()
  })
})

describe('CaptureWindow: bound to a paper («Volver a capturar desde la web»)', () => {
  it('updates the bound paper’s PDF, never adds the page and never looks it up', async () => {
    const { open, calls } = setup()
    const { toolbar, page } = open(BLOG, 'roe2024database')
    page.navigate(BLOG)
    await tick()
    expect(stateOf(toolbar)).toMatchObject({ target: 'roe2024database', known: null })
    await invoke(CAPTURE_IPC.add, toolbar)
    expect(calls.ingest).toEqual([])
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(calls.lookups).toEqual([])
    expect(calls.replaced.map((r) => r.paperId)).toEqual(['roe2024database'])
    expect(calls.added).toEqual(['roe2024database'])
  })

  it('takes the site a DOI lands on as the paper’s', async () => {
    const { open, calls } = setup()
    const { toolbar, page } = open('https://doi.org/10.1109/icws.2017.13', 'he2017drain')
    page.navigate('https://ieeexplore.ieee.test/document/8029742')
    page.navigate('https://ieeexplore.ieee.test/document/8029742/figures')
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(calls.replaced.map((r) => r.paperId)).toEqual(['he2017drain'])
  })

  it('warns before updating from another site, and updates only on a yes', async () => {
    const { open, calls } = setup()
    const { toolbar, page, win } = open(BLOG, 'roe2024database')
    page.navigate(BLOG)
    page.navigate('https://mirror.example.test/copy-of-the-postmortem')
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(stateOf(toolbar)).toMatchObject({ phase: 'confirm', question: 'other_site', existing: 'roe2024database' })
    expect(calls.replaced).toEqual([])
    // «No»: back to browsing.
    await invoke(CAPTURE_IPC.keep, toolbar)
    expect(stateOf(toolbar)).toMatchObject({ phase: 'browsing', question: null })
    // Asked again; browsing elsewhere drops the question.
    await invoke(CAPTURE_IPC.update, toolbar)
    page.navigate('https://mirror.example.test/another')
    expect(stateOf(toolbar)).toMatchObject({ phase: 'browsing', question: null })
    await invoke(CAPTURE_IPC.replace, toolbar)
    expect(calls.replaced).toEqual([])
    // Asked again, and the user says yes.
    await invoke(CAPTURE_IPC.update, toolbar)
    await invoke(CAPTURE_IPC.replace, toolbar)
    expect(calls.replaced).toEqual([{ paperId: 'roe2024database', pdf: '%PDF-1.7 https://mirror.example.test/another' }])
    expect(win.destroyed).toBe(true)
  })

  it('does not warn on a subdomain of the paper’s site', async () => {
    const { open, calls } = setup()
    const { toolbar, page } = open('https://www.acme.test/post', 'roe2024database')
    page.navigate('https://www.acme.test/post')
    page.navigate('https://eng.acme.test/posts/database-outage')
    await invoke(CAPTURE_IPC.update, toolbar)
    expect(calls.replaced.map((r) => r.paperId)).toEqual(['roe2024database'])
  })

  it('opening a plain URL afterwards unbinds the window', async () => {
    const { window, open, calls } = setup({ existing: {} })
    const { toolbar, page } = open(BLOG, 'roe2024database')
    page.navigate(BLOG)
    window.open('https://eng.acme.test/posts/other')
    expect(stateOf(toolbar)).toMatchObject({ target: null })
    page.navigate('https://eng.acme.test/posts/other')
    await invoke(CAPTURE_IPC.add, toolbar)
    expect(calls.ingest).toEqual(['https://eng.acme.test/posts/other'])
  })
})

describe('CaptureWindow: «Vista de lectura»', () => {
  const views = () => WebContentsView.created

  it('shows the reader view of the article in a JavaScript-less view in place of the page, and back', async () => {
    const { open } = setup({ mode: 'reader' })
    const { toolbar, page } = open(BLOG)
    page.html = ARTICLE
    page.navigate(BLOG)
    await invoke(CAPTURE_IPC.preview, toolbar)
    expect(stateOf(toolbar)).toMatchObject({ preview: 'on', notice: null })
    const [pageView, reader] = views()
    expect(reader!.options.webPreferences).toMatchObject({ javascript: false, sandbox: true, partition: 'capture-preview' })
    expect(reader!.options.webPreferences).not.toHaveProperty('preload')
    expect(reader!.webContents.loads).toHaveLength(1)
    expect(reader!.webContents.loads[0]).toMatch(/^file:\/\/.*reader\.html$/)
    expect([pageView!.visible, reader!.visible]).toEqual([false, true])
    // The page view is kept alive below.
    expect(page.destroyed).toBe(false)

    await invoke(CAPTURE_IPC.showPage, toolbar)
    expect(stateOf(toolbar).preview).toBe('off')
    expect([pageView!.visible, reader!.visible]).toEqual([true, false])
  })

  it('builds it again when the page navigates or reloads', async () => {
    const { open } = setup({ mode: 'reader' })
    const { toolbar, page } = open(BLOG)
    page.html = ARTICLE
    page.navigate(BLOG)
    await invoke(CAPTURE_IPC.preview, toolbar)
    const reader = views()[1]!
    page.navigate(`${BLOG}?page=2`)
    await vi.waitFor(() => expect(reader.webContents.loads).toHaveLength(2))
    await vi.waitFor(() => expect(stateOf(toolbar).preview).toBe('on'))
    // A page without an article: back to the page, with a notice.
    page.html = '<html><head><title>Login</title></head><body><div id="app"></div></body></html>'
    page.navigate('https://eng.acme.test/login')
    await vi.waitFor(() => expect(stateOf(toolbar)).toMatchObject({ preview: 'off', notice: 'no_article' }))
    expect([views()[0]!.visible, reader.visible]).toEqual([true, false])
  })

  it('keeps the page, with a notice, when there is no article to read', async () => {
    const { open } = setup({ mode: 'reader' })
    const { toolbar, page } = open(BLOG)
    page.html = '<html><body><div id="app"></div></body></html>'
    page.navigate(BLOG)
    await invoke(CAPTURE_IPC.preview, toolbar)
    expect(stateOf(toolbar)).toMatchObject({ preview: 'off', notice: 'no_article' })
    expect(views()).toHaveLength(1)
    expect(views()[0]!.visible).toBe(true)
    // The notice goes when the page moves on.
    page.navigate('https://eng.acme.test/posts/other')
    expect(stateOf(toolbar).notice).toBeNull()
  })

  it('has nothing to show when the PDF is the page as it looks, and leaves the reader view when the mode changes', async () => {
    const { open } = setup({ mode: 'page' })
    const { toolbar, page } = open(BLOG)
    page.html = ARTICLE
    page.navigate(BLOG)
    await invoke(CAPTURE_IPC.preview, toolbar)
    expect(stateOf(toolbar).preview).toBe('off')
    expect(views()).toHaveLength(1)
    await invoke(CAPTURE_IPC.pdfMode, toolbar, 'reader')
    await invoke(CAPTURE_IPC.preview, toolbar)
    expect(stateOf(toolbar).preview).toBe('on')
    await invoke(CAPTURE_IPC.pdfMode, toolbar, 'page')
    expect(stateOf(toolbar)).toMatchObject({ preview: 'off', pdfMode: 'page' })
    expect(views()[0]!.visible).toBe(true)
  })

  it('closes the reader view with the window', async () => {
    const { open } = setup({ mode: 'reader' })
    const { toolbar, page, win } = open(BLOG)
    page.html = ARTICLE
    page.navigate(BLOG)
    await invoke(CAPTURE_IPC.preview, toolbar)
    win.close()
    expect(views().map((v) => v.webContents.destroyed)).toEqual([true, true])
  })
})
