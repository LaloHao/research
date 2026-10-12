import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FacetSuggestion, FacetSuggestionList, FacetSuggestionView, FacetSuggestPlan, SuggestionEdit, SuggestionExample } from '../../../shared/facetSuggestions'
import type { FacetDecisionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import { FACET_TYPES, type ExtractionForm, type FacetDef, type SummaryPlan } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { canAccept, editFor, editIssues, facetChoices, groupSuggestions, retypeFacet, splitValues } from '../../lib/facetSuggestions'
import type { DraftIssue } from '../../lib/formDraft'
import { parseInteger } from '../../lib/numberField'
import { UNDO_MS } from '../../lib/typedRelations'
import { EvidencePanel } from '../review/EvidencePanel'
import { formatDate } from '../summary/FieldCard'

type Notice = { error: boolean; text: string }
type Done = 'accepted' | 'rejected' | 'restored'

/** «Sugerencias de Claude» in Settings → Formulario: run, review, accept (or edit and accept), reject, undo, fill. */
export function FacetSuggestionsSection({ form, formDirty }: { form: ExtractionForm; formDirty: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<FacetSuggestionList | null>(null)
  const [plan, setPlan] = useState<FacetSuggestPlan | null>(null)
  const [fillOffer, setFillOffer] = useState<SummaryPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editing, setEditing] = useState<{ id: string; edit: SuggestionEdit } | null>(null)
  const [undo, setUndo] = useState<{ token: string; text: string } | null>(null)
  const [evidence, setEvidence] = useState<{ example: SuggestionExample; detail: PaperDetail } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRequest = useRef(0)
  const evidenceRequest = useRef(0)
  const fillRequest = useRef(0)

  const load = useCallback(() => {
    const token = ++listRequest.current
    window.research.facets.list().then(
      (next) => {
        if (token === listRequest.current) setList(next)
      },
      () => {
        if (token === listRequest.current) setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }, [t])
  useEffect(load, [load])
  useEvent('facets-changed', load)
  useEvent('jobs-changed', load)
  useEvent('project-changed', load)
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    []
  )

  const fail = (code: string): void => setNotice({ error: true, text: errorText(t, code) })

  const clearUndo = (): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    setUndo(null)
  }

  const showUndo = (token: string, text: string): void => {
    clearUndo()
    setUndo({ token, text })
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null
      setUndo(null)
    }, UNDO_MS)
  }

  const dropFillOffer = (): void => {
    fillRequest.current++
    setFillOffer(null)
  }

  const openPlan = (): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    window.research.facets.plan().then(
      (next) => {
        setBusy(false)
        setPlan(next)
      },
      () => {
        setBusy(false)
        fail('unknown')
      }
    )
  }

  const runSuggest = (): void => {
    if (busy) return
    setBusy(true)
    window.research.facets.suggest().then(
      (r) => {
        setBusy(false)
        setPlan(null)
        if (r.ok) setNotice({ error: false, text: t('facets.queued') })
        else fail(r.error)
      },
      () => {
        setBusy(false)
        fail('unknown')
      }
    )
  }

  /** After a new facet is accepted: how many papers it can be filled in, and at what cost («Llenar en N papers»). */
  const offerFill = (): void => {
    const token = ++fillRequest.current
    window.research.facets.fillPlan().then(
      (next) => {
        if (token === fillRequest.current) setFillOffer(next.count > 0 ? next : null)
      },
      () => {
        if (token === fillRequest.current) fail('unknown')
      }
    )
  }

  const decide = (action: () => Promise<FacetDecisionResult>, done: Done, accepted?: FacetSuggestion): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    dropFillOffer()
    action().then(
      (r) => {
        setBusy(false)
        if (!r.ok) {
          fail(r.error)
          return
        }
        setEditing(null)
        showUndo(r.undoToken, t(`facets.done.${done}`))
        if (accepted?.kind === 'new_facet') offerFill()
      },
      () => {
        setBusy(false)
        fail('unknown')
      }
    )
  }

  const revert = (): void => {
    if (!undo || busy) return
    const { token } = undo
    setBusy(true)
    setNotice(null)
    window.research.facets.revert(token).then(
      (r) => {
        setBusy(false)
        clearUndo() // the token is spent either way
        dropFillOffer()
        if (!r.ok) fail(r.error)
      },
      () => {
        setBusy(false)
        fail('unknown')
      }
    )
  }

  const runFill = (): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    window.research.facets.fill().then(
      (r) => {
        setBusy(false)
        dropFillOffer()
        if (r.ok) setNotice({ error: false, text: t('facets.fill_queued', { count: r.count }) })
        else fail(r.error)
      },
      () => {
        setBusy(false)
        fail('unknown')
      }
    )
  }

  const openExample = (example: SuggestionExample): void => {
    const token = ++evidenceRequest.current
    window.research.library.detail(example.paper).then(
      (detail) => {
        if (token === evidenceRequest.current) setEvidence({ example, detail })
      },
      () => {
        if (token === evidenceRequest.current) fail('unknown')
      }
    )
  }

  const closeExample = (): void => {
    evidenceRequest.current++
    setEvidence(null)
  }

  const groups = groupSuggestions(list)
  return (
    <section className="facet-suggestions">
      <header className="row">
        <h3>{t('facets.title')}</h3>
        {list && list.pending > 0 && <span className="badge badge-to_review">{t('facets.pending', { count: list.pending })}</span>}
        <button className="primary" disabled={busy || !list || list.running || list.file.status === 'conflict' || list.file.status === 'invalid'} onClick={openPlan}>
          {t('facets.suggest')}
        </button>
      </header>
      <p className="muted small">{t('facets.intro')}</p>
      {list?.running && <div className="banner">{t('facets.running')}</div>}
      {list?.lastRun && <p className="muted small">{t(list.lastRun.ok ? 'facets.last_run' : 'facets.last_run_failed', { date: formatDate(list.lastRun.at) })}</p>}
      {list?.file.status === 'conflict' && <div className="banner error">{t('facets.file.conflict')}</div>}
      {list?.file.status === 'invalid' && <div className="banner error">{t('facets.file.invalid', { message: list.file.message })}</div>}
      {plan && (
        <div className="banner">
          <span>{t('facets.confirm', { count: plan.papers, cost: plan.estimateUsd.toFixed(2), cap: plan.capUsd.toFixed(2) })}</span>
          <button className="primary" disabled={busy} onClick={runSuggest}>
            {t('library.confirm')}
          </button>
          <button disabled={busy} onClick={() => setPlan(null)}>
            {t('jobs.cancel')}
          </button>
        </div>
      )}
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {undo && (
        <div className="banner">
          <span>{undo.text}</span>
          <button disabled={busy} onClick={revert}>
            {t('facets.undo')}
          </button>
        </div>
      )}
      {fillOffer && (
        <div className="banner">
          <span>{t('facets.fill_offer', { count: fillOffer.count, cost: fillOffer.estimateUsd.toFixed(2), limit: fillOffer.batchLimitUsd.toFixed(2) })}</span>
          <button className="primary" disabled={busy} onClick={runFill}>
            {t('facets.fill', { count: fillOffer.count })}
          </button>
          <button disabled={busy} onClick={dropFillOffer}>
            {t('facets.later')}
          </button>
        </div>
      )}
      {formDirty && groups.pending.length > 0 && <div className="banner warning">{t('facets.form_dirty')}</div>}
      {list && groups.pending.length === 0 && <p className="muted">{t('facets.none')}</p>}
      {groups.pending.map((view) => {
        const id = view.suggestion.id
        return (
          <SuggestionCard
            key={id}
            view={view}
            form={form}
            acceptable={canAccept(view, formDirty)}
            busy={busy}
            edit={editing?.id === id ? editing.edit : null}
            onEdit={(edit) => setEditing(edit ? { id, edit } : null)}
            onAccept={(edit) => decide(() => window.research.facets.accept(id, edit), 'accepted', view.suggestion)}
            onReject={() => decide(() => window.research.facets.reject(id), 'rejected')}
            onExample={openExample}
          />
        )
      })}
      {evidence && (
        <div className="facet-evidence">
          <div className="row">
            <strong>{evidence.detail.paper?.title ?? evidence.example.paper}</strong>
            <button onClick={closeExample}>{t('facets.close_quote')}</button>
          </div>
          <div className="facet-evidence-body">
            <EvidencePanel detail={evidence.detail} evidence={{ page: evidence.example.page, quote: evidence.example.quote }} />
          </div>
        </div>
      )}
      {groups.rejected.length > 0 && (
        <details className="facet-folded">
          <summary>{t('facets.rejected_title', { count: groups.rejected.length })}</summary>
          {groups.rejected.map((view) => (
            <div className="row small" key={view.suggestion.id}>
              <span className="chip">{t(`facets.kinds.${view.suggestion.kind}`)}</span>
              <ProposalLine suggestion={view.suggestion} />
              <button disabled={busy} onClick={() => decide(() => window.research.facets.restore(view.suggestion.id), 'restored')}>
                {t('facets.restore')}
              </button>
            </div>
          ))}
        </details>
      )}
      {groups.accepted.length > 0 && (
        <details className="facet-folded">
          <summary>{t('facets.accepted_title', { count: groups.accepted.length })}</summary>
          {groups.accepted.map((view) => (
            <div className="row small" key={view.suggestion.id}>
              <span className="chip">{t(`facets.kinds.${view.suggestion.kind}`)}</span>
              <ProposalLine suggestion={view.suggestion} />
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

function ProposalLine({ suggestion: s }: { suggestion: FacetSuggestion }): React.JSX.Element {
  const { t } = useTranslation()
  switch (s.kind) {
    case 'new_facet': {
      const choices = facetChoices(s.facet)
      return (
        <span>
          <code>{s.facet.key}</code> · {t(`settings.form_editor.types.${s.facet.type}`)}
          {choices && <span className="muted"> · {choices}</span>}
        </span>
      )
    }
    case 'new_value':
      return <span>{t('facets.proposal.new_value', { value: s.value, facet: s.facet })}</span>
    case 'alias':
      return <span>{t('facets.proposal.alias', { from: s.from.join(', '), to: s.to, facet: s.facet })}</span>
  }
}

function Issue({ issue }: { issue: DraftIssue | undefined }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!issue) return null
  return (
    <small className="field-error" role="alert">
      {t(`settings.form_editor.issues.${issue}`)}
    </small>
  )
}

interface SuggestionCardProps {
  view: FacetSuggestionView
  form: ExtractionForm
  acceptable: boolean
  busy: boolean
  edit: SuggestionEdit | null
  onEdit: (edit: SuggestionEdit | null) => void
  onAccept: (edit: SuggestionEdit | undefined) => void
  onReject: () => void
  onExample: (example: SuggestionExample) => void
}

function SuggestionCard({ view, form, acceptable, busy, edit, onEdit, onAccept, onReject, onExample }: SuggestionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const s = view.suggestion
  const issues = edit ? editIssues(edit, s, form) : {}
  return (
    <article className="card facet-suggestion">
      <h4 className="row">
        <span className="chip">{t(`facets.kinds.${s.kind}`)}</span>
        <ProposalLine suggestion={s} />
      </h4>
      {s.kind === 'new_facet' && <p className="muted small">{s.facet.description}</p>}
      <p>
        <strong>{t('facets.rationale')}:</strong> {s.rationale}
      </p>
      {s.examples.length > 0 && (
        <div>
          <h5>{t('facets.examples')}</h5>
          <ul className="evidence">
            {s.examples.map((e, i) => (
              <li key={i} className={e.found ? undefined : 'not-found'}>
                <code>{e.paper}</code>
                {e.value ? <> → {e.value}</> : null}{' '}
                <button className="link" onClick={() => onExample(e)}>
                  {t('facets.example_quote', { quote: e.quote })}
                  {e.page !== null ? ` · ${t('facets.example_page', { page: e.page })}` : ''}
                </button>
                {!e.found && <span className="chip chip-evidence_missing">{t('facets.quote_not_found')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.validity !== 'ok' && <div className="banner warning">{t(`facets.invalid.${view.validity}`)}</div>}
      {edit && <SuggestionEditor edit={edit} issues={issues} onChange={onEdit} />}
      <div className="row">
        {edit ? (
          <>
            <button className="primary" disabled={!acceptable || busy || Object.keys(issues).length > 0} onClick={() => onAccept(edit)}>
              {t('facets.save_accept')}
            </button>
            <button disabled={busy} onClick={() => onEdit(null)}>
              {t('facets.cancel')}
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!acceptable || busy} onClick={() => onAccept(undefined)}>
              {t('facets.accept')}
            </button>
            <button disabled={!acceptable || busy} onClick={() => onEdit(editFor(s))}>
              {t('facets.edit_accept')}
            </button>
          </>
        )}
        <button disabled={busy} onClick={onReject}>
          {t('facets.reject')}
        </button>
      </div>
    </article>
  )
}

function SuggestionEditor({ edit, issues, onChange }: { edit: SuggestionEdit; issues: Record<string, DraftIssue>; onChange: (edit: SuggestionEdit) => void }): React.JSX.Element {
  const { t } = useTranslation()
  switch (edit.kind) {
    case 'new_value':
      return (
        <label className="field">
          <span>{t('facets.value_label')}</span>
          <input value={edit.value} onChange={(e) => onChange({ kind: 'new_value', value: e.target.value })} />
          <small className="muted">{t('settings.form_editor.snake_case_hint')}</small>
          <Issue issue={issues.value} />
        </label>
      )
    case 'alias':
      return (
        <label className="field">
          <span>{t('facets.to_label')}</span>
          <input value={edit.to} onChange={(e) => onChange({ kind: 'alias', to: e.target.value })} />
          <small className="muted">{t('settings.form_editor.snake_case_hint')}</small>
          <Issue issue={issues.to} />
        </label>
      )
    case 'new_facet':
      return <FacetEditor facet={edit.facet} issues={issues} onChange={(facet) => onChange({ kind: 'new_facet', facet })} />
  }
}

/** A new facet being edited; the values and the range are typed as text so a half-typed value is never read as empty. */
function FacetEditor({ facet, issues, onChange }: { facet: FacetDef; issues: Record<string, DraftIssue>; onChange: (facet: FacetDef) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [valuesText, setValuesText] = useState('values' in facet ? facet.values.join(', ') : '')
  const [range, setRange] = useState({ min: facet.type === 'scale' ? String(facet.min) : '1', max: facet.type === 'scale' ? String(facet.max) : '5' })

  const setBound = (field: 'min' | 'max', text: string): void => {
    setRange((r) => ({ ...r, [field]: text }))
    if (facet.type !== 'scale') return
    const parsed = parseInteger(text)
    // An unparsable bound is kept as NaN, so the form editor's rules report it and «Guardar y aceptar» stays off.
    const value = parsed.ok ? parsed.value : Number.NaN
    onChange(field === 'min' ? { ...facet, min: value } : { ...facet, max: value })
  }

  const retype = (type: FacetDef['type']): void => {
    const next = retypeFacet(facet, type)
    if (next.type === 'scale') setRange({ min: String(next.min), max: String(next.max) })
    onChange('values' in next ? { ...next, values: splitValues(valuesText) } : next)
  }

  return (
    <div className="editor">
      <label className="field">
        <span>{t('settings.form_editor.key_label')}</span>
        <input value={facet.key} onChange={(e) => onChange({ ...facet, key: e.target.value })} />
        <small className="muted">{t('settings.form_editor.snake_case_hint')}</small>
        <Issue issue={issues.key} />
      </label>
      <label className="field">
        <span>{t('settings.form_editor.type_label')}</span>
        <select value={facet.type} onChange={(e) => retype(e.target.value as FacetDef['type'])}>
          {FACET_TYPES.map((ft) => (
            <option key={ft} value={ft}>
              {t(`settings.form_editor.types.${ft}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('settings.form_editor.description_label')}</span>
        <textarea value={facet.description} onChange={(e) => onChange({ ...facet, description: e.target.value })} />
        <Issue issue={issues.description} />
      </label>
      {'values' in facet && (
        <label className="field">
          <span>{t('facets.values_label')}</span>
          <input
            value={valuesText}
            onChange={(e) => {
              setValuesText(e.target.value)
              onChange({ ...facet, values: splitValues(e.target.value) })
            }}
          />
          <small className="muted">{t('settings.form_editor.snake_case_hint')}</small>
          <Issue issue={issues.values} />
        </label>
      )}
      {facet.type === 'scale' && (
        <div className="row">
          <label className="field">
            <span>{t('settings.form_editor.min_label')}</span>
            <input type="text" inputMode="numeric" value={range.min} onChange={(e) => setBound('min', e.target.value)} />
            <Issue issue={issues.min} />
          </label>
          <label className="field">
            <span>{t('settings.form_editor.max_label')}</span>
            <input type="text" inputMode="numeric" value={range.max} onChange={(e) => setBound('max', e.target.value)} />
            <Issue issue={issues.max} />
          </label>
        </div>
      )}
    </div>
  )
}
