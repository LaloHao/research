/**
 * A capture of the active tab, shared by the popup and the keyboard shortcut: read the page (the content script,
 * injected now), fetch its PDF with the user's session, send it to the app, and wait for the paper's key.
 */
import { call, ConnectorError, DEFAULT_API_URL, waitForTask, type Connection, type Existing, type TaskStatus } from './api'
import { ext, type Tab } from './browser'
import type { ConnectorPage } from './content'
import { isCapturable, isPdfBytes, isPdfTab, LIMITS, toBase64, type Detection } from './detect'
import type { CaptureMode } from './mode'
import { lookupBody, needs, pageBody, planCapture, type Collected } from './payload'

export const SETTINGS_KEYS = ['apiUrl', 'token'] as const

export async function connection(): Promise<Connection> {
  const saved = await ext().storage.local.get([...SETTINGS_KEYS])
  return { apiUrl: typeof saved.apiUrl === 'string' ? saved.apiUrl : DEFAULT_API_URL, token: typeof saved.token === 'string' ? saved.token : null }
}

export interface Inspected {
  tabId: number
  detection: Detection
  /** The content script could run there (not a browser page, nor Firefox's PDF viewer). */
  scriptable: boolean
}

async function inPage<K extends keyof ConnectorPage>(tabId: number, op: K, ...args: Parameters<ConnectorPage[K]>): Promise<Awaited<ReturnType<ConnectorPage[K]>>> {
  const api = ext()
  await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  const [first] = await api.scripting.executeScript({
    target: { tabId },
    func: ((name: string, rest: unknown[]) => {
      const page = (globalThis as unknown as { __researchConnector: Record<string, (...a: unknown[]) => unknown> }).__researchConnector
      return page[name]!(...rest)
    }) as (...args: never[]) => unknown,
    args: [op, args]
  })
  return first?.result as Awaited<ReturnType<ConnectorPage[K]>>
}

/** What the page is. A tab the content script can't run in (a PDF in Firefox's viewer) is judged by its address. */
export async function inspect(tab: Tab): Promise<Inspected> {
  if (tab.id === undefined || !isCapturable(tab.url)) throw new ConnectorError('restricted')
  const url = tab.url!
  try {
    const detection = await inPage(tab.id, 'detectPage')
    if (detection) return { tabId: tab.id, detection, scriptable: true }
  } catch {
    // Not scriptable: below.
  }
  if (!isPdfTab(url, null)) throw new ConnectorError('restricted')
  const title = (tab.title ?? '').slice(0, LIMITS.title)
  return {
    tabId: tab.id,
    scriptable: false,
    detection: { url, title, kind: 'pdf', doi: null, arxiv: null, pdfUrl: url, isPdf: true, authors: [], date: null, meta: {} }
  }
}

/** The origin pattern the optional host permission is asked for, to fetch the PDF from the extension. */
export function pdfPermission(inspected: Inspected): string | null {
  const { pdfUrl, url } = inspected.detection
  if (!pdfUrl) return null
  const origin = new URL(pdfUrl).origin
  // The page fetches its own site's PDF itself; only another site's, or a tab without a page, needs the permission.
  if (inspected.scriptable && origin === new URL(url).origin) return null
  return `${origin}/*`
}

/** The PDF, by the extension (works once it may reach that site) or else by the page itself (same site, its cookies). */
async function fetchPdf(inspected: Inspected): Promise<string | null> {
  const url = inspected.detection.pdfUrl
  if (!url) return null
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
    if (res.ok && Number(res.headers.get('content-length') ?? 0) <= LIMITS.pdfBytes) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength <= LIMITS.pdfBytes && isPdfBytes(bytes)) return toBase64(bytes)
    }
  } catch {
    // CORS without the permission: the page tries.
  }
  if (!inspected.scriptable) return null
  return inPage(inspected.tabId, 'fetchPdf', url).catch(() => null)
}

export async function lookup(conn: Connection, inspected: Inspected): Promise<Existing | null> {
  return (await call<{ existing: Existing | null }>(conn, 'capture_lookup', lookupBody(inspected.detection))).existing
}

export type Step = 'reading' | 'pdf' | 'serializing' | 'sending' | 'processing'

export type CaptureResult = { status: TaskStatus } | { existing: Existing }

/**
 * The page serialized as it looks; null when it can't be (too large for the app, or the page refused): the app then
 * prints the reader view, so the images it needs are collected instead.
 */
async function serialized(inspected: Inspected): Promise<Collected['page']> {
  const result = await inPage(inspected.tabId, 'serializePage').catch(() => null)
  return result && 'html' in result ? { html: result.html, viewportWidth: result.viewportWidth } : null
}

async function gather(inspected: Inspected, onStep: (step: Step) => void, mode: CaptureMode): Promise<Collected> {
  const want = needs(inspected.detection, mode)
  let pdf: string | null = null
  if (want.pdf) {
    onStep('pdf')
    pdf = await fetchPdf(inspected)
  }
  let page: Collected['page'] = null
  if (want.page && !pdf && inspected.scriptable) {
    onStep('serializing')
    page = await serialized(inspected)
  }
  onStep('reading')
  const images = (want.images || (want.page && !page)) && !pdf
  const read = want.html && inspected.scriptable ? await inPage(inspected.tabId, 'collectPage', { images }) : { html: '', images: [] }
  return { html: read.html, images: read.images, pdf, page }
}

/** «Agregar a Research»: resolves with the finished task, or with the paper the page already is. */
export async function capture(
  conn: Connection,
  inspected: Inspected,
  onStep: (step: Step) => void = () => undefined,
  onStatus?: (s: TaskStatus) => void,
  mode: CaptureMode = 'reader'
): Promise<CaptureResult> {
  const collected = await gather(inspected, onStep, mode)
  if (inspected.detection.isPdf && !collected.pdf) throw new ConnectorError(pdfPermission(inspected) ? 'pdf_permission' : 'capture_no_pdf')
  const plan = planCapture(inspected.detection, collected)
  onStep('sending')
  const started = await call<{ task: string | null; existing: Existing | null }>(conn, plan.endpoint, plan.body)
  if (!started.task) {
    if (started.existing) return { existing: started.existing }
    throw new ConnectorError('failed')
  }
  onStep('processing')
  return { status: await waitForTask(conn, started.task, { onTick: onStatus }) }
}

/** «Actualizar PDF» of the paper this page already is. */
export async function updatePdf(
  conn: Connection,
  inspected: Inspected,
  key: string,
  onStep: (step: Step) => void = () => undefined,
  mode: CaptureMode = 'reader'
): Promise<TaskStatus> {
  // The paper is known already: the PDF comes from the page even when it has a DOI or an arXiv id.
  const printable: Inspected = { ...inspected, detection: { ...inspected.detection, doi: null, arxiv: null } }
  const collected = await gather(printable, onStep, mode)
  if (inspected.detection.isPdf && !collected.pdf) throw new ConnectorError(pdfPermission(inspected) ? 'pdf_permission' : 'capture_no_pdf')
  onStep('sending')
  const { task } = await call<{ task: string }>(conn, 'capture_update_pdf', { key, ...pageBody(inspected.detection, collected) })
  onStep('processing')
  return waitForTask(conn, task)
}

export async function openInApp(conn: Connection, key: string): Promise<void> {
  await call(conn, 'open_in_app', { key })
}

export async function activeTab(): Promise<Tab | undefined> {
  const [tab] = await ext().tabs.query({ active: true, currentWindow: true })
  return tab
}
