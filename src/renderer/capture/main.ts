import i18n from 'i18next'
import { CAPTURE_PDF_MODES, isCapturePdfMode, type CaptureApi, type CaptureState } from '../../shared/capture'
import es from '../i18n/es.json'
import { errorText } from '../lib/errorText'
import '../styles.css'

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
const status = el<HTMLSpanElement>('status')
const mode = el<HTMLSelectElement>('mode')
const replace = el<HTMLButtonElement>('replace')
const keep = el<HTMLButtonElement>('keep')

back.textContent = '←'
back.title = t('capture.back')
forward.textContent = '→'
forward.title = t('capture.forward')
reload.textContent = '⟳'
reload.title = t('capture.reload')
add.textContent = t('capture.add')
add.title = t('capture.add_hint')
cancel.textContent = t('capture.cancel')
for (const value of CAPTURE_PDF_MODES) mode.add(new Option(t(`capture.pdf_mode.${value}`), value))
mode.title = t('capture.pdf_mode_hint')
replace.textContent = t('capture.replace')
keep.textContent = t('capture.keep')

const ignore = (): void => undefined
back.onclick = () => void window.capture.back().catch(ignore)
forward.onclick = () => void window.capture.forward().catch(ignore)
reload.onclick = () => void window.capture.reload().catch(ignore)
add.onclick = () => void window.capture.add().catch(ignore)
cancel.onclick = () => void window.capture.cancel().catch(ignore)
replace.onclick = () => void window.capture.replace().catch(ignore)
keep.onclick = () => void window.capture.keep().catch(ignore)
mode.onchange = () => {
  if (isCapturePdfMode(mode.value)) void window.capture.setPdfMode(mode.value).catch(ignore)
}

function render(state: CaptureState): void {
  // Page text is set as text, never as markup.
  title.textContent = state.title || t('capture.untitled')
  url.textContent = state.url
  document.title = state.title ? `${state.title} — Research` : 'Research'
  back.disabled = !state.canGoBack
  forward.disabled = !state.canGoForward
  const adding = state.phase === 'adding'
  const confirm = state.phase === 'confirm'
  add.hidden = confirm
  add.disabled = adding || state.loading
  replace.hidden = keep.hidden = !confirm
  replace.title = confirm ? t('capture.replace_hint', { key: state.existing ?? '' }) : ''
  mode.value = state.pdfMode
  mode.disabled = adding || confirm
  status.classList.toggle('error', state.phase === 'failed')
  status.classList.toggle('muted', !confirm)
  status.classList.toggle('ask', confirm)
  if (state.phase === 'failed' && state.error) {
    status.textContent = errorText(t, state.error)
    status.title = status.textContent
  } else if (confirm) {
    status.textContent = t('capture.exists', { key: state.existing ?? '' })
    status.title = status.textContent
  } else if (adding || state.loading) {
    status.textContent = adding ? t('capture.adding') : t('capture.loading')
    status.title = status.textContent
  } else {
    // While browsing, a quiet reminder: decline non-essential cookies; the reader view leaves the dialog out anyway.
    status.textContent = t('capture.cookies_hint')
    status.title = t('capture.cookies_hint_long')
  }
}

window.capture.onState(render)
