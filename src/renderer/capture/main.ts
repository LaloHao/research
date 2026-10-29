import i18n from 'i18next'
import type { CaptureApi, CaptureState } from '../../shared/capture'
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

back.textContent = '←'
back.title = t('capture.back')
forward.textContent = '→'
forward.title = t('capture.forward')
reload.textContent = '⟳'
reload.title = t('capture.reload')
add.textContent = t('capture.add')
add.title = t('capture.add_hint')
cancel.textContent = t('capture.cancel')

const ignore = (): void => undefined
back.onclick = () => void window.capture.back().catch(ignore)
forward.onclick = () => void window.capture.forward().catch(ignore)
reload.onclick = () => void window.capture.reload().catch(ignore)
add.onclick = () => void window.capture.add().catch(ignore)
cancel.onclick = () => void window.capture.cancel().catch(ignore)

function render(state: CaptureState): void {
  // Page text is set as text, never as markup.
  title.textContent = state.title || t('capture.untitled')
  url.textContent = state.url
  document.title = state.title ? `${state.title} — Research` : 'Research'
  back.disabled = !state.canGoBack
  forward.disabled = !state.canGoForward
  const adding = state.phase === 'adding'
  add.disabled = adding || state.loading
  status.classList.toggle('error', state.phase === 'failed')
  status.textContent =
    state.phase === 'failed' && state.error ? errorText(t, state.error) : adding ? t('capture.adding') : state.loading ? t('capture.loading') : ''
  status.title = status.textContent
}

window.capture.onState(render)
