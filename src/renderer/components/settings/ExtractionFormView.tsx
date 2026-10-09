import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FACET_TYPES, type ExtractionForm, type FacetDef, type FormImpact, type FormInfo } from '../../../shared/summary'
import {
  addFacet,
  addValue,
  draftFromForm,
  formFromDraft,
  isDirty,
  removeAlias,
  removeFacet,
  removeValue,
  replaceFacet,
  updateFacet,
  validateDraft,
  validateNewValue,
  type DraftIssue,
  type FormDraft
} from '../../lib/formDraft'
import { parseInteger, type NumberIssue } from '../../lib/numberField'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

type FacetType = (typeof FACET_TYPES)[number]

interface Editor {
  saved: ExtractionForm
  draft: FormDraft
  /** Ids present when `saved` was loaded; a facet whose id isn't here was added this editing session, so its key and type stay editable. */
  savedIds: Set<string>
}

interface NewFacetDraft {
  key: string
  type: FacetType
  description: string
  values: string[]
  valueInput: string
  min: string
  max: string
}

const EMPTY_NEW_FACET: NewFacetDraft = { key: '', type: 'single', description: '', values: [], valueInput: '', min: '1', max: '5' }

function describedBy(...ids: Array<string | undefined>): string | undefined {
  const list = ids.filter((id): id is string => Boolean(id))
  return list.length ? list.join(' ') : undefined
}

function editorFor(saved: ExtractionForm): Editor {
  const draft = draftFromForm(saved)
  return { saved, draft, savedIds: new Set(draft.facets.map((f) => f.id)) }
}

function FieldError({ id, issue, namespace = 'settings.form_editor.issues' }: { id: string; issue: DraftIssue | NumberIssue | undefined; namespace?: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!issue) return null
  return (
    <small id={id} className="field-error" role="alert">
      {t(`${namespace}.${issue}`)}
    </small>
  )
}

export function ExtractionFormView(): React.JSX.Element {
  const { t } = useTranslation()
  const [formInfo, setFormInfo] = useState<FormInfo | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [outdated, setOutdated] = useState(false)
  const [issues, setIssues] = useState<Record<string, DraftIssue>>({})
  const [attempted, setAttempted] = useState(false)
  const [impact, setImpact] = useState<FormImpact | null>(null)
  const [impactDraft, setImpactDraft] = useState<FormDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [newFacet, setNewFacet] = useState<NewFacetDraft | null>(null)
  const [newFacetIssues, setNewFacetIssues] = useState<Record<string, DraftIssue>>({})
  const [newValueText, setNewValueText] = useState<Record<string, string>>({})
  const [newValueIssue, setNewValueIssue] = useState<Record<string, DraftIssue>>({})
  const [scaleText, setScaleText] = useState<Record<string, string>>({})
  const [scaleIssues, setScaleIssues] = useState<Record<string, NumberIssue>>({})

  // Mirrored synchronously (not via an effect) so an IPC event handled right after our own setEditor call always
  // sees the latest draft, instead of racing a false "changed outside this editor" banner.
  const editorRef = useRef<Editor | null>(null)
  const applyEditor = (next: Editor | null): void => {
    editorRef.current = next
    setEditor(next)
  }

  const clearPending = (): void => {
    setIssues({})
    setAttempted(false)
    setImpact(null)
    setImpactDraft(null)
    setNewFacet(null)
    setNewFacetIssues({})
    setNewValueText({})
    setNewValueIssue({})
    setScaleText({})
    setScaleIssues({})
  }

  const load = useCallback(() => {
    window.research.llm.info().then((info) => {
      setFormInfo(info.form)
      if (info.form.status !== 'ok') {
        applyEditor(null)
        setOutdated(false)
        return
      }
      const nextSaved = info.form.form
      const current = editorRef.current
      if (current && isDirty(current.saved, current.draft)) {
        if (isDirty(current.saved, draftFromForm(nextSaved))) setOutdated(true)
        return
      }
      applyEditor(editorFor(nextSaved))
      setOutdated(false)
    }, () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const mutate = (fn: (draft: FormDraft) => FormDraft): void => {
    if (!editor) return
    const nextDraft = fn(editor.draft)
    applyEditor({ ...editor, draft: nextDraft })
    setImpact(null)
    setImpactDraft(null)
    if (attempted) setIssues(validateDraft(nextDraft))
  }

  const discardAndReload = (): void => {
    setOutdated(false)
    applyEditor(null)
    clearPending()
    load()
  }

  const createDefault = (): void => {
    setError(null)
    window.research.llm.createForm().then(
      (result) => {
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const onDiscardChanges = (): void => {
    if (!editor) return
    applyEditor(editorFor(editor.saved))
    clearPending()
    setOutdated(false)
  }

  const onSave = (): void => {
    if (!editor || busy) return
    setAttempted(true)
    const problems = validateDraft(editor.draft)
    setIssues(problems)
    if (Object.keys(problems).length) return
    setError(null)
    const requestDraft = editor.draft
    setBusy(true)
    window.research.llm.formImpact(formFromDraft(requestDraft)).then(
      (result) => {
        setBusy(false)
        if (editorRef.current?.draft !== requestDraft) return // the draft moved on while this request was in flight
        setImpact(result)
        setImpactDraft(requestDraft)
      },
      () => {
        setBusy(false)
        if (editorRef.current?.draft !== requestDraft) return
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const confirmSave = (): void => {
    if (!editor || !impactDraft || busy) return
    if (editor.draft !== impactDraft) {
      // The draft changed since this impact was previewed; drop it rather than save something the user didn't see.
      setImpact(null)
      setImpactDraft(null)
      return
    }
    setError(null)
    setBusy(true)
    window.research.llm.updateForm(formFromDraft(impactDraft)).then(
      (result) => {
        setBusy(false)
        if (!result.ok) {
          setError(errorText(t, result.error))
          return
        }
        setImpact(null)
        setImpactDraft(null)
        setIssues({})
        setAttempted(false)
        applyEditor(editorFor(formFromDraft(impactDraft)))
        setOutdated(false)
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const onResetConfirmed = (): void => {
    if (busy) return
    setConfirmReset(false)
    setError(null)
    setBusy(true)
    window.research.llm.resetForm().then(
      (result) => {
        setBusy(false)
        if (!result.ok) {
          setError(errorText(t, result.error))
          return
        }
        applyEditor(null)
        clearPending()
        setOutdated(false)
        load()
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const addValueClick = (id: string, existing: string[]): void => {
    const text = (newValueText[id] ?? '').trim()
    const problem = validateNewValue(existing, text)
    if (problem) {
      setNewValueIssue((c) => ({ ...c, [id]: problem }))
      return
    }
    mutate((d) => addValue(d, id, text))
    setNewValueText((c) => ({ ...c, [id]: '' }))
    setNewValueIssue((c) => {
      const { [id]: _removed, ...rest } = c
      return rest
    })
  }

  const scaleKey = (id: string, field: 'min' | 'max'): string => `${id}.${field}`

  const scaleValue = (id: string, field: 'min' | 'max', current: number): string => scaleText[scaleKey(id, field)] ?? String(current)

  const editScale = (id: string, field: 'min' | 'max', value: string): void => {
    setScaleText((c) => ({ ...c, [scaleKey(id, field)]: value }))
    setScaleIssues((c) => {
      const { [scaleKey(id, field)]: _removed, ...rest } = c
      return rest
    })
  }

  const commitScale = (id: string, field: 'min' | 'max'): void => {
    const raw = scaleText[scaleKey(id, field)]
    if (raw === undefined) return
    const parsed = parseInteger(raw)
    if (parsed.ok) {
      setScaleIssues((c) => {
        const { [scaleKey(id, field)]: _removed, ...rest } = c
        return rest
      })
      mutate((d) => updateFacet(d, id, { [field]: parsed.value } as Partial<FacetDef>))
    } else {
      setScaleIssues((c) => ({ ...c, [scaleKey(id, field)]: parsed.issue }))
    }
  }

  const changeFacetType = (id: string, current: FacetDef, nextType: FacetType): void => {
    if (nextType === current.type) return
    const base = { key: current.key, description: current.description }
    let next: FacetDef
    if (nextType === 'text') next = { ...base, type: 'text' }
    else if (nextType === 'scale') next = { ...base, type: 'scale', min: 1, max: 5 }
    else next = { ...base, type: nextType, values: 'values' in current ? current.values : [] }
    mutate((d) => replaceFacet(d, id, next))
  }

  const addValueToNewFacet = (): void => {
    if (!newFacet) return
    const text = newFacet.valueInput.trim()
    const problem = validateNewValue(newFacet.values, text)
    if (problem) {
      setNewFacetIssues((c) => ({ ...c, valueInput: problem }))
      return
    }
    setNewFacet({ ...newFacet, values: [...newFacet.values, text], valueInput: '' })
    setNewFacetIssues((c) => {
      const { valueInput: _removed, ...rest } = c
      return rest
    })
  }

  const submitNewFacet = (): void => {
    if (!editor || !newFacet) return
    let candidate: FacetDef
    if (newFacet.type === 'text') candidate = { key: newFacet.key, type: 'text', description: newFacet.description }
    else if (newFacet.type === 'scale')
      candidate = { key: newFacet.key, type: 'scale', description: newFacet.description, min: Number(newFacet.min), max: Number(newFacet.max) }
    else candidate = { key: newFacet.key, type: newFacet.type, description: newFacet.description, values: newFacet.values }

    const id = crypto.randomUUID()
    const candidateDraft = addFacet(editor.draft, candidate, id)
    const problems = validateDraft(candidateDraft)
    const prefix = `facets.${id}.`
    const relevant: Record<string, DraftIssue> = {}
    for (const [path, issue] of Object.entries(problems)) {
      if (path.startsWith(prefix)) relevant[path.slice(prefix.length)] = issue
    }
    if (Object.keys(relevant).length) {
      setNewFacetIssues(relevant)
      return
    }
    mutate(() => candidateDraft)
    setNewFacet(null)
    setNewFacetIssues({})
  }

  if (!formInfo) return <section className="extraction-form" />

  const dirty = editor ? isDirty(editor.saved, editor.draft) : false

  return (
    <section className="extraction-form">
      <h3>{t('settings.form_section')}</h3>
      {error && <div className="banner error">{error}</div>}
      {formInfo.status === 'missing' && (
        <div>
          <p className="muted">{t('settings.form_missing')}</p>
          <button className="primary" onClick={createDefault}>
            {t('settings.form_create')}
          </button>
        </div>
      )}
      {formInfo.status === 'invalid' && (
        <div>
          <p>{t('settings.form_invalid')}</p>
          <ul>
            {formInfo.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {formInfo.status === 'ok' && editor && (
        <>
          <p className="muted small">{t('settings.form_editor.help')}</p>
          {outdated && (
            <div className="banner warning">
              <span>{t('settings.form_editor.outdated_banner')}</span>
              <button className="primary" onClick={discardAndReload}>
                {t('settings.form_editor.reload_discard')}
              </button>
            </div>
          )}

          {editor.draft.facets.map(({ id, facet }) => {
            const isNew = !editor.savedIds.has(id)
            const keyErrorId = `facet-${id}-key-error`
            const keyHintId = `facet-${id}-key-hint`
            const descErrorId = `facet-${id}-description-error`
            const valuesErrorId = `facet-${id}-values-error`
            const newValueErrorId = `newvalue-${id}-error`
            const newValueHintId = `newvalue-${id}-hint`
            const minErrorId = `facet-${id}-min-error`
            const maxErrorId = `facet-${id}-max-error`
            const minIssue = scaleIssues[scaleKey(id, 'min')]
            const maxIssue = scaleIssues[scaleKey(id, 'max')]
            const maxOrderIssue = !maxIssue && issues[`facets.${id}.max`] === 'scale_order' ? 'scale_order' : undefined
            return (
              <div className="card" key={id}>
                <div className="row">
                  {isNew ? (
                    <label className="field">
                      <span>{t('settings.form_editor.key_label')}</span>
                      <input
                        aria-invalid={issues[`facets.${id}.key`] ? true : undefined}
                        aria-describedby={describedBy(keyHintId, issues[`facets.${id}.key`] ? keyErrorId : undefined)}
                        className={issues[`facets.${id}.key`] ? 'invalid' : undefined}
                        value={facet.key}
                        onChange={(e) => mutate((d) => updateFacet(d, id, { key: e.target.value }))}
                      />
                      <small id={keyHintId} className="muted">
                        {t('settings.form_editor.snake_case_hint')}
                      </small>
                      <FieldError id={keyErrorId} issue={issues[`facets.${id}.key`]} />
                    </label>
                  ) : (
                    <strong>{facet.key}</strong>
                  )}
                  {isNew ? (
                    <select value={facet.type} onChange={(e) => changeFacetType(id, facet, e.target.value as FacetType)}>
                      {FACET_TYPES.map((ft) => (
                        <option key={ft} value={ft}>
                          {t(`settings.form_editor.types.${ft}`)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="chip">{t(`settings.form_editor.types.${facet.type}`)}</span>
                  )}
                </div>

                <label className="field">
                  <span>{t('settings.form_editor.description_label')}</span>
                  <textarea
                    aria-invalid={issues[`facets.${id}.description`] ? true : undefined}
                    aria-describedby={issues[`facets.${id}.description`] ? descErrorId : undefined}
                    className={issues[`facets.${id}.description`] ? 'invalid' : undefined}
                    value={facet.description}
                    onChange={(e) => mutate((d) => updateFacet(d, id, { description: e.target.value }))}
                  />
                  <FieldError id={descErrorId} issue={issues[`facets.${id}.description`]} />
                </label>

                {(facet.type === 'single' || facet.type === 'multi') && (
                  <div className="field">
                    <span>{t('settings.form_editor.values_label')}</span>
                    <div className="chip-list">
                      {facet.values.map((v) => (
                        <span className="chip" key={v}>
                          {v}{' '}
                          <button type="button" className="chip-remove" aria-label={t('settings.form_editor.remove_value')} onClick={() => mutate((d) => removeValue(d, id, v))}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <FieldError id={valuesErrorId} issue={issues[`facets.${id}.values`]} />
                    <div className="row small">
                      <input
                        aria-invalid={newValueIssue[id] ? true : undefined}
                        aria-describedby={describedBy(newValueHintId, newValueIssue[id] ? newValueErrorId : undefined)}
                        className={newValueIssue[id] ? 'invalid' : undefined}
                        placeholder={t('settings.form_editor.add_value_placeholder')}
                        value={newValueText[id] ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setNewValueText((c) => ({ ...c, [id]: value }))
                          setNewValueIssue((c) => {
                            const { [id]: _removed, ...rest } = c
                            return rest
                          })
                        }}
                      />
                      <button type="button" onClick={() => addValueClick(id, facet.values)}>
                        {t('settings.form_editor.add_value')}
                      </button>
                    </div>
                    <FieldError id={newValueErrorId} issue={newValueIssue[id]} />
                    <small id={newValueHintId} className="muted">
                      {t('settings.form_editor.snake_case_hint')}
                    </small>
                  </div>
                )}

                {facet.type === 'scale' && (
                  <div className="row">
                    <label className="field">
                      <span>{t('settings.form_editor.min_label')}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={minIssue ? true : undefined}
                        aria-describedby={minIssue ? minErrorId : undefined}
                        className={minIssue ? 'invalid' : undefined}
                        value={scaleValue(id, 'min', facet.min)}
                        onChange={(e) => editScale(id, 'min', e.target.value)}
                        onBlur={() => commitScale(id, 'min')}
                      />
                      <FieldError id={minErrorId} issue={minIssue} namespace="settings.invalid" />
                    </label>
                    <label className="field">
                      <span>{t('settings.form_editor.max_label')}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={maxIssue || maxOrderIssue ? true : undefined}
                        aria-describedby={maxIssue ? maxErrorId : maxOrderIssue ? maxErrorId : undefined}
                        className={maxIssue || maxOrderIssue ? 'invalid' : undefined}
                        value={scaleValue(id, 'max', facet.max)}
                        onChange={(e) => editScale(id, 'max', e.target.value)}
                        onBlur={() => commitScale(id, 'max')}
                      />
                      {maxIssue ? (
                        <FieldError id={maxErrorId} issue={maxIssue} namespace="settings.invalid" />
                      ) : (
                        <FieldError id={maxErrorId} issue={maxOrderIssue} />
                      )}
                    </label>
                  </div>
                )}

                {Object.keys(editor.draft.value_aliases[facet.key] ?? {}).length > 0 && (
                  <div className="field">
                    <span>{t('settings.form_editor.aliases_label')}</span>
                    <div className="chip-list">
                      {Object.entries(editor.draft.value_aliases[facet.key] ?? {}).map(([from, to]) => (
                        <span className="chip" key={from}>
                          {from} → {to}{' '}
                          <button
                            type="button"
                            className="chip-remove"
                            aria-label={t('settings.form_editor.remove_alias')}
                            onClick={() => mutate((d) => removeAlias(d, facet.key, from))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {confirmRemove === id ? (
                  <div className="banner warning">
                    <span>{t('settings.form_editor.remove_facet_confirm_text')}</span>
                    <button
                      className="primary"
                      onClick={() => {
                        mutate((d) => removeFacet(d, id))
                        setConfirmRemove(null)
                      }}
                    >
                      {t('settings.form_editor.confirm')}
                    </button>
                    <button onClick={() => setConfirmRemove(null)}>{t('settings.form_editor.cancel')}</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(id)}>{t('settings.form_editor.remove_facet')}</button>
                )}
              </div>
            )
          })}

          {newFacet ? (
            <div className="card">
              <label className="field">
                <span>{t('settings.form_editor.key_label')}</span>
                <input
                  aria-invalid={newFacetIssues.key ? true : undefined}
                  aria-describedby={describedBy('new-facet-key-hint', newFacetIssues.key ? 'new-facet-key-error' : undefined)}
                  className={newFacetIssues.key ? 'invalid' : undefined}
                  value={newFacet.key}
                  onChange={(e) => setNewFacet({ ...newFacet, key: e.target.value })}
                />
                <small id="new-facet-key-hint" className="muted">
                  {t('settings.form_editor.snake_case_hint')}
                </small>
                <FieldError id="new-facet-key-error" issue={newFacetIssues.key} />
              </label>
              <label className="field">
                <span>{t('settings.form_editor.type_label')}</span>
                <select value={newFacet.type} onChange={(e) => setNewFacet({ ...newFacet, type: e.target.value as FacetType })}>
                  {FACET_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {t(`settings.form_editor.types.${ft}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('settings.form_editor.description_label')}</span>
                <textarea
                  aria-invalid={newFacetIssues.description ? true : undefined}
                  aria-describedby={newFacetIssues.description ? 'new-facet-description-error' : undefined}
                  className={newFacetIssues.description ? 'invalid' : undefined}
                  value={newFacet.description}
                  onChange={(e) => setNewFacet({ ...newFacet, description: e.target.value })}
                />
                <FieldError id="new-facet-description-error" issue={newFacetIssues.description} />
              </label>

              {(newFacet.type === 'single' || newFacet.type === 'multi') && (
                <div className="field">
                  <span>{t('settings.form_editor.values_label')}</span>
                  <div className="chip-list">
                    {newFacet.values.map((v) => (
                      <span className="chip" key={v}>
                        {v}{' '}
                        <button
                          type="button"
                          className="chip-remove"
                          aria-label={t('settings.form_editor.remove_value')}
                          onClick={() => setNewFacet({ ...newFacet, values: newFacet.values.filter((x) => x !== v) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <FieldError id="new-facet-values-error" issue={newFacetIssues.values} />
                  <div className="row small">
                    <input
                      aria-invalid={newFacetIssues.valueInput ? true : undefined}
                      aria-describedby={describedBy('new-facet-value-input-hint', newFacetIssues.valueInput ? 'new-facet-value-input-error' : undefined)}
                      className={newFacetIssues.valueInput ? 'invalid' : undefined}
                      placeholder={t('settings.form_editor.add_value_placeholder')}
                      value={newFacet.valueInput}
                      onChange={(e) => setNewFacet({ ...newFacet, valueInput: e.target.value })}
                    />
                    <button type="button" onClick={addValueToNewFacet}>
                      {t('settings.form_editor.add_value')}
                    </button>
                  </div>
                  <FieldError id="new-facet-value-input-error" issue={newFacetIssues.valueInput} />
                  <small id="new-facet-value-input-hint" className="muted">
                    {t('settings.form_editor.snake_case_hint')}
                  </small>
                </div>
              )}

              {newFacet.type === 'scale' && (
                <div className="row">
                  <label className="field">
                    <span>{t('settings.form_editor.min_label')}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-invalid={newFacetIssues.min ? true : undefined}
                      aria-describedby={newFacetIssues.min ? 'new-facet-min-error' : undefined}
                      className={newFacetIssues.min ? 'invalid' : undefined}
                      value={newFacet.min}
                      onChange={(e) => setNewFacet({ ...newFacet, min: e.target.value })}
                    />
                    <FieldError id="new-facet-min-error" issue={newFacetIssues.min} />
                  </label>
                  <label className="field">
                    <span>{t('settings.form_editor.max_label')}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-invalid={newFacetIssues.max ? true : undefined}
                      aria-describedby={newFacetIssues.max ? 'new-facet-max-error' : undefined}
                      className={newFacetIssues.max ? 'invalid' : undefined}
                      value={newFacet.max}
                      onChange={(e) => setNewFacet({ ...newFacet, max: e.target.value })}
                    />
                    <FieldError id="new-facet-max-error" issue={newFacetIssues.max} />
                  </label>
                </div>
              )}

              <div className="row">
                <button className="primary" onClick={submitNewFacet}>
                  {t('settings.form_editor.add_facet_confirm')}
                </button>
                <button
                  onClick={() => {
                    setNewFacet(null)
                    setNewFacetIssues({})
                  }}
                >
                  {t('settings.form_editor.add_facet_cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setNewFacet(EMPTY_NEW_FACET)}>{t('settings.form_editor.add_facet')}</button>
          )}

          {confirmReset ? (
            <div className="banner warning">
              <span>{t('settings.form_editor.reset_confirm_text')}</span>
              <button className="primary" disabled={busy} onClick={onResetConfirmed}>
                {t('settings.form_editor.confirm')}
              </button>
              <button onClick={() => setConfirmReset(false)}>{t('settings.form_editor.cancel')}</button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)}>{t('settings.form_editor.reset')}</button>
          )}

          {impact && impactDraft === editor.draft && (
            <div className="banner">
              <span>{impact.staleCount > 0 ? t('settings.form_editor.impact_stale', { count: impact.staleCount }) : t('settings.form_editor.impact_none')}</span>
              {impact.removedValuesInUse.map((r) => (
                <span key={`${r.facet}-${r.value}`}>{t('settings.form_editor.impact_value_in_use', { value: r.value, facet: r.facet, papers: r.papers })}</span>
              ))}
              <button className="primary" disabled={busy} onClick={confirmSave}>
                {t('settings.form_editor.confirm')}
              </button>
              <button
                onClick={() => {
                  setImpact(null)
                  setImpactDraft(null)
                }}
              >
                {t('settings.form_editor.cancel')}
              </button>
            </div>
          )}

          <div className="row">
            <button className="primary" disabled={!dirty || busy} onClick={onSave}>
              {t('settings.form_editor.save')}
            </button>
            <button disabled={!dirty || busy} onClick={onDiscardChanges}>
              {t('settings.form_editor.discard')}
            </button>
            <button onClick={() => void window.research.llm.showProjectFile()}>{t('settings.form_show_file')}</button>
          </div>
        </>
      )}
    </section>
  )
}
