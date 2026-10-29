import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import i18n from '../../src/renderer/i18n'
import { toolbarView } from '../../src/renderer/capture/view'
import { errorText } from '../../src/renderer/lib/errorText'
import { recaptureUrl, updateTarget, type CaptureState } from '../../src/shared/capture'

const t = i18n.t.bind(i18n) as (key: string, params?: Record<string, string>) => string
const view = (patch: Partial<CaptureState> = {}) => toolbarView(state(patch), t, (code) => errorText(i18n.t, code))

function state(patch: Partial<CaptureState>): CaptureState {
  return {
    url: 'https://eng.acme.test/posts/database-outage',
    title: 'Postmortem',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    phase: 'browsing',
    error: null,
    existing: null,
    question: null,
    pdfMode: 'reader',
    target: null,
    known: null,
    preview: 'off',
    notice: null,
    ...patch
  }
}

describe('capture toolbar: the main button', () => {
  it('adds a page that is not in the library', () => {
    const { main, target } = view()
    expect(main).toMatchObject({ action: 'add', text: 'Agregar a la biblioteca', hidden: false, disabled: false })
    expect(target.hidden).toBe(true)
  })

  it('offers to update a page already in the library, and says so before anything is pressed', () => {
    const { main, status } = view({ known: 'roe2024database' })
    expect(main).toMatchObject({ action: 'update', text: 'Actualizar PDF de roe2024database' })
    expect(main.title).toContain('roe2024database')
    expect(status).toMatchObject({ text: 'Ya está en la biblioteca como roe2024database', tone: 'info' })
  })

  it('in a window bound to a paper, updates that paper and keeps it in sight', () => {
    const { main, target, status } = view({ target: 'he2017drain' })
    expect(main).toMatchObject({ action: 'update', text: 'Actualizar PDF de he2017drain' })
    expect(target).toMatchObject({ hidden: false, text: 'Recaptura: he2017drain' })
    expect(target.title).toContain('he2017drain')
    expect(status).toMatchObject({ tone: 'info', text: 'Lo que captures aquí reemplaza su PDF.' })
    // The bound paper wins over whatever else the page may be.
    expect(updateTarget({ target: 'he2017drain', known: 'other2020x' })).toBe('he2017drain')
    expect(view({ target: 'he2017drain', known: 'other2020x' }).main.text).toBe('Actualizar PDF de he2017drain')
  })

  it('is disabled while the page loads or a capture runs, and hidden while a question is asked', () => {
    expect(view({ loading: true }).main.disabled).toBe(true)
    expect(view({ phase: 'adding', target: 'he2017drain' })).toMatchObject({ main: { disabled: true }, status: { text: 'Actualizando el PDF…' } })
    expect(view({ phase: 'confirm', question: 'exists', existing: 'roe2024database' }).main.hidden).toBe(true)
  })
})

describe('capture toolbar: the questions', () => {
  it('warns before updating from another site', () => {
    const v = view({ target: 'roe2024database', phase: 'confirm', question: 'other_site', existing: 'roe2024database' })
    expect(v.status).toMatchObject({ tone: 'ask', text: 'Estás en otra página; ¿actualizar igual el PDF de roe2024database?' })
    expect([v.replace.hidden, v.keep.hidden, v.main.hidden, v.modeDisabled]).toEqual([false, false, true, true])
  })

  it('still asks when «Agregar» finds the page in the library', () => {
    const v = view({ phase: 'confirm', question: 'exists', existing: 'roe2024database' })
    expect(v.status.text).toBe('Esta página ya está en la biblioteca como roe2024database. ¿Actualizar su PDF?')
    expect(v.replace.hidden).toBe(false)
  })

  it('shows no answer buttons without a question', () => {
    expect([view().replace.hidden, view().keep.hidden]).toEqual([true, true])
  })
})

describe('capture toolbar: «Vista de lectura»', () => {
  it('toggles between the reader view and the page', () => {
    expect(view().preview).toMatchObject({ action: 'preview', text: 'Vista de lectura', pressed: false, disabled: false })
    expect(view({ preview: 'on' })).toMatchObject({ preview: { action: 'page', text: 'Ver página', pressed: true }, status: { text: 'Vista de lectura: así quedará el PDF.' } })
    // While it is being built, the button already leads back to the page.
    expect(view({ preview: 'loading' })).toMatchObject({ preview: { action: 'page' }, status: { text: 'Preparando la vista de lectura…' } })
  })

  it('is disabled, with the reason as its tooltip, when the PDF is the page as it looks', () => {
    const { preview } = view({ pdfMode: 'page' })
    expect(preview).toMatchObject({ action: 'preview', disabled: true })
    expect(preview.title).toContain('página tal como se ve')
  })

  it('tells when the page has no article to read', () => {
    expect(view({ notice: 'no_article' }).status).toMatchObject({
      tone: 'info',
      text: 'Esta página no tiene un artículo legible; se guardará la página tal como se ve.'
    })
  })

  it('shows errors first', () => {
    expect(view({ phase: 'failed', error: 'capture_no_pdf', notice: 'no_article' }).status).toMatchObject({ tone: 'error', text: expect.stringContaining('PDF') })
  })
})

describe('recaptureUrl', () => {
  it('starts at the paper’s URL, else at its DOI', () => {
    expect(recaptureUrl({ url: 'https://eng.acme.test/post', doi: '10.1/x' })).toBe('https://eng.acme.test/post')
    expect(recaptureUrl({ doi: '10.1109/ICWS.2017.13' })).toBe('https://doi.org/10.1109/ICWS.2017.13')
    expect(recaptureUrl({ url: 'file:///etc/passwd', doi: '10.1/x' })).toBe('https://doi.org/10.1/x')
    expect(recaptureUrl({ doi: '10.1002/(SICI)1097 x<y>' })).toBe('https://doi.org/10.1002/(SICI)1097%20x%3Cy%3E')
  })

  it('is null for a paper with neither', () => {
    expect(recaptureUrl({})).toBeNull()
    expect(recaptureUrl({ url: 'javascript:alert(1)', doi: '  ' })).toBeNull()
  })
})

describe('«Volver a capturar desde la web» in the PDF and Contenido tabs', () => {
  const source = (file: string) => readFileSync(new URL(`../../src/renderer/components/paper/${file}`, import.meta.url), 'utf8')

  it('is a button that asks the main process to open the paper, by id only, shown only when there is an address', () => {
    const button = source('Recapture.tsx')
    expect(button).toContain('if (!recaptureUrl(identifiers)) return null')
    expect(button).toContain('window.research.library.recapture(id)')
    expect(i18n.t('paper.recapture')).toBe('Volver a capturar desde la web')
  })

  it('sits in the PDF tab (with a PDF and without one) and in the Contenido tab (with a PDF and without one)', () => {
    const detail = source('PaperDetail.tsx')
    const section = (from: string, to: string) => detail.slice(detail.indexOf(from), detail.indexOf(to))
    const pdfTab = section('function PdfTab(', 'function ContentTab(')
    expect(pdfTab.match(/<RecaptureButton id=\{id\} identifiers=\{identifiers\} \/>/g)).toHaveLength(2)
    expect(section('function ContentTab(', 'export function PaperDetail(')).toContain('<RecaptureButton id={id} identifiers={identifiers} />')
    expect(section("{active === 'content' &&", "{active === 'relations' &&")).toContain('<RecaptureButton id={id} identifiers={paper.identifiers} />')
    expect(detail).toContain('identifiers={paper.identifiers} hasPdf')
  })
})
