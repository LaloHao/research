import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperDetail } from '../../../shared/library'
import type { LlmModel } from '../../../shared/summary'
import type { CitationReport, CiteFormat } from '../../../shared/writing/citations'
import { citeCheckMarkdown, entryOutcome, type CheckedSentence, type CiteCheckPlan, type CiteCheckProgress, type CiteCheckResult } from '../../../shared/writing/citeCheck'
import { checkPlanLines, countsLine, endedLine, reportLabels, textSegments } from '../../lib/citeCheck'
import { errorText } from '../../lib/errorText'
import { EvidencePanel, type Picked } from '../review/EvidencePanel'
import { ClaudeConfirm } from './ClaudeConfirm'

const PROGRESS_MS = 800

type Checked = { result: CiteCheckResult; text: string }

/**
 * «Verificar con Claude» (cost kind `cite_check`, cap `per_cite_check_usd`): after a cost confirmation, Claude judges
 * whether each paper a sentence cites supports it, on passages the app picked, and the app verifies each quote. The
 * result lives in this tab (never in the project): the text with each citation colored by verdict, a panel per sentence
 * whose quotes open the paper highlighted, a summary, and «Exportar informe» to Markdown.
 */
export function CheckWithClaude({ report, text, format }: { report: CitationReport | null; text: string; format: CiteFormat }): React.JSX.Element {
  const { t } = useTranslation()
  const [plan, setPlan] = useState<{ plan: CiteCheckPlan; text: string; format: CiteFormat } | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<CiteCheckProgress | null>(null)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<{ detail: PaperDetail; picked: Picked } | null>(null)
  const evidenceSeq = useRef(0)
  const panels = useRef(new Map<number, HTMLLIElement>())

  const checkable = Boolean(report?.citations.some((c) => Object.values(c.states).includes('ok')))

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      window.research.writing.checkProgress().then(setProgress, () => undefined)
    }, PROGRESS_MS)
    return () => clearInterval(timer)
  }, [running])

  const ask = (): void => {
    if (busy || running || !checkable) return
    setBusy(true)
    setError(null)
    const asked = { text, format }
    window.research.writing.checkPlan(text, format).then(
      (r) => {
        setBusy(false)
        if (r.ok) setPlan({ plan: r.plan, ...asked })
        else setError(errorText(t, r.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const run = (model: LlmModel): void => {
    if (!plan || running) return
    const asked = plan
    setPlan(null)
    setRunning(true)
    setProgress({ batches: asked.plan.batches, done: 0 })
    setError(null)
    setNotice(null)
    window.research.writing.check({ text: asked.text, format: asked.format, model }, true).then(
      (r) => {
        setRunning(false)
        setProgress(null)
        if (r.ok) setChecked({ result: r.result, text: asked.text })
        else setError(errorText(t, r.error))
      },
      () => {
        setRunning(false)
        setProgress(null)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  const stop = (): void => {
    void window.research.writing.checkStop().catch(() => undefined)
  }

  const exportReport = async (): Promise<void> => {
    if (!checked) return
    try {
      const md = citeCheckMarkdown(checked.result, reportLabels(t, checked.result))
      const r = await window.research.exports.save(`${t('writing.check.report_file')}.md`, md)
      if (r.ok) setNotice(t('writing.saved', { path: r.path }))
      else if (r.error) setError(errorText(t, r.error))
    } catch {
      setError(errorText(t, 'unknown'))
    }
  }

  const openQuote = useCallback(
    (key: string, picked: Picked) => {
      const token = ++evidenceSeq.current
      window.research.library.detail(key).then(
        (detail) => {
          if (token === evidenceSeq.current) setEvidence({ detail, picked })
        },
        () => {
          if (token === evidenceSeq.current) setError(errorText(t, 'unknown'))
        }
      )
    },
    [t]
  )

  const showSentence = (i: number): void => {
    const el = panels.current.get(i)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    el?.focus()
  }

  const segments = useMemo(() => (checked ? textSegments(checked.text, checked.result) : []), [checked])
  const ended = checked ? endedLine(t, checked.result) : null

  return (
    <div className="writing-claude">
      <h3>{t('writing.check.claude_title')}</h3>
      <p className="muted small">{t('writing.check.claude_intro')}</p>
      <div className="row">
        {running ? (
          <>
            <button onClick={stop}>{t('writing.check.stop')}</button>
            <span role="status" className="muted small">
              {t('writing.check.running', { done: progress?.done ?? 0, total: progress?.batches ?? 0 })}
            </span>
          </>
        ) : (
          <button className="primary" disabled={busy || !checkable} onClick={ask}>
            {t('writing.check.claude_run')}
          </button>
        )}
        {!running && report && !checkable && <span className="muted small">{t('writing.check.nothing_to_check')}</span>}
      </div>
      {error && (
        <div className="banner error row" role="alert">
          <span>{error}</span>
          {!running && checkable && (
            <button className="small" onClick={ask}>
              {t('writing.check.retry')}
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="muted small" role="status">
          {notice}
        </p>
      )}

      {checked && (
        <div className="writing-check-result">
          <div className="row">
            <strong role="status">{countsLine(t, checked.result.counts)}</strong>
            <button className="small" onClick={() => void exportReport()}>
              {t('writing.check.export')}
            </button>
          </div>
          {ended && <div className="banner warning">{ended}</div>}
          {checked.text !== text && <p className="muted small">{t('writing.check.text_changed')}</p>}
          {checked.result.dropped > 0 && <p className="muted small">{t('writing.check.dropped', { count: checked.result.dropped })}</p>}
          <div className="writing-checked-text" aria-label={t('writing.check.checked_text')}>
            {segments.map((s, i) =>
              s.citation ? (
                <button
                  key={i}
                  type="button"
                  className={`writing-cite cite-outcome-${s.citation.outcome}`}
                  title={t(`writing.check.outcomes.${s.citation.outcome}`)}
                  onClick={() => s.citation && showSentence(s.citation.sentence)}
                >
                  {s.text}
                </button>
              ) : (
                <span key={i}>{s.text}</span>
              )
            )}
          </div>
          <ol className="writing-check-sentences">
            {checked.result.sentences.map((s, i) => (
              <li
                key={s.start}
                tabIndex={-1}
                ref={(el) => {
                  if (el) panels.current.set(i, el)
                  else panels.current.delete(i)
                }}
              >
                <SentencePanel sentence={s} onOpen={openQuote} />
              </li>
            ))}
          </ol>
        </div>
      )}

      {evidence && (
        <aside className="writing-evidence" aria-label={t('writing.check.evidence')}>
          <div className="row chat-evidence-head">
            <strong>{evidence.detail.paper?.title ?? evidence.detail.id}</strong>
            <button className="small" onClick={() => setEvidence(null)}>
              {t('writing.check.close_evidence')}
            </button>
          </div>
          <EvidencePanel detail={evidence.detail} evidence={evidence.picked} />
        </aside>
      )}

      {plan && (
        <ClaudeConfirm
          kind="cite_check"
          title={t('writing.check.confirm_title')}
          plan={plan.plan}
          lines={checkPlanLines(t, plan.plan)}
          confirmLabel={t('writing.check.confirm_run')}
          canRun={plan.plan.batches > 0}
          onConfirm={run}
          onCancel={() => setPlan(null)}
        />
      )}
    </div>
  )
}

function SentencePanel({ sentence, onOpen }: { sentence: CheckedSentence; onOpen: (key: string, picked: Picked) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="writing-check-sentence">
      <div className="writing-sentence">{sentence.text}</div>
      <ul>
        {sentence.entries.map((e) => {
          const outcome = entryOutcome(e)
          return (
            <li key={e.key}>
              <div className="row small">
                <strong>{e.key}</strong>
                <span className={`chip cite-outcome-${outcome}`}>{t(`writing.check.outcomes.${outcome}`)}</span>
                {outcome === 'unverified' && e.reason && <span className="muted">{t(`writing.check.reasons.${e.reason}`)}</span>}
              </div>
              {e.quote && (
                <blockquote className="writing-check-quote">
                  {t('chat.quoted', { quote: e.quote })}{' '}
                  {/* A quote that was not found still opens the paper, on Claude's page, so it can be looked up by hand. */}
                  <button type="button" className={`cite-chip${e.found ? '' : ' cite-not_found'}`} onClick={() => onOpen(e.key, { page: e.page, quote: e.quote! })}>
                    {e.page === null ? t('writing.check.open_paper') : t('writing.check.page', { page: e.page })}
                  </button>
                </blockquote>
              )}
              {e.note && <p className="muted small">{e.note}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
