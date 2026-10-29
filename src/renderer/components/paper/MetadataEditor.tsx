import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Paper } from '../../../shared/schemas'
import { errorText } from '../../lib/errorText'
import { editFromForm, formFromPaper, type MetadataForm } from '../../lib/metadataForm'

type Saved = { token: string | null; undone: boolean; error: string | null }

/**
 * «Editar metadatos»: title, authors, year (a web page's date), venue (its site) and URL. Saving writes paper.yaml
 * and the BibTeX entry; the citation key stays. «Deshacer» puts back what the edit changed.
 */
export function MetadataEditor({ paper }: { paper: Paper }): React.JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<MetadataForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const web = paper.kind === 'web'

  const open = (): void => {
    setForm(formFromPaper(paper))
    setError(null)
    setSaved(null)
  }
  const set = (field: keyof MetadataForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
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
  return (
    <form className="metadata-editor column" onSubmit={save}>
      <label>
        {t('paper.edit.title')}
        <input value={form.title} onChange={set('title')} />
      </label>
      <label>
        {t('paper.edit.authors')}
        <textarea rows={3} value={form.authors} placeholder={t('paper.edit.authors_hint')} onChange={set('authors')} />
      </label>
      <div className="row">
        {web ? (
          <label>
            {t('paper.edit.date')}
            <input value={form.date} placeholder={t('paper.edit.date_hint')} onChange={set('date')} />
          </label>
        ) : null}
        <label>
          {t('paper.edit.year')}
          <input value={form.year} inputMode="numeric" disabled={web && Boolean(form.date.trim())} onChange={set('year')} />
        </label>
        <label className="grow">
          {t(web ? 'paper.edit.site' : 'paper.edit.venue')}
          <input value={form.venue} onChange={set('venue')} />
        </label>
      </div>
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
