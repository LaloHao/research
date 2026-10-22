import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LlmModel } from '../../../shared/summary'
import { detectFormat, type CiteFormat } from '../../../shared/writing/citations'
import {
  applyStyleSuggestions,
  droppedCount,
  MAX_STYLE_CHARS,
  STYLE_DROP_REASONS,
  STYLE_FOCUSES,
  styleSegments,
  type StyleFocus,
  type StyleReviewRun,
  type StyleSuggestion
} from '../../../shared/writing/style'
import { costText } from '../../lib/chat'
import { errorText } from '../../lib/errorText'
import { ClaudeConfirm } from './ClaudeConfirm'
import { InputFormat } from './OutputFormat'

type Phase = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'running' } | { kind: 'error'; message: string }
type Decision = 'accepted' | 'rejected'

/**
 * «Estilo»: Claude's style suggestions for pasted text (cost kind `style`, cap `per_style_usd`). The main process keeps
 * only the suggestions that change a verbatim fragment and leave citations, math and commands as they are; here each
 * one is accepted or rejected, and the final text is copied. Nothing is saved in the project.
 */
export function StyleTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [format, setFormat] = useState<CiteFormat | 'auto'>('auto')
  const [focus, setFocus] = useState<StyleFocus[]>([...STYLE_FOCUSES])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [result, setResult] = useState<{ run: StyleReviewRun; text: string } | null>(null)
  const [decisions, setDecisions] = useState<Map<number, Decision>>(new Map())
  const [view, setView] = useState<'diff' | 'final'>('diff')
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const detected = useMemo(() => detectFormat(text), [text])
  const used = format === 'auto' ? detected : format
  const tooLong = text.length > MAX_STYLE_CHARS
  const canRun = text.trim().length > 0 && !tooLong && focus.length > 0 && phase.kind !== 'running'

  const toggleFocus = (f: StyleFocus, on: boolean): void => setFocus((current) => STYLE_FOCUSES.filter((x) => (x === f ? on : current.includes(x))))

  const run = (model: LlmModel): void => {
    const reviewed = text
    setPhase({ kind: 'running' })
    setNotice(null)
    window.research.writing.reviewStyle({ text: reviewed, format: used, focus, model }, true).then(
      (r) => {
        if (r.ok) {
          setResult({ run: r.run, text: reviewed })
          setDecisions(new Map())
          setPhase({ kind: 'idle' })
        } else setPhase({ kind: 'error', message: errorText(t, r.error) })
      },
      () => setPhase({ kind: 'error', message: errorText(t, 'unknown') })
    )
  }

  const accepted = useMemo(() => new Set([...decisions].filter(([, d]) => d === 'accepted').map(([id]) => id)), [decisions])
  const finalText = useMemo(() => (result ? applyStyleSuggestions(result.text, result.run.suggestions, accepted) : ''), [result, accepted])
  const decide = (id: number, d: Decision): void => setDecisions((m) => new Map(m).set(id, d))
  const acceptAll = (): void => setDecisions(new Map(result?.run.suggestions.map((s): [number, Decision] => [s.id, 'accepted']) ?? []))

  const copy = (): void => {
    navigator.clipboard.writeText(finalText).then(
      () => setNotice({ error: false, text: t('writing.copied') }),
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }

  const dropped = result ? droppedCount(result.run.dropped) : 0
  return (
    <section className="writing-tab">
      <h3>{t('writing.style.title')}</h3>
      <p className="muted">{t('writing.style.intro')}</p>
      <div className="row">
        <InputFormat value={format} detected={detected} onChange={setFormat} />
        <span className={`small ${tooLong ? 'error' : 'muted'}`}>{t('writing.style.chars', { length: text.length, max: MAX_STYLE_CHARS })}</span>
      </div>
      <textarea
        className="writing-input"
        aria-label={t('writing.style.text_label')}
        placeholder={t('writing.style.placeholder')}
        value={text}
        aria-invalid={tooLong || undefined}
        onChange={(e) => setText(e.target.value)}
      />
      {tooLong && (
        <div className="banner error" role="alert">
          {t('writing.style.too_long', { max: MAX_STYLE_CHARS })}
        </div>
      )}
      <fieldset className="writing-focus">
        <legend>{t('writing.style.focus')}</legend>
        {STYLE_FOCUSES.map((f) => (
          <label key={f} className="row">
            <input type="checkbox" checked={focus.includes(f)} onChange={(e) => toggleFocus(f, e.target.checked)} />
            <span>{t(`writing.style.focuses.${f}`)}</span>
          </label>
        ))}
      </fieldset>
      {phase.kind === 'confirm' && (
        <ClaudeConfirm kind="style" title={t('writing.style.title')} onConfirm={run} onCancel={() => setPhase({ kind: 'idle' })} />
      )}
      <div className="row">
        <button className="primary" disabled={!canRun} onClick={() => setPhase({ kind: 'confirm' })}>
          {t('writing.style.run')}
        </button>
        {phase.kind === 'running' && (
          <span className="muted small" role="status">
            {t('writing.style.running')}
          </span>
        )}
        {focus.length === 0 && <span className="muted small">{t('writing.style.no_focus')}</span>}
      </div>
      {phase.kind === 'error' && (
        <div className="banner error" role="alert">
          {phase.message}
          <button onClick={() => setPhase({ kind: 'confirm' })}>{t('writing.claude.retry')}</button>
        </div>
      )}
      {result && (
        <>
          {result.text !== text && <div className="banner warning">{t('writing.style.text_changed')}</div>}
          <p role="status">
            {t('writing.style.summary', { count: result.run.suggestions.length })}
            {` · ${t('writing.claude.cost', { cost: costText(result.run.costUsd) })}`}
            {dropped > 0 &&
              ` · ${t('writing.style.dropped', { count: dropped })} (${STYLE_DROP_REASONS.filter((r) => result.run.dropped[r] > 0)
                .map((r) => t(`writing.style.drop_reasons.${r}`, { count: result.run.dropped[r] }))
                .join(', ')})`}
          </p>
          {result.run.suggestions.length > 0 && (
            <div className="row">
              <button onClick={acceptAll}>{t('writing.style.accept_all')}</button>
              <button onClick={() => setDecisions(new Map())}>{t('writing.style.reset')}</button>
            </div>
          )}
          <ol className="writing-suggestions">
            {result.run.suggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} decision={decisions.get(s.id) ?? null} onDecide={(d) => decide(s.id, d)} />
            ))}
          </ol>
          <div className="writing-export">
            <div className="row" role="radiogroup" aria-label={t('writing.style.view')}>
              <label className="row">
                <input type="radio" name="style-view" checked={view === 'diff'} onChange={() => setView('diff')} />
                <span>{t('writing.style.views.diff')}</span>
              </label>
              <label className="row">
                <input type="radio" name="style-view" checked={view === 'final'} onChange={() => setView('final')} />
                <span>{t('writing.style.views.final')}</span>
              </label>
              <button onClick={copy}>{t('writing.style.copy_final')}</button>
            </div>
            {notice && (
              <div className={`banner${notice.error ? ' error' : ''}`} role="status">
                {notice.text}
              </div>
            )}
            {view === 'final' ? (
              <textarea className="writing-output" readOnly aria-label={t('writing.style.final_label')} value={finalText} />
            ) : (
              <StyleDiff text={result.text} suggestions={result.run.suggestions} accepted={accepted} />
            )}
          </div>
        </>
      )}
    </section>
  )
}

function SuggestionCard({
  suggestion,
  decision,
  onDecide
}: {
  suggestion: StyleSuggestion
  decision: Decision | null
  onDecide: (d: Decision) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li className={`writing-suggestion${decision ? ` ${decision}` : ''}`}>
      <div className="row">
        <span className="chip">{t(`writing.style.focuses.${suggestion.category}`)}</span>
        {decision && <span className="muted small">{t(`writing.style.decisions.${decision}`)}</span>}
      </div>
      <div className="writing-sentence">
        <del>{suggestion.original}</del>
        {' → '}
        <ins>{suggestion.suggestion}</ins>
      </div>
      <div className="small">{suggestion.reason}</div>
      <div className="row">
        <button aria-pressed={decision === 'accepted'} onClick={() => onDecide('accepted')}>
          {t('writing.style.accept')}
        </button>
        <button aria-pressed={decision === 'rejected'} onClick={() => onDecide('rejected')}>
          {t('writing.style.reject')}
        </button>
      </div>
    </li>
  )
}

/** The reviewed text with each suggestion in place: accepted ones as deletion and insertion, the others marked. */
function StyleDiff({ text, suggestions, accepted }: { text: string; suggestions: StyleSuggestion[]; accepted: ReadonlySet<number> }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="writing-diff writing-sentence" aria-label={t('writing.style.diff_label')}>
      {styleSegments(text, suggestions, accepted).map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : s.accepted ? (
          <span key={i}>
            <del>{s.original}</del>
            <ins>{s.suggestion}</ins>
          </span>
        ) : (
          <mark key={i} title={s.suggestion}>
            {s.original}
          </mark>
        )
      )}
    </div>
  )
}
