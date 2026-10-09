import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FACET_TYPES, type ExtractionForm, type FacetDef, type FormImpact, type FormInfo } from '../../../shared/summary'
import {
  addFacet,
  addValue,
  isDirty,
  removeAlias,
  removeFacet,
  removeValue,
  updateFacet,
  validateDraft,
  validateNewValue,
  type DraftIssue
} from '../../lib/formDraft'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

type FacetType = (typeof FACET_TYPES)[number]

interface Editor {
  saved: ExtractionForm
  draft: ExtractionForm
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

function FieldError({ id, issue }: { id: string; issue: DraftIssue | undefined }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!issue) return null
  return (
    <small id={id} className="field-error" role="alert">
      {t(`settings.form_editor.issues.${issue}`)}
    </small>
  )
}

export function ExtractionFormView(): React.JSX.Element {
  const { t } = useTranslation()
  const [formInfo, setFormInfo] = useState<FormInfo | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [outdated, setOutdated] = useState(false)
  const [issues, setIssues] = useState<Record<string, DraftIssue>>({})
  const [impact, setImpact] = useState<FormImpact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [newFacet, setNewFacet] = useState<NewFacetDraft | null>(null)
  const [newFacetIssues, setNewFacetIssues] = useState<Record<string, DraftIssue>>({})
  const [newValueText, setNewValueText] = useState<Record<string, string>>({})
  const [newValueIssue, setNewValueIssue] = useState<Record<string, DraftIssue>>({})

  const editorRef = useRef<Editor | null>(null)
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  const load = useCallback(() => {
    window.research.llm.info().then((info) => {
      setFormInfo(info.form)
      if (info.form.status !== 'ok') {
        setEditor(null)
        setOutdated(false)
        return
      }
      const nextSaved = info.form.form
      const current = editorRef.current
      if (current && isDirty(current.saved, current.draft)) {
        if (isDirty(current.saved, nextSaved)) setOutdated(true)
        return
      }
      setEditor({ saved: nextSaved, draft: nextSaved })
      setOutdated(false)
    }, () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const mutate = (fn: (draft: ExtractionForm) => ExtractionForm): void => {
    setEditor((current) => (current ? { ...current, draft: fn(current.draft) } : current))
    setImpact(null)
  }

  const discardAndReload = (): void => {
    setOutdated(false)
    editorRef.current = null
    setEditor(null)
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
    setEditor({ saved: editor.saved, draft: editor.saved })
    setIssues({})
    setImpact(null)
    setNewFacet(null)
    setNewFacetIssues({})
  }

  const onSave = (): void => {
    if (!editor) return
    const problems = validateDraft(editor.draft)
    setIssues(problems)
    if (Object.keys(problems).length) return
    setError(null)
    window.research.llm.formImpact(editor.draft).then(setImpact, () => setError(errorText(t, 'unknown')))
  }

  const confirmSave = (): void => {
    if (!editor) return
    window.research.llm.updateForm(editor.draft).then(
      (result) => {
        if (result.ok) {
          setImpact(null)
          setIssues({})
          setEditor({ saved: editor.draft, draft: editor.draft })
        } else setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const onResetConfirmed = (): void => {
    setConfirmReset(false)
    setError(null)
    window.research.llm.resetForm().then(
      (result) => {
        if (result.ok) {
          editorRef.current = null
          setEditor(null)
          load()
        } else setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const addValueClick = (facetKey: string, existing: string[]): void => {
    const text = (newValueText[facetKey] ?? '').trim()
    const problem = validateNewValue(existing, text)
    if (problem) {
      setNewValueIssue((c) => ({ ...c, [facetKey]: problem }))
      return
    }
    mutate((d) => addValue(d, facetKey, text))
    setNewValueText((c) => ({ ...c, [facetKey]: '' }))
    setNewValueIssue((c) => {
      const { [facetKey]: _removed, ...rest } = c
      return rest
    })
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

    const candidateDraft = addFacet(editor.draft, candidate)
    const index = editor.draft.facets.length
    const problems = validateDraft(candidateDraft)
    const prefix = `facets.${index}.`
    const relevant: Record<string, DraftIssue> = {}
    for (const [path, issue] of Object.entries(problems)) {
      if (path.startsWith(prefix)) relevant[path.slice(prefix.length)] = issue
    }
    if (Object.keys(relevant).length) {
      setNewFacetIssues(relevant)
      return
    }
    setEditor({ ...editor, draft: candidateDraft })
    setNewFacet(null)
    setNewFacetIssues({})
  }

  if (!formInfo) return <section className="extraction-form" />

  const savedKeys = new Set(editor?.saved.facets.map((f) => f.key) ?? [])
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

          {editor.draft.facets.map((facet, i) => {
            const isNew = !savedKeys.has(facet.key)
            const keyErrorId = `facet-${i}-key-error`
            const descErrorId = `facet-${i}-description-error`
            const valuesErrorId = `facet-${i}-values-error`
            const newValueErrorId = `newvalue-${i}-error`
            return (
              <div className="card" key={`${facet.key}-${i}`}>
                <div className="row">
                  {isNew ? (
                    <input
                      aria-invalid={issues[`facets.${i}.key`] ? true : undefined}
                      aria-describedby={issues[`facets.${i}.key`] ? keyErrorId : undefined}
                      className={issues[`facets.${i}.key`] ? 'invalid' : undefined}
                      value={facet.key}
                      onChange={(e) => mutate((d) => updateFacet(d, facet.key, { key: e.target.value } as Partial<FacetDef>))}
                    />
                  ) : (
                    <strong>{facet.key}</strong>
                  )}
                  <span className="chip">{t(`settings.form_editor.types.${facet.type}`)}</span>
                </div>
                <FieldError id={keyErrorId} issue={issues[`facets.${i}.key`]} />
                {isNew && <small className="muted">{t('settings.form_editor.key_hint')}</small>}

                <label className="field">
                  <span>{t('settings.form_editor.description_label')}</span>
                  <textarea
                    aria-invalid={issues[`facets.${i}.description`] ? true : undefined}
                    aria-describedby={issues[`facets.${i}.description`] ? descErrorId : undefined}
                    className={issues[`facets.${i}.description`] ? 'invalid' : undefined}
                    value={facet.description}
                    onChange={(e) => mutate((d) => updateFacet(d, facet.key, { description: e.target.value }))}
                  />
                </label>
                <FieldError id={descErrorId} issue={issues[`facets.${i}.description`]} />

                {(facet.type === 'single' || facet.type === 'multi') && (
                  <div className="field">
                    <span>{t('settings.form_editor.values_label')}</span>
                    <div className="chip-list">
                      {facet.values.map((v) => (
                        <span className="chip" key={v}>
                          {v}{' '}
                          <button type="button" className="chip-remove" aria-label={t('settings.form_editor.remove_value')} onClick={() => mutate((d) => removeValue(d, facet.key, v))}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <FieldError id={valuesErrorId} issue={issues[`facets.${i}.values`]} />
                    <div className="row small">
                      <input
                        aria-invalid={newValueIssue[facet.key] ? true : undefined}
                        aria-describedby={newValueIssue[facet.key] ? newValueErrorId : undefined}
                        className={newValueIssue[facet.key] ? 'invalid' : undefined}
                        placeholder={t('settings.form_editor.add_value_placeholder')}
                        value={newValueText[facet.key] ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setNewValueText((c) => ({ ...c, [facet.key]: value }))
                          setNewValueIssue((c) => {
                            const { [facet.key]: _removed, ...rest } = c
                            return rest
                          })
                        }}
                      />
                      <button type="button" onClick={() => addValueClick(facet.key, facet.values)}>
                        {t('settings.form_editor.add_value')}
                      </button>
                    </div>
                    <FieldError id={newValueErrorId} issue={newValueIssue[facet.key]} />
                    <small className="muted">{t('settings.form_editor.value_hint')}</small>
                  </div>
                )}

                {facet.type === 'scale' && (
                  <div className="row">
                    <label className="field">
                      <span>{t('settings.form_editor.min_label')}</span>
                      <input
                        type="number"
                        aria-invalid={issues[`facets.${i}.min`] ? true : undefined}
                        className={issues[`facets.${i}.min`] ? 'invalid' : undefined}
                        value={facet.min}
                        onChange={(e) => mutate((d) => updateFacet(d, facet.key, { min: Number(e.target.value) }))}
                      />
                      <FieldError id={`facet-${i}-min-error`} issue={issues[`facets.${i}.min`]} />
                    </label>
                    <label className="field">
                      <span>{t('settings.form_editor.max_label')}</span>
                      <input
                        type="number"
                        aria-invalid={issues[`facets.${i}.max`] ? true : undefined}
                        className={issues[`facets.${i}.max`] ? 'invalid' : undefined}
                        value={facet.max}
                        onChange={(e) => mutate((d) => updateFacet(d, facet.key, { max: Number(e.target.value) }))}
                      />
                      <FieldError id={`facet-${i}-max-error`} issue={issues[`facets.${i}.max`]} />
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
                          <button type="button" className="chip-remove" aria-label={t('settings.form_editor.remove_alias')} onClick={() => mutate((d) => removeAlias(d, facet.key, from))}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {confirmRemove === facet.key ? (
                  <div className="banner warning">
                    <span>{t('settings.form_editor.remove_facet_confirm_text')}</span>
                    <button
                      className="primary"
                      onClick={() => {
                        mutate((d) => removeFacet(d, facet.key))
                        setConfirmRemove(null)
                      }}
                    >
                      {t('settings.form_editor.confirm')}
                    </button>
                    <button onClick={() => setConfirmRemove(null)}>{t('settings.form_editor.cancel')}</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(facet.key)}>{t('settings.form_editor.remove_facet')}</button>
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
                  className={newFacetIssues.key ? 'invalid' : undefined}
                  value={newFacet.key}
                  onChange={(e) => setNewFacet({ ...newFacet, key: e.target.value })}
                />
                <FieldError id="new-facet-key-error" issue={newFacetIssues.key} />
                <small className="muted">{t('settings.form_editor.key_hint')}</small>
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
                  <small className="muted">{t('settings.form_editor.value_hint')}</small>
                </div>
              )}

              {newFacet.type === 'scale' && (
                <div className="row">
                  <label className="field">
                    <span>{t('settings.form_editor.min_label')}</span>
                    <input
                      type="number"
                      aria-invalid={newFacetIssues.min ? true : undefined}
                      className={newFacetIssues.min ? 'invalid' : undefined}
                      value={newFacet.min}
                      onChange={(e) => setNewFacet({ ...newFacet, min: e.target.value })}
                    />
                    <FieldError id="new-facet-min-error" issue={newFacetIssues.min} />
                  </label>
                  <label className="field">
                    <span>{t('settings.form_editor.max_label')}</span>
                    <input
                      type="number"
                      aria-invalid={newFacetIssues.max ? true : undefined}
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
              <button className="primary" onClick={onResetConfirmed}>
                {t('settings.form_editor.confirm')}
              </button>
              <button onClick={() => setConfirmReset(false)}>{t('settings.form_editor.cancel')}</button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)}>{t('settings.form_editor.reset')}</button>
          )}

          {impact && (
            <div className="banner">
              <span>{impact.staleCount > 0 ? t('settings.form_editor.impact_stale', { count: impact.staleCount }) : t('settings.form_editor.impact_none')}</span>
              {impact.removedValuesInUse.map((r) => (
                <span key={`${r.facet}-${r.value}`}>{t('settings.form_editor.impact_value_in_use', { value: r.value, facet: r.facet, papers: r.papers })}</span>
              ))}
              <button className="primary" onClick={confirmSave}>
                {t('settings.form_editor.confirm')}
              </button>
              <button onClick={() => setImpact(null)}>{t('settings.form_editor.cancel')}</button>
            </div>
          )}

          <div className="row">
            <button className="primary" disabled={!dirty} onClick={onSave}>
              {t('settings.form_editor.save')}
            </button>
            <button disabled={!dirty} onClick={onDiscardChanges}>
              {t('settings.form_editor.discard')}
            </button>
            <button onClick={() => void window.research.llm.showProjectFile()}>{t('settings.form_show_file')}</button>
          </div>
        </>
      )}
    </section>
  )
}
