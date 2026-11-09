import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PAPER_KINDS, type Paper, type PaperKind } from '../../../shared/schemas'
import { errorText } from '../../lib/errorText'
import { editFromForm, formFields, formFromPaper, type MetadataForm } from '../../lib/metadataForm'

type Saved = { token: string | null; undone: boolean; error: string | null }

/** What the venue is for each kind: a book chapter's is its book, a book's its publisher. */
const VENUE_LABEL: Record<PaperKind, string> = {
  article: 'journal',
  conference: 'event',
  preprint: 'venue',
  book: 'publisher',
  chapter: 'book',
  thesis: 'institution',
  report: 'institution',
  web: 'site',
  other: 'venue'
}

/**
 * «Editar metadatos»: the kind, title, authors, year (a web page's date), venue (a web page's site, a chapter's book)
 * and URL, and for books and chapters their editors, publisher, chapter and pages. Saving writes paper.yaml and the
 * BibTeX entry; the citation key stays. «Deshacer» puts back what the edit changed.
 */
export function MetadataEditor({ paper }: { paper: Paper }): React.JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<MetadataForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)

  const open = (): void => {
    setForm(formFromPaper(paper))
    setError(null)
    setSaved(null)
  }
  const set = (field: keyof MetadataForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => (f ? { ...f, [field]: e.target.value } : f))

  const save = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!form || busy) return
    const result = editFromForm(paper, form)
    if ('error' in result) {
      setError(t(`paper.edit.invalid.${result.error}`))
      return
    }
    if (Object.keys(result.edit).length === 0) {
      setForm(null)
      return
    }
    setBusy(true)
    setError(null)
    window.research.library.editMetadata(paper.id, result.edit).then(
      (r) => {
        setBusy(false)
        if (!r.ok) return setError(errorText(t, r.error))
        setForm(null)
        setSaved({ token: r.undoToken, undone: false, error: null })
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const undo = (): void => {
    if (!saved?.token || busy) return
    setBusy(true)
    window.research.library.revertMetadata(saved.token).then(
      (r) => {
        setBusy(false)
        setSaved({ token: null, undone: r.ok, error: r.ok ? null : errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setSaved({ token: null, undone: false, error: errorText(t, 'unknown') })
      }
    )
  }

  if (!form) {
    return (
      <div className="row small">
        <button className="small" onClick={open}>
          {t('paper.edit.open')}
        </button>
        {saved && !saved.undone && !saved.error && saved.token && (
          <>
            <span className="muted">{t('paper.edit.saved')}</span>
            <button className="small" disabled={busy} onClick={undo}>
              {t('paper.edit.undo')}
            </button>
          </>
        )}
        {saved?.undone && <span className="muted">{t('paper.edit.undone')}</span>}
        {saved?.error && <span className="error">{saved.error}</span>}
      </div>
    )
  }
  const shown = formFields(form.kind)
  // A date already in the entry stays editable whatever the kind.
  const dated = shown.date || Boolean(form.date.trim())
  return (
    <form className="metadata-editor column" onSubmit={save}>
      <label>
        {t('paper.edit.kind')}
        <select value={form.kind} onChange={set('kind')}>
          {PAPER_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`paper.edit.kinds.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('paper.edit.title')}
        <input value={form.title} onChange={set('title')} />
      </label>
      <label>
        {t('paper.edit.authors')}
        <textarea rows={3} value={form.authors} placeholder={t('paper.edit.authors_hint')} onChange={set('authors')} />
      </label>
      {shown.editors && (
        <label>
          {t('paper.edit.editors')}
          <textarea rows={3} value={form.editors} placeholder={t('paper.edit.authors_hint')} onChange={set('editors')} />
        </label>
      )}
      <div className="row">
        {dated ? (
          <label>
            {t('paper.edit.date')}
            <input value={form.date} placeholder={t('paper.edit.date_hint')} onChange={set('date')} />
          </label>
        ) : null}
        <label>
          {t('paper.edit.year')}
          <input value={form.year} inputMode="numeric" disabled={dated && Boolean(form.date.trim())} onChange={set('year')} />
        </label>
        <label className="grow">
          {t(`paper.edit.venue_as.${VENUE_LABEL[form.kind]}`)}
          <input value={form.venue} onChange={set('venue')} />
        </label>
      </div>
      {(shown.publisher || shown.chapter || shown.pages) && (
        <div className="row">
          {shown.publisher && (
            <label className="grow">
              {t('paper.edit.publisher')}
              <input value={form.publisher} onChange={set('publisher')} />
            </label>
          )}
          {shown.chapter && (
            <label>
              {t('paper.edit.chapter')}
              <input value={form.chapter} onChange={set('chapter')} />
            </label>
          )}
          {shown.pages && (
            <label>
              {t('paper.edit.pages')}
              <input value={form.pages} placeholder={t('paper.edit.pages_hint')} onChange={set('pages')} />
            </label>
          )}
        </div>
      )}
      <label>
        {t('paper.edit.url')}
        <input value={form.url} onChange={set('url')} />
      </label>
      <p className="muted small">{t('paper.edit.key_stays', { key: paper.id })}</p>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {t('paper.edit.save')}
        </button>
        <button type="button" disabled={busy} onClick={() => setForm(null)}>
          {t('paper.edit.cancel')}
        </button>
      </div>
    </form>
  )
}
