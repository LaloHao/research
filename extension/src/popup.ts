/**
 * The toolbar popup: what the page is (DOI, arXiv, PDF, web article, its title), whether it is in the library
 * already, «Agregar a Research» or «Actualizar PDF», the progress, the result and «Abrir en Research». Everything from
 * the page is shown as text, never as markup.
 */
import { ConnectorError, type Connection, type Existing, type TaskStatus } from './api'
import { ext } from './browser'
import { errorMessage, outcomeMessage } from './errors'
import { activeTab, capture, connection, inspect, lookup, openInApp, pdfPermission, updatePdf, type Inspected, type Step } from './flow'
import { kindLabel } from './payload'

const app = document.getElementById('app')!

const STEPS: Record<Step, string> = {
  pdf: 'Descargando el PDF…',
  reading: 'Leyendo la página…',
  sending: 'Enviando a Research…',
  processing: 'Research lo está agregando…'
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { text?: string; className?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.text !== undefined) node.textContent = props.text
  if (props.className) node.className = props.className
  node.append(...children)
  return node
}

function button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { text, className: primary ? 'primary' : undefined })
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

function show(...nodes: Node[]): void {
  app.replaceChildren(...nodes)
}

const codeOf = (error: unknown): string => (error instanceof ConnectorError ? error.code : 'failed')

function showError(error: unknown, retry?: () => void): void {
  const code = codeOf(error)
  const nodes: Node[] = [el('p', { text: errorMessage(code), className: 'error' })]
  const row = el('div', { className: 'row' })
  if (code === 'not_paired' || code === 'unreachable') row.append(button('Abrir opciones', () => void ext().runtime.openOptionsPage()))
  if (retry) row.append(button('Reintentar', retry))
  if (row.childElementCount) nodes.push(row)
  show(...nodes)
}

function describe(inspected: Inspected): Node[] {
  const d = inspected.detection
  const nodes: Node[] = [el('div', { text: kindLabel(d), className: 'kind' }), el('p', { text: d.title || d.url, className: 'title' })]
  if (d.doi) nodes.push(el('div', { text: `DOI ${d.doi}`, className: 'id' }))
  if (d.arxiv) nodes.push(el('div', { text: `arXiv ${d.arxiv}`, className: 'id' }))
  if (d.pdfUrl && !d.isPdf) nodes.push(el('div', { text: 'Con PDF enlazado', className: 'muted small' }))
  return nodes
}

function finished(conn: Connection, status: TaskStatus): void {
  const key = status.key ?? ''
  const nodes: Node[] = [el('p', { text: outcomeMessage(status.outcome, key), className: 'ok' })]
  if (status.title) nodes.push(el('p', { text: status.title, className: 'muted small' }))
  if (key) nodes.push(el('div', { className: 'row' }, openButton(conn, key)))
  show(...nodes)
}

function openButton(conn: Connection, key: string): HTMLButtonElement {
  return button('Abrir en Research', () => {
    openInApp(conn, key).then(
      () => window.close(),
      (error) => showError(error)
    )
  })
}

function progress(head: Node[], step: Step): void {
  show(...head, el('p', { text: STEPS[step], className: 'muted' }))
}

/** The host permission to fetch a PDF from the extension, asked first thing in the click (Firefox needs the gesture). */
async function askPdfPermission(inspected: Inspected, granted: boolean): Promise<void> {
  const origin = pdfPermission(inspected)
  if (!origin || granted) return
  await ext()
    .permissions.request({ origins: [origin] })
    .catch(() => false)
}

function ready(conn: Connection, inspected: Inspected, existing: Existing | null, granted: boolean): void {
  const head = describe(inspected)
  const add = (): void => {
    const asked = askPdfPermission(inspected, granted)
    void asked.then(async () => {
      try {
        const result = await capture(conn, inspected, (step) => progress(head, step))
        if ('existing' in result) ready(conn, inspected, result.existing, true)
        else finished(conn, result.status)
      } catch (error) {
        showError(error, () => ready(conn, inspected, existing, granted))
      }
    })
  }
  const update = (key: string): void => {
    const asked = askPdfPermission(inspected, granted)
    void asked.then(async () => {
      try {
        finished(conn, await updatePdf(conn, inspected, key, (step) => progress(head, step)))
      } catch (error) {
        showError(error, () => ready(conn, inspected, existing, granted))
      }
    })
  }
  if (existing) {
    show(
      ...head,
      el('p', { className: 'notice' }, document.createTextNode('Ya está en tu biblioteca como '), el('strong', { text: existing.key }), document.createTextNode('.')),
      el('div', { className: 'row' }, button('Actualizar PDF', () => update(existing.key), true), openButton(conn, existing.key))
    )
    return
  }
  show(...head, el('div', { className: 'row' }, button('Agregar a Research', add, true)))
}

async function start(): Promise<void> {
  const conn = await connection()
  const tab = await activeTab()
  let inspected: Inspected
  try {
    if (!tab) throw new ConnectorError('restricted')
    inspected = await inspect(tab)
  } catch (error) {
    return showError(error)
  }
  const origin = pdfPermission(inspected)
  const granted = origin ? await ext().permissions.contains({ origins: [origin] }).catch(() => false) : true
  let existing: Existing | null = null
  try {
    existing = await lookup(conn, inspected)
  } catch (error) {
    return showError(error, () => void start())
  }
  ready(conn, inspected, existing, granted)
}

document.getElementById('options')!.addEventListener('click', (event) => {
  event.preventDefault()
  void ext().runtime.openOptionsPage()
})
void start()
