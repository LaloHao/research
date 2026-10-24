import type { TFunction } from 'i18next'
import { entryOutcome, weakestOutcome, type CheckCounts, type CiteCheckPlan, type CiteCheckResult, type EntryOutcome, type ReportLabels } from '../../shared/writing/citeCheck'
import { errorText } from './errorText'
import { approxUsd } from './mappings'

/** A piece of the checked text: plain, or a citation colored by the weakest outcome of its keys in its sentence. */
export type TextSegment = { text: string; citation: null } | { text: string; citation: { sentence: number; outcome: EntryOutcome; keys: string[] } }

export function textSegments(text: string, result: CiteCheckResult): TextSegment[] {
  const citations = result.sentences
    .flatMap((s, sentence) =>
      s.citations.map((c) => {
        const outcomes = s.entries.filter((e) => c.keys.includes(e.key)).map(entryOutcome)
        return { start: c.start, end: c.end, sentence, keys: c.keys, outcome: weakestOutcome(outcomes) }
      })
    )
    .sort((a, b) => a.start - b.start)
  const out: TextSegment[] = []
  let at = 0
  for (const c of citations) {
    if (c.start < at || c.end > text.length) continue
    if (c.start > at) out.push({ text: text.slice(at, c.start), citation: null })
    out.push({ text: text.slice(c.start, c.end), citation: { sentence: c.sentence, outcome: c.outcome, keys: c.keys } })
    at = c.end
  }
  if (at < text.length) out.push({ text: text.slice(at), citation: null })
  return out
}

export function countsLine(t: TFunction, counts: CheckCounts): string {
  return t('writing.check.counts', {
    supports: counts.supports,
    partial: counts.partial,
    notSupported: counts.does_not_support,
    notFound: counts.not_found,
    unverified: counts.unverified
  })
}

/** Why a check ended early, or null when it ran to the end. */
export function endedLine(t: TFunction, result: CiteCheckResult): string | null {
  if (result.stopped) return t('writing.check.stopped', { done: result.checkedBatches, total: result.batches })
  if (result.error) return t('writing.check.ended_early', { done: result.checkedBatches, total: result.batches, error: errorText(t, result.error) })
  return null
}

export function reportLabels(t: TFunction, result: CiteCheckResult): ReportLabels {
  return {
    title: t('writing.check.report_title'),
    summary: (counts) => countsLine(t, counts),
    outcome: (o) => t(`writing.check.outcomes.${o}`),
    reason: (r) => t(`writing.check.reasons.${r}`),
    page: (page) => t('writing.check.page', { page }),
    ended: endedLine(t, result)
  }
}

const usd = (n: number): string => n.toFixed(2)

/** The confirmation's lines: what is checked in how many calls, the estimate, the cap and the month. */
export function checkPlanLines(t: TFunction, plan: CiteCheckPlan): string[] {
  return [
    t('writing.check.confirm', { count: plan.sentences, pairs: plan.pairs, calls: plan.batches, cost: approxUsd(plan.estimateUsd) }),
    t('writing.check.confirm_cap', { cap: usd(plan.capUsd) }),
    plan.monthCapUsd === null ? t('writing.check.month_no_cap', { spent: usd(plan.monthSpentUsd) }) : t('writing.check.month', { spent: usd(plan.monthSpentUsd), cap: usd(plan.monthCapUsd) }),
    ...(plan.perCallUsd * plan.batches > plan.capUsd ? [t('writing.check.may_stop')] : []),
    ...(plan.unverifiable > 0 ? [t('writing.check.unverifiable', { count: plan.unverifiable })] : [])
  ]
}
