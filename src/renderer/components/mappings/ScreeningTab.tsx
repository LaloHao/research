import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PHASES,
  type IngestPlan,
  type MappingRecordRow,
  type MappingView,
  type Phase,
  type QueueFilter,
  type ScreeningPlan,
  type UserDecision
} from '../../../shared/mapping'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { approxUsd, criterionLabel, filtersFor, highlight, keepPosition, phaseLabel, planLines, screeningCommand, type ScreeningCommand } from '../../lib/mappings'
import { trapTab } from '../../lib/focusTrap'
import { UNDO_MS } from '../../lib/typedRelations'
import { PaperDetail } from '../paper/PaperDetail'

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const ARROWS = new Set(['ArrowLeft', 'ArrowRight'])

/** The ingest confirmation: the plan main made for what was asked (one record, or all: `scope` undefined). */
type IngestConfirm = { plan: IngestPlan; scope?: string[] }

function Abstract({ text, quote }: { text: string | null; quote: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (!text) return <p className="muted">{t('mappings.screening.no_abstract')}</p>
  const h = highlight(text, quote)
  return (
    <p className="screening-abstract">
      {h ? (
        <>
          {h.before}
          <mark>{h.match}</mark>
          {h.after}
        </>
      ) : (
        text
      )}
    </p>
  )
}

/**
 * Whether a key press belongs to the screening queue: the tab is shown, no dialog is open, the focus is not in a
 * field, and it is in the screening panel (outside the embedded paper), on the «Cribado» tab itself, or nowhere.
 */
function ownsKey(root: HTMLElement | null, e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false
  if (!root || root.getClientRects().length === 0) return false
  if (document.querySelector('[aria-modal="true"]')) return false
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return true
  if (EDITABLE.has(active.tagName) || active.isContentEditable) return false
  const onTab = active.id === 'mapping-tab-screening'
  if (!onTab && (!root.contains(active) || active.closest('.screening-paper'))) return false
  // The arrows move between the mapping's tabs while a tab has the focus.
  return !(ARROWS.has(e.key) && active.closest('[role="tablist"]'))
}

/** «Cribado»: one record at a time, in two phases, with Claude's suggestions beside it and the decision always the user's. */
export function ScreeningTab({ view }: { view: MappingView }): React.JSX.Element {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('title_abstract')
  const [filter, setFilter] = useState<QueueFilter>('pending')
  const [rows, setRows] = useState<MappingRecordRow[] | null>(null)
  const [index, setIndex] = useState(0)
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const [plan, setPlan] = useState<ScreeningPlan | null>(null)
  const [ingest, setIngest] = useState<IngestConfirm | null>(null)
  const [ingestCount, setIngestCount] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const ingestRequest = useRef(0)
  /** The open confirmation's refresh; bumped when it closes or its button is pressed, so a late answer is ignored. */
  const planRequest = useRef(0)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const place = useRef<{ ids: string[]; index: number }>({ ids: [], index: 0 })
  place.current = { ids: rows?.map((r) => r.id) ?? [], index }

  const load = useCallback(
    (keep: boolean) => {
      const token = ++request.current
      // A new phase or filter never shows the previous list's record meanwhile.
      if (!keep) setRows(null)
      window.research.mappings.queue(view.id, { phase, filter }).then(
        (next) => {
          if (token !== request.current) return
          // The place as displayed now: a move made while the request was in flight is kept.
          const shown = place.current
          setRows(next)
          setIndex(keep ? keepPosition(shown.ids, shown.index, next.map((r) => r.id)) : 0)
        },
        () => {
          if (token === request.current) setError(errorText(t, 'unknown'))
        }
      )
    },
    [view.id, phase, filter, t]
  )
  useEffect(() => {
    setChoosing(false)
    load(false)
  }, [load])
  useEvent('mappings-changed', () => load(true))

  const loadIngest = useCallback(() => {
    const token = ++ingestRequest.current
    if (phase !== 'full_text') return
    window.research.mappings.ingestPlan(view.id).then(
      (p) => {
        if (token === ingestRequest.current) setIngestCount(p.count)
      },
      () => {
        if (token === ingestRequest.current) setIngestCount(0)
      }
    )
  }, [view.id, phase])
  useEffect(loadIngest, [loadIngest])
  useEvent('mappings-changed', loadIngest)

  const closePlan = (): void => {
    planRequest.current++
    setPlan(null)
  }
  const closeIngest = (): void => {
    planRequest.current++
    setIngest(null)
  }
  /**
   * An open confirmation follows the mapping (a search, an import or a sync may add records meanwhile): its figures and
   * the ids «Sugerir» or «Agregar» send are always the ones on screen, and it closes when nothing is left.
   */
  const refreshConfirmation = (): void => {
    if (busy || (!plan && !ingest)) return
    const token = ++planRequest.current
    const stale = (): boolean => token !== planRequest.current
    const failed = (): void => {
      if (stale()) return
      setPlan(null)
      setIngest(null)
      setError(errorText(t, 'unknown'))
    }
    if (plan) {
      window.research.mappings.suggestPlan(view.id, plan.phase).then((p) => {
        if (stale()) return
        if (p.count > 0) return setPlan(p)
        setPlan(null)
        setNotice(t('mappings.screening.suggest_none'))
      }, failed)
    } else if (ingest) {
      const scope = ingest.scope
      window.research.mappings.ingestPlan(view.id, scope).then((p) => {
        if (stale()) return
        if (p.count > 0) return setIngest({ plan: p, scope })
        setIngest(null)
        setNotice(t('mappings.screening.ingest_none'))
      }, failed)
    }
  }
  useEvent('mappings-changed', refreshConfirmation)
  // A paper trashed, restored or added in the library changes what full text can add, suggest and show.
  useEvent('library-changed', () => {
    if (phase !== 'full_text') return
    loadIngest()
    load(true)
    refreshConfirmation()
  })

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    []
  )

  const row = rows?.[index] ?? null
  const exclusions = view.protocol.protocol.exclusion
  const suggestion = row?.suggestions[phase] ?? null
  const conflicts = view.conflicts.filter((c) => c.phase === phase)
  const current = row ? row[phase] : null
  const rowId = row?.id ?? null
  // The criteria list belongs to the record E was pressed on: another record on screen closes it.
  useEffect(() => setChoosing(false), [rowId])
  // decide and resolveConflict refuse these (not_eligible): the buttons are not offered.
  const blockedReason = !row
    ? null
    : !row.active
      ? 'mappings.screening.inactive'
      : row.duplicate
        ? 'mappings.screening.duplicate_pending'
        : current?.state === 'conflict'
          ? 'mappings.screening.conflict_pending'
          : null
  const canDecide = row !== null && blockedReason === null

  const fail = (code: string): void => {
    setBusy(false)
    setError(errorText(t, code))
  }

  const showUndo = (decisionId: string): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo(decisionId)
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null
      setUndo(null)
    }, UNDO_MS)
  }

  const clearUndo = (): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    setUndo(null)
  }

  /** The queue reloads on 'mappings-changed', keeping the place (a decided record leaves a «sin decidir» list). */
  const decide = (decision: UserDecision, criterion: string | null, suggestionId: string | null = null): void => {
    if (!row || !current || !canDecide || busy) return
    const before = current.decisionId
    setBusy(true)
    setError(null)
    setNotice(null)
    window.research.mappings.decide(view.id, { recordId: row.id, phase, decision, criterion, suggestionId }).then(
      (r) => {
        if (!r.ok) return fail(r.error)
        setBusy(false)
        setChoosing(false)
        // The same decision again writes nothing and answers with the current one: there is nothing to undo.
        if (r.decisionId === before) {
          clearUndo()
          setNotice(t('mappings.screening.unchanged'))
        } else showUndo(r.decisionId)
      },
      () => fail('unknown')
    )
  }

  const undoLast = (): void => {
    if (!undo || busy) return
    setBusy(true)
    setError(null)
    window.research.mappings.undo(view.id, undo).then(
      (r) => {
        if (!r.ok) return fail(r.error)
        setBusy(false)
        clearUndo()
      },
      () => fail('unknown')
    )
  }

  /** «Aceptar sugerencia»: exactly the suggestion's decision and criterion, naming the suggestion. */
  const accept = (): void => {
    if (suggestion) decide(suggestion.decision, suggestion.criterion, suggestion.id)
  }

  const move = (step: 1 | -1): void => {
    setChoosing(false)
    setIndex((i) => Math.min(Math.max(0, i + step), Math.max(0, (rows?.length ?? 1) - 1)))
  }

  const run = (cmd: ScreeningCommand): void => {
    switch (cmd.kind) {
      case 'include':
        return decide('include', null)
      case 'exclude':
        return decide('exclude', cmd.criterion)
      case 'choose_exclusion':
        return canDecide ? setChoosing(true) : undefined
      case 'close_list':
        return setChoosing(false)
      case 'uncertain':
        return decide('uncertain', null)
      case 'not_retrieved':
        return decide('not_retrieved', null)
      case 'accept':
        return accept()
      case 'undo':
        return undoLast()
      case 'next':
        return move(1)
      case 'prev':
        return move(-1)
    }
  }

  // Registered once: the handler reads the latest state through refs.
  const runRef = useRef(run)
  runRef.current = run
  const keyContext = useRef({ phase, choosing, exclusions: exclusions.map((c) => c.id) })
  keyContext.current = { phase, choosing, exclusions: exclusions.map((c) => c.id) }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!ownsKey(root.current, e)) return
      const cmd = screeningCommand(e.key, keyContext.current)
      if (!cmd) return
      e.preventDefault()
      runRef.current(cmd)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const switchPhase = (next: Phase): void => {
    setPhase(next)
    setNotice(null)
    if (!filtersFor(next).includes(filter)) setFilter('pending')
  }

  const openPlan = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    window.research.mappings.suggestPlan(view.id, phase).then(
      (p) => {
        setBusy(false)
        if (p.count === 0) setNotice(t('mappings.screening.suggest_none'))
        else setPlan(p)
      },
      () => fail('unknown')
    )
  }

  /** Runs only from the confirmation's «Sugerir». */
  const runSuggest = (): void => {
    if (!plan || busy) return
    setBusy(true)
    planRequest.current++
    window.research.mappings.suggest(view.id, plan.phase, plan.recordIds, true).then(
      (r) => {
        setPlan(null)
        if (!r.ok) return fail(r.error)
        setBusy(false)
        setNotice(t('mappings.screening.suggest_queued'))
      },
      () => {
        setPlan(null)
        fail('unknown')
      }
    )
  }

  const openIngest = (recordIds?: string[]): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    window.research.mappings.ingestPlan(view.id, recordIds).then(
      (p) => {
        setBusy(false)
        if (p.count === 0) setNotice(t('mappings.screening.ingest_none'))
        else setIngest({ plan: p, scope: recordIds })
      },
      () => fail('unknown')
    )
  }

  /** Runs only from the confirmation's «Agregar». */
  const runIngest = (): void => {
    if (!ingest || busy) return
    setBusy(true)
    planRequest.current++
    window.research.mappings.ingest(view.id, ingest.plan.recordIds, true).then(
      (r) => {
        setIngest(null)
        if (!r.ok) return fail(r.error)
        setBusy(false)
        setNotice(t('mappings.screening.ingest_queued', { count: r.count }))
      },
      () => {
        setIngest(null)
        fail('unknown')
      }
    )
  }

  const resolveDuplicate = (recordId: string, otherId: string, same: boolean): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.research.mappings.resolveDuplicate(view.id, recordId, otherId, same).then(
      (r) => (r.ok ? setBusy(false) : fail(r.error)),
      () => fail('unknown')
    )
  }

  /** «Quedarme con esta»: a decision replacing every head (no «Deshacer» for a conflict resolution). */
  const keep = (recordId: string, decisionId: string): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.research.mappings.resolveConflict(view.id, recordId, phase, decisionId).then(
      (r) => (r.ok ? setBusy(false) : fail(r.error)),
      () => fail('unknown')
    )
  }

  /** A confirmation's keys: Esc cancels, Tab stays inside. */
  const dialogKeys = (close: () => void) => (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else trapTab(e)
  }

  return (
    <div className="screening" ref={root} tabIndex={-1}>
      <div className="screening-toolbar row small">
        <div className="tabs" role="group" aria-label={t('mappings.tabs.screening')}>
          {PHASES.map((p) => (
            <button key={p} aria-pressed={phase === p} className={phase === p ? 'active' : ''} onClick={() => switchPhase(p)}>
              {t(`mappings.screening.phases.${p}`)}
            </button>
          ))}
        </div>
        <label>
          {t('mappings.screening.filter')}{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as QueueFilter)}>
            {filtersFor(phase).map((f) => (
              <option key={f} value={f}>
                {t(`mappings.screening.filters.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{t('mappings.screening.counts', { ...view.counts[phase] })}</span>
        <button disabled={busy} onClick={openPlan}>
          {t('mappings.screening.suggest')}
        </button>
        {phase === 'full_text' && ingestCount > 0 && (
          <button disabled={busy} onClick={() => openIngest()}>
            {t('mappings.screening.ingest', { count: ingestCount })}
          </button>
        )}
      </div>
      {notice && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {/* Outside the card: deciding the last record of a list empties it, and «Deshacer» must stay. */}
      {undo && (
        <div className="banner" role="status">
          <span>{t('mappings.screening.decided')}</span>
          <button className="small" disabled={busy} aria-keyshortcuts="U" onClick={undoLast}>
            {t('mappings.screening.undo')}
          </button>
        </div>
      )}

      {view.duplicates.length > 0 && (
        <details className="screening-panel" open>
          <summary>{t('mappings.screening.duplicates', { count: view.duplicates.length })}</summary>
          <p className="muted small">{t('mappings.screening.duplicate_wait')}</p>
          <ul className="plain-list">
            {view.duplicates.map((d) => (
              <li key={d.record.id} className="duplicate-pair">
                {[d.record, d.other].map((r) => (
                  <p key={r.id} className="small">
                    <strong>{r.title}</strong> <span className="muted">{[r.authors_label, r.year, r.venue, r.doi].filter(Boolean).join(' · ')}</span>
                  </p>
                ))}
                <p className="muted small">{t('mappings.screening.same_keeps', { title: d.other.title })}</p>
                <div className="row small">
                  <span className="muted">{t(`mappings.screening.duplicate_reasons.${d.reason}`)}</span>
                  <button disabled={busy} onClick={() => resolveDuplicate(d.record.id, d.other.id, true)}>
                    {t('mappings.screening.same')}
                  </button>
                  <button disabled={busy} onClick={() => resolveDuplicate(d.record.id, d.other.id, false)}>
                    {t('mappings.screening.distinct')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {conflicts.length > 0 && (
        <details className="screening-panel" open>
          <summary>{t('mappings.screening.conflicts', { count: conflicts.length })}</summary>
          {conflicts.map((c) => (
            <div key={c.record.id} className="conflict">
              <p className="small">
                <strong>{c.record.title}</strong>
              </p>
              <ul className="plain-list">
                {c.options.map((o) => (
                  <li key={o.decisionId} className="row small">
                    <span>
                      {t('mappings.screening.conflict_option', {
                        decision: phaseLabel(
                          t,
                          { state: o.decision === 'none' ? 'pending' : o.decision, criterion: o.criterion, protocolVersion: o.protocolVersion },
                          view.protocol
                        ),
                        machine: o.machine,
                        date: new Date(o.at).toLocaleString()
                      })}
                    </span>
                    <button disabled={busy} onClick={() => keep(c.record.id, o.decisionId)}>
                      {t('mappings.screening.keep')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}

      {!rows ? (
        <p className="muted">{t('app.loading')}</p>
      ) : !row || !current ? (
        <p className="muted">{t('mappings.screening.empty')}</p>
      ) : (
        <div className={`screening-view${phase === 'full_text' ? ' with-paper' : ''}`}>
          <div className="screening-card">
            <div className="row small">
              <button className="small" disabled={index === 0} onClick={() => move(-1)}>
                {t('mappings.screening.previous')}
              </button>
              <span className="muted">{t('mappings.screening.position', { position: index + 1, total: rows.length })}</span>
              <button className="small" disabled={index >= rows.length - 1} onClick={() => move(1)}>
                {t('mappings.screening.next')}
              </button>
            </div>
            <h3 className="screening-title">{row.title}</h3>
            <p className="muted small">{[row.authors, row.year, row.venue].filter(Boolean).join(' · ')}</p>
            {row.doi && <p className="small">{t('mappings.screening.doi', { doi: row.doi })}</p>}
            {row.paper_id && <p className="small">{t('mappings.screening.in_library', { id: row.paper_id })}</p>}
            <Abstract text={row.abstract} quote={phase === 'title_abstract' ? (suggestion?.quote ?? null) : null} />
            {current.state !== 'pending' && current.state !== 'conflict' && (
              <p className="small">
                {t('mappings.screening.current', { decision: phaseLabel(t, current, view.protocol) })}{' '}
                {current.by === 'suggestion' && <span className="muted">{t('mappings.screening.by_suggestion')}</span>}
                {current.outdated && <span className="warning-text"> {t('mappings.screening.outdated', { version: current.protocolVersion })}</span>}
              </p>
            )}
            {suggestion && (
              <div className="screening-suggestion">
                <p>
                  <strong>
                    {t('mappings.screening.suggestion', {
                      decision: phaseLabel(t, { state: suggestion.decision, criterion: suggestion.criterion, protocolVersion: suggestion.protocolVersion }, view.protocol)
                    })}
                  </strong>
                </p>
                <p className="card-text">{suggestion.justification}</p>
                {suggestion.quote && (
                  <p className="small">
                    <q>{suggestion.quote}</q>
                    {suggestion.page !== null && <span className="muted"> {t('mappings.screening.page', { page: suggestion.page })}</span>}
                    {!suggestion.found && <span className="warning-text"> {t('mappings.screening.quote_not_found')}</span>}
                  </p>
                )}
                {suggestion.outdated && <p className="warning-text small">{t('mappings.screening.suggestion_outdated')}</p>}
                {canDecide && (
                  <button className="small" disabled={busy} aria-keyshortcuts="A" onClick={accept}>
                    {t('mappings.screening.accept')}
                  </button>
                )}
              </div>
            )}
            {blockedReason ? (
              <p className="warning-text small">{t(blockedReason)}</p>
            ) : (
              <>
                <div className="row card-actions">
                  <button disabled={busy} aria-keyshortcuts="I" onClick={() => decide('include', null)}>
                    {t('mappings.screening.include')}
                  </button>
                  <button
                    disabled={busy || exclusions.length === 0}
                    aria-keyshortcuts="E"
                    aria-expanded={exclusions.length > 1 ? choosing : undefined}
                    onClick={() => (exclusions.length === 1 ? decide('exclude', exclusions[0].id) : setChoosing((open) => !open))}
                  >
                    {t('mappings.screening.exclude')}
                  </button>
                  <button disabled={busy} aria-keyshortcuts="D" onClick={() => decide('uncertain', null)}>
                    {t('mappings.screening.uncertain')}
                  </button>
                  {phase === 'full_text' && (
                    <button disabled={busy} aria-keyshortcuts="N" onClick={() => decide('not_retrieved', null)}>
                      {t('mappings.screening.not_retrieved')}
                    </button>
                  )}
                </div>
                {exclusions.length === 0 && <p className="muted small">{t('mappings.screening.no_exclusions')}</p>}
                {choosing && (
                  <div className="criteria-picker" role="group" aria-label={t('mappings.screening.choose_criterion')}>
                    {exclusions.map((c, i) => (
                      <button key={c.id} className="small" disabled={busy} onClick={() => decide('exclude', c.id)}>
                        {t('mappings.screening.criterion_option', { number: i + 1, label: criterionLabel(view.protocol, c.id) })}
                      </button>
                    ))}
                  </div>
                )}
                <p className="muted small">{t(`mappings.screening.shortcuts_${phase}`)}</p>
              </>
            )}
          </div>
          {phase === 'full_text' && (
            // Focusable, so a click on its text or PDF takes the focus there and the shortcuts stay out of the paper.
            <div className="screening-paper" tabIndex={-1}>
              {row.paper_id ? (
                <PaperDetail key={row.paper_id} id={row.paper_id} />
              ) : (
                <div className="pad">
                  <p>{t('mappings.screening.not_in_library')}</p>
                  <button disabled={busy} onClick={() => openIngest([row.id])}>
                    {t('mappings.screening.add_one')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {plan && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="suggest-title" onKeyDown={dialogKeys(closePlan)}>
            <h3 id="suggest-title">{t('mappings.screening.suggest_title')}</h3>
            {planLines(t, plan).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="muted small">{t('mappings.screening.suggest_note')}</p>
            <div className="row">
              <button autoFocus onClick={closePlan}>
                {t('mappings.screening.cancel')}
              </button>
              <button disabled={busy} onClick={runSuggest}>
                {t('mappings.screening.suggest_run')}
              </button>
            </div>
          </div>
        </div>
      )}

      {ingest && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ingest-title" onKeyDown={dialogKeys(closeIngest)}>
            <p id="ingest-title">
              <strong>{t('mappings.screening.ingest_confirm', { count: ingest.plan.count })}</strong>
            </p>
            <p className="muted small">{t('mappings.screening.ingest_help')}</p>
            {ingest.plan.autoSummarize && <p className="warning-text">{t('mappings.screening.ingest_auto', { cost: approxUsd(ingest.plan.estimateUsd) })}</p>}
            <div className="row">
              <button autoFocus onClick={closeIngest}>
                {t('mappings.screening.cancel')}
              </button>
              <button disabled={busy} onClick={runIngest}>
                {t('mappings.screening.ingest_run')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
