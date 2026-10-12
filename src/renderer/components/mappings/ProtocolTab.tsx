import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_TEXT, type MappingView, type ProtocolDraft } from '../../../shared/mapping'
import { PAPER_KINDS } from '../../../shared/schemas'
import { errorText } from '../../lib/errorText'
import { draftOf, draftOutdated, draftProblems, sameDraft, withThesisQuestions, yearValue } from '../../lib/mappings'

type ItemsKey = 'research_questions' | 'inclusion' | 'exclusion'

/** The protocol version and text the editing started from; null while the draft is the saved protocol. */
interface EditStart {
  base: number
  from: ProtocolDraft
}

/**
 * Unsaved drafts by mapping id, for this window's lifetime: picking another mapping or another view of the rail
 * unmounts the tab, and coming back shows the draft as it was left.
 */
const unsaved = new Map<string, { draft: ProtocolDraft; edit: EditStart }>()

/** «Protocolo»: title, objective, research questions, criteria with their ids, years, types and phases; versioned once screening started. */
export function ProtocolTab({ view, onSaved }: { view: MappingView; onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const saved = useMemo(() => draftOf(view.protocol), [view.protocol])
  const [draft, setDraft] = useState<ProtocolDraft>(() => unsaved.get(view.id)?.draft ?? saved)
  const [edit, setEdit] = useState<EditStart | null>(() => unsaved.get(view.id)?.edit ?? null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const thesisRequest = useRef(0)
  const editRef = useRef(edit)
  editRef.current = edit

  // A protocol changed elsewhere (a save, a sync, another machine) replaces the draft only while the user has not touched it;
  // a touched draft stays, and `outdated` says the saved protocol moved under it.
  useEffect(() => {
    if (!editRef.current) setDraft(saved)
  }, [saved])

  useEffect(() => {
    if (edit) unsaved.set(view.id, { draft, edit })
    else unsaved.delete(view.id)
  }, [view.id, draft, edit])

  const update = (fn: (d: ProtocolDraft) => ProtocolDraft): void => {
    setDraft(fn)
    setEdit((current) => current ?? { base: view.protocol.version, from: saved })
    setNotice(null)
  }
  const setItem = (key: ItemsKey, index: number, text: string): void =>
    update((d) => ({ ...d, [key]: d[key].map((item, i) => (i === index ? { ...item, text } : item)) }))
  const removeItem = (key: ItemsKey, index: number): void => update((d) => ({ ...d, [key]: d[key].filter((_, i) => i !== index) }))
  const addItem = (key: ItemsKey): void => update((d) => ({ ...d, [key]: [...d[key], { id: null, text: '' }] }))

  const fromThesis = (): void => {
    const token = ++thesisRequest.current
    window.research.thesis.get().then(
      (thesis) => {
        if (token === thesisRequest.current) update((d) => withThesisQuestions(d, thesis))
      },
      () => {
        if (token === thesisRequest.current) setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const problems = draftProblems(draft)
  const changed = edit !== null && !sameDraft(draft, saved)
  const outdated = edit !== null && draftOutdated(edit, view.protocol)
  const canSave = !busy && changed && problems.length === 0

  const save = (): void => {
    if (!canSave) return
    setBusy(true)
    setNotice(null)
    // The version on screen: when it moved under the draft, the «outdated» notice told the user saving replaces it.
    // A change that arrives between this click and the save is refused by the main process (`conflict`).
    window.research.mappings.saveProtocol(view.id, draft, view.protocol.version).then(
      (r) => {
        setBusy(false)
        if (!r.ok) {
          setNotice({ error: true, text: errorText(t, r.error) })
          if (r.error === 'conflict') onSaved()
          return
        }
        // The draft stays on screen until the reload brings the saved protocol (with the new items' ids).
        setEdit(null)
        setNotice({ error: false, text: t('mappings.protocol.saved') })
        onSaved()
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const discard = (): void => {
    setDraft(saved)
    setEdit(null)
    setNotice(null)
  }

  const items = (key: ItemsKey, legend: string, add: string): React.JSX.Element => (
    <fieldset>
      <legend>{legend}</legend>
      {draft[key].map((item, i) => (
        <div key={`${item.id ?? 'new'}-${i}`} className="protocol-item">
          <span className="protocol-id">{item.id ?? t('mappings.protocol.new_id')}</span>
          <textarea value={item.text} maxLength={MAX_TEXT} aria-label={`${legend} ${item.id ?? i + 1}`} onChange={(e) => setItem(key, i, e.target.value)} />
          <button type="button" className="small" onClick={() => removeItem(key, i)}>
            {t('mappings.protocol.remove')}
          </button>
        </div>
      ))}
      <div className="row small">
        <button type="button" className="small" onClick={() => addItem(key)}>
          {add}
        </button>
        {key === 'research_questions' && (
          <button type="button" className="small" onClick={fromThesis}>
            {t('mappings.protocol.from_thesis')}
          </button>
        )}
      </div>
    </fieldset>
  )

  return (
    <div className="protocol-form">
      <label>
        {t('mappings.protocol.title_label')}
        <input value={draft.title} maxLength={300} onChange={(e) => update((d) => ({ ...d, title: e.target.value }))} />
      </label>
      <label>
        {t('mappings.protocol.objective')}
        <textarea value={draft.objective} maxLength={MAX_TEXT * 3} onChange={(e) => update((d) => ({ ...d, objective: e.target.value }))} />
      </label>
      {items('research_questions', t('mappings.protocol.questions'), t('mappings.protocol.add_question'))}
      {items('inclusion', t('mappings.protocol.inclusion'), t('mappings.protocol.add_criterion'))}
      {items('exclusion', t('mappings.protocol.exclusion'), t('mappings.protocol.add_criterion'))}
      <fieldset>
        <legend>{t('mappings.protocol.years')}</legend>
        <div className="row small">
          <label>
            {t('mappings.protocol.year_from')}{' '}
            <input
              type="number"
              min={1800}
              max={2200}
              value={draft.years.from === null || Number.isNaN(draft.years.from) ? '' : draft.years.from}
              onChange={(e) => update((d) => ({ ...d, years: { ...d.years, from: yearValue(e.target.value) } }))}
            />
          </label>
          <label>
            {t('mappings.protocol.year_to')}{' '}
            <input
              type="number"
              min={1800}
              max={2200}
              value={draft.years.to === null || Number.isNaN(draft.years.to) ? '' : draft.years.to}
              onChange={(e) => update((d) => ({ ...d, years: { ...d.years, to: yearValue(e.target.value) } }))}
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="checks">
        <legend>{t('mappings.protocol.types')}</legend>
        {PAPER_KINDS.map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={draft.publication_types.includes(kind)}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  publication_types: e.target.checked ? [...d.publication_types.filter((k) => k !== kind), kind] : d.publication_types.filter((k) => k !== kind)
                }))
              }
            />{' '}
            {t(`mappings.kinds.${kind}`)}
          </label>
        ))}
      </fieldset>
      <p className="muted small">{t('mappings.protocol.phases')}</p>
      {outdated && <div className="banner warning">{t('mappings.protocol.outdated')}</div>}
      {view.screeningStarted && changed && <div className="banner warning">{t('mappings.protocol.bump_notice', { next: view.protocol.version + 1 })}</div>}
      {edit && problems.map((key) => <p key={key} className="field-error small">{t(key)}</p>)}
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      <div className="row">
        <button className="primary" disabled={!canSave} onClick={save}>
          {busy ? t('mappings.protocol.saving') : t('mappings.protocol.save')}
        </button>
        {edit && (
          <button disabled={busy} onClick={discard}>
            {t('mappings.protocol.discard')}
          </button>
        )}
      </div>
      {view.protocol.history.length > 0 && (
        <details>
          <summary>{t('mappings.protocol.history')}</summary>
          <ul className="plain-list">
            {[...view.protocol.history].reverse().map((h) => (
              <li key={`${h.version}-${h.replaced_at}`}>
                <p className="small">
                  <strong>{t('mappings.protocol.history_item', { version: h.version, date: new Date(h.replaced_at).toLocaleDateString() })}</strong>
                </p>
                <ul className="small">
                  {[...h.protocol.inclusion, ...h.protocol.exclusion].map((c) => (
                    <li key={c.id}>
                      {c.id} · {c.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
