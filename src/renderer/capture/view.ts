import { updateTarget, type CaptureState } from '../../shared/capture'

type T = (key: string, params?: Record<string, string>) => string

/** One toolbar control as it should look. */
export interface Control {
  text: string
  title: string
  hidden: boolean
  disabled: boolean
}

/** What the toolbar shows for a state; `main.ts` only copies it to the DOM. */
export interface ToolbarView {
  /** «Agregar a la biblioteca», or «Actualizar PDF de <clave>» (`action: 'update'`). */
  main: Control & { action: 'add' | 'update' }
  /** «Vista de lectura» (`action: 'preview'`) or «Ver página» (`action: 'page'`). */
  preview: Control & { action: 'preview' | 'page'; pressed: boolean }
  /** The paper a bound window updates, always in sight; hidden when the window adds pages. */
  target: Control
  status: { text: string; title: string; tone: 'muted' | 'error' | 'ask' | 'info' }
  replace: Control
  keep: Control
  modeDisabled: boolean
}

const control = (text: string, title = '', hidden = false, disabled = false): Control => ({ text, title, hidden, disabled })

/**
 * The toolbar for `state`. `errorText` turns an error code into its message. A bound window («Volver a capturar desde
 * la web») and a page already in the library both turn the main button into «Actualizar PDF de <clave>»; there is no
 * «Agregar como nuevo»: the library keeps one paper per URL, so a second copy of the page would be a duplicate.
 */
export function toolbarView(state: CaptureState, t: T, errorText: (code: string) => string): ToolbarView {
  const adding = state.phase === 'adding'
  const confirm = state.phase === 'confirm'
  const key = updateTarget(state)
  const main = key
    ? { ...control(t('capture.update', { key }), t('capture.update_hint', { key }), confirm, adding || state.loading), action: 'update' as const }
    : { ...control(t('capture.add'), t('capture.add_hint'), confirm, adding || state.loading), action: 'add' as const }

  const showing = state.preview !== 'off'
  const pageMode = state.pdfMode === 'page'
  const preview = showing
    ? { ...control(t('capture.show_page'), t('capture.show_page_hint'), false, adding), action: 'page' as const, pressed: true }
    : {
        ...control(t('capture.preview'), pageMode ? t('capture.preview_page_mode') : t('capture.preview_hint'), false, pageMode || adding || confirm),
        action: 'preview' as const,
        pressed: false
      }

  const target = state.target
    ? control(t('capture.target', { key: state.target }), t('capture.target_hint', { key: state.target }))
    : control('', '', true)

  const question = confirm && state.existing ? state.question : null
  const replace = control(t('capture.replace'), question ? t('capture.replace_hint', { key: state.existing ?? '' }) : '', !question)
  const keep = control(t('capture.keep'), '', !question)

  const say = (text: string, tone: ToolbarView['status']['tone'] = 'muted', title = text): ToolbarView['status'] => ({ text, title, tone })
  let status: ToolbarView['status']
  if (state.phase === 'failed' && state.error) status = say(errorText(state.error), 'error')
  else if (question === 'other_site') status = say(t('capture.other_site', { key: state.existing ?? '' }), 'ask')
  else if (question === 'exists') status = say(t('capture.exists', { key: state.existing ?? '' }), 'ask')
  else if (adding) status = say(key ? t('capture.updating') : t('capture.adding'))
  else if (state.notice === 'no_article') status = say(t('capture.no_article'), 'info')
  else if (state.preview === 'loading') status = say(t('capture.preview_loading'))
  else if (state.loading) status = say(t('capture.loading'))
  else if (state.preview === 'on') status = say(t('capture.preview_on'), 'info')
  else if (state.target) status = say(t('capture.target_status', { key: state.target }), 'info')
  else if (state.known) status = say(t('capture.known', { key: state.known }), 'info')
  // While browsing, a quiet reminder: decline non-essential cookies; the reader view leaves the dialog out anyway.
  else status = say(t('capture.cookies_hint'), 'muted', t('capture.cookies_hint_long'))

  return { main, preview, target, status, replace, keep, modeDisabled: adding || confirm }
}
