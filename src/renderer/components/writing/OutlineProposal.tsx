import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatCitation } from '../../../shared/chat'
import type { LlmModel } from '../../../shared/summary'
import type { CiteFormat } from '../../../shared/writing/citations'
import type { LatexOutputCommand } from '../../../shared/writing/convert'
import type { Outline, OutlineEntry, OutlineLabels } from '../../../shared/writing/outline'
import { outlineTargets, renderProposedOutline, type OutlineProposalRun, type OutlineRequest } from '../../../shared/writing/outlineProposal'
import { costText } from '../../lib/chat'
import { errorText } from '../../lib/errorText'
import { FILE_EXTENSIONS } from '../../lib/writing'
import { AnswerMarkdown } from '../chat/ChatMessage'
import { ClaudeConfirm } from './ClaudeConfirm'

type Phase = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'running' } | { kind: 'error'; message: string }

/**
 * «Proponer redacción del esquema» (cost kind `outline`, cap `per_outline_usd`): Claude's headings, order, openings and
 * gap sentences over the basic outline, with every citation checked by the app; shown merged into the outline and
 * exported as Org, LaTeX or Markdown. The main process builds the outline again from `request`, and the proposal is
 * shown on that outline (a later change of the choices marks it as outdated).
 */
export function OutlineProposal({
  outline,
  format,
  latexCommand,
  request,
  labels
}: {
  outline: Outline | null
  format: CiteFormat
  latexCommand: LatexOutputCommand
  /** The choices the outline was built from; null while there is none. */
  request: Omit<OutlineRequest, 'model'> | null
  labels: OutlineLabels
}): React.JSX.Element {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [result, setResult] = useState<{ run: OutlineProposalRun; key: string } | null>(null)
  const [quotes, setQuotes] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const requestKey = request ? JSON.stringify(request) : ''
  const empty = !outline || outlineTargets(outline).papers.size === 0

  const run = (model: LlmModel): void => {
    if (!request) return
    const key = requestKey
    setPhase({ kind: 'running' })
    setNotice(null)
    window.research.writing.proposeOutline({ ...request, model }, true).then(
      (r) => {
        if (r.ok) {
          setResult({ run: r.run, key })
          setPhase({ kind: 'idle' })
        } else setPhase({ kind: 'error', message: errorText(t, r.error) })
      },
      () => setPhase({ kind: 'error', message: errorText(t, 'unknown') })
    )
  }

  const exported = useMemo(
    () => (result ? renderProposedOutline(result.run.outline, result.run.proposal, { format, latexCommand, quotes, labels, checks: result.run.checks }) : null),
    [result, format, latexCommand, quotes, labels]
  )

  const copy = (): void => {
    if (!exported) return
    navigator.clipboard.writeText(exported.text).then(
      () => setNotice({ error: false, text: t('writing.copied') }),
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }
  const save = async (): Promise<void> => {
    if (!exported) return
    try {
      const r = await window.research.exports.save(`${t('writing.outline.proposal_file_name')}.${FILE_EXTENSIONS[format]}`, exported.text)
      if (r.ok) setNotice({ error: false, text: t('writing.saved', { path: r.path }) })
      else if (r.error) setNotice({ error: true, text: errorText(t, r.error) })
    } catch {
      setNotice({ error: true, text: errorText(t, 'unknown') })
    }
  }

  return (
    <div className="writing-claude">
      <h3>{t('writing.outline.claude_title')}</h3>
      <p className="muted small">{t('writing.outline.claude_intro')}</p>
      {phase.kind === 'confirm' && (
        <ClaudeConfirm kind="outline" title={t('writing.outline.claude_title')} onConfirm={run} onCancel={() => setPhase({ kind: 'idle' })} />
      )}
      <div className="row">
        <button disabled={empty || phase.kind === 'running'} onClick={() => setPhase({ kind: 'confirm' })}>
          {result ? t('writing.outline.claude_again') : t('writing.outline.claude_run')}
        </button>
        {phase.kind === 'running' && (
          <span className="muted small" role="status">
            {t('writing.outline.claude_running')}
          </span>
        )}
        {empty && <span className="muted small">{t('writing.outline.claude_empty')}</span>}
      </div>
      {phase.kind === 'error' && (
        <div className="banner error" role="alert">
          {phase.message}
          <button onClick={() => setPhase({ kind: 'confirm' })}>{t('writing.claude.retry')}</button>
        </div>
      )}
      {result && exported && (
        <>
          {result.key !== requestKey && <div className="banner warning">{t('writing.outline.claude_outdated')}</div>}
          <p role="status">
            {t('writing.claude.cost', { cost: costText(result.run.costUsd) })}
            {` · ${t('writing.outline.claude_citations', { count: exported.converted })}`}
            {exported.unverified > 0 && ` · ${t('writing.outline.claude_unverified', { count: exported.unverified })}`}
          </p>
          <ProposalPreview run={result.run} labels={labels} />
          <div className="writing-export">
            <div className="row">
              <label className="row">
                <input type="checkbox" checked={quotes} onChange={(e) => setQuotes(e.target.checked)} />
                <span>{t('writing.outline.claude_quotes')}</span>
              </label>
              <button onClick={copy}>{t('writing.copy')}</button>
              <button onClick={() => void save()}>{t('writing.outline.save')}</button>
            </div>
            {notice && (
              <div className={`banner${notice.error ? ' error' : ''}`} role="status">
                {notice.text}
              </div>
            )}
            <textarea className="writing-output" readOnly aria-label={t('writing.outline.claude_output_label')} value={exported.text} />
          </div>
        </>
      )}
    </div>
  )
}

/** The outline as the proposal would write it: its order, its headings (the facet value beside them), openings and gap sentences. */
function ProposalPreview({ run, labels }: { run: OutlineProposalRun; labels: OutlineLabels }): React.JSX.Element {
  const { t } = useTranslation()
  const { outline, proposal, checks } = run
  const targets = outlineTargets(outline)
  const entries = new Map<string, OutlineEntry>()
  for (const s of outline.sections) {
    for (const p of s.papers) entries.set(p.id, p)
    for (const sub of s.subsections) for (const p of sub.papers) entries.set(p.id, p)
  }
  for (const p of outline.unclassified) entries.set(p.id, p)
  const gap = (id: string, label: string): React.JSX.Element => (
    <div key={id} className="writing-gap-block">
      <p className="writing-gap">{t('writing.outline.gap', { text: label })}</p>
      {proposal.gaps[id] && <Opening text={proposal.gaps[id]} citations={checks[id]} />}
    </div>
  )
  const section = (id: string): React.JSX.Element | null => {
    const target = targets.sections.find((s) => s.id === id)
    if (!target) return null
    const label = target.value === null ? labels.unclassified : labels.value(target.sub === null ? outline.facet : outline.secondary!, target.sub ?? target.value)
    const proposed = proposal.sections[id]
    const Heading = target.kind === 'subsection' ? 'h4' : 'h3'
    const children = targets.sections.filter((s) => s.kind === 'subsection' && s.id.startsWith(`${id}.`))
    const combos = target.kind === 'section' ? targets.gaps.filter((g) => g.secondary !== null && g.value === target.value) : []
    return (
      <div key={id} className={target.kind === 'subsection' ? 'writing-subsection' : 'writing-section'}>
        <Heading>
          {proposed?.title ?? label}
          {proposed && proposed.title !== label && <span className="muted small"> · {label}</span>}
        </Heading>
        {proposed?.opening && <Opening text={proposed.opening} citations={checks[id]} />}
        {target.papers.length > 0 && (
          <ul className="writing-papers">
            {target.papers.map((p) => (
              <li key={p}>
                <code>{p}</code> {entries.get(p)?.title}
              </li>
            ))}
          </ul>
        )}
        {children.map((c) => section(c.id))}
        {combos.map((g) => gap(g.id, labels.gapCombination(labels.value(outline.facet, g.value), labels.value(outline.secondary!, g.secondary!))))}
      </div>
    )
  }
  return (
    <div className="writing-outline">
      {proposal.order.map((id) => {
        const g = targets.gaps.find((x) => x.id === id)
        return g ? gap(id, labels.gapValue(labels.value(outline.facet, g.value))) : section(id)
      })}
      {targets.sections.some((s) => s.id === 'U') && section('U')}
    </div>
  )
}

function Opening({ text, citations }: { text: string; citations: ChatCitation[] | undefined }): React.JSX.Element {
  return <AnswerMarkdown text={text} citations={citations ?? []} />
}
