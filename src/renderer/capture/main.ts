import i18n from 'i18next'
import { CAPTURE_PDF_MODES, isCapturePdfMode, type CaptureApi, type CaptureState } from '../../shared/capture'
import es from '../i18n/es.json'
import { errorText } from '../lib/errorText'
import '../styles.css'
import { toolbarView, type Control, type ToolbarView } from './view'

/** The toolbar of the app's browser window: plain DOM, driven by the state the main process pushes. */
declare global {
  interface Window {
    capture: CaptureApi
  }
}

void i18n.init({ resources: { es: { translation: es } }, lng: 'es', fallbackLng: 'es', interpolation: { escapeValue: false } })
const t = i18n.t.bind(i18n)

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const back = el<HTMLButtonElement>('back')
const forward = el<HTMLButtonElement>('forward')
const reload = el<HTMLButtonElement>('reload')
const add = el<HTMLButtonElement>('add')
const cancel = el<HTMLButtonElement>('cancel')
const title = el<HTMLSpanElement>('title')
const url = el<HTMLSpanElement>('url')
const target = el<HTMLSpanElement>('target')
const status = el<HTMLSpanElement>('status')
const mode = el<HTMLSelectElement>('mode')
const preview = el<HTMLButtonElement>('preview')
const replace = el<HTMLButtonElement>('replace')
const keep = el<HTMLButtonElement>('keep')

back.textContent = '←'
back.title = t('capture.back')
forward.textContent = '→'
forward.title = t('capture.forward')
reload.textContent = '⟳'
reload.title = t('capture.reload')
cancel.textContent = t('capture.cancel')
for (const value of CAPTURE_PDF_MODES) mode.add(new Option(t(`capture.pdf_mode.${value}`), value))
mode.title = t('capture.pdf_mode_hint')

let view: ToolbarView | null = null
const ignore = (): void => undefined
back.onclick = () => void window.capture.back().catch(ignore)
forward.onclick = () => void window.capture.forward().catch(ignore)
reload.onclick = () => void window.capture.reload().catch(ignore)
add.onclick = () => void (view?.main.action === 'update' ? window.capture.update() : window.capture.add()).catch(ignore)
preview.onclick = () => void (view?.preview.action === 'page' ? window.capture.showPage() : window.capture.preview()).catch(ignore)
cancel.onclick = () => void window.capture.cancel().catch(ignore)
replace.onclick = () => void window.capture.replace().catch(ignore)
keep.onclick = () => void window.capture.keep().catch(ignore)
mode.onchange = () => {
  if (isCapturePdfMode(mode.value)) void window.capture.setPdfMode(mode.value).catch(ignore)
}

/** Page text is set as text, never as markup. */
function apply(node: HTMLElement, control: Control): void {
  node.textContent = control.text
  node.title = control.title
  node.hidden = control.hidden
  if (node instanceof HTMLButtonElement) node.disabled = control.disabled
}

function render(state: CaptureState): void {
  view = toolbarView(state, t, (code) => errorText(t, code))
  title.textContent = state.title || t('capture.untitled')
  url.textContent = state.url
  document.title = state.title ? `${state.title} — Research` : 'Research'
  back.disabled = !state.canGoBack
  forward.disabled = !state.canGoForward
  apply(add, view.main)
  apply(preview, view.preview)
  preview.setAttribute('aria-pressed', String(view.preview.pressed))
  preview.classList.toggle('active', view.preview.pressed)
  apply(target, view.target)
  apply(replace, view.replace)
  apply(keep, view.keep)
  mode.value = state.pdfMode
  mode.disabled = view.modeDisabled
  status.textContent = view.status.text
  status.title = view.status.title
  status.classList.toggle('error', view.status.tone === 'error')
  status.classList.toggle('muted', view.status.tone === 'muted')
  status.classList.toggle('ask', view.status.tone === 'ask')
  status.classList.toggle('info', view.status.tone === 'info')
}

window.capture.onState(render)
