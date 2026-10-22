/**
 * «Verificar con Claude»: whether each paper a sentence cites supports it. Pure types and helpers shared by the main
 * process (which runs the check), the window (which shows it and exports the report) and any later local API.
 */
import type { LlmModel } from '../summary'
import type { WritingPlan } from './api'
import type { CiteFormat, KeyState } from './citations'

/** Claude's verdict on one (sentence, paper) pair. */
export const CHECK_VERDICTS = ['supports', 'partial', 'does_not_support', 'not_found'] as const
export type CheckVerdict = (typeof CHECK_VERDICTS)[number]

/** Sentences per Claude call. */
export const MAX_SENTENCES_PER_CALL = 10
/** Papers checked per sentence; further keys of a very long citation are left unverified. */
export const MAX_KEYS_PER_SENTENCE = 8

/**
 * Why a pair has no verdict: its key cannot be checked (`unknown`, `trashed`, `no_text`), the check never reached it
 * (`not_checked`: stopped, cap reached, an error, or past MAX_KEYS_PER_SENTENCE), Claude did not answer it
 * (`no_answer`), or its batch's answer was invalid twice (`invalid_output`).
 */
export const UNVERIFIED_REASONS = ['unknown', 'trashed', 'no_text', 'not_checked', 'no_answer', 'invalid_output'] as const
export type UnverifiedReason = (typeof UNVERIFIED_REASONS)[number]

export interface CheckEntry {
  key: string
  /** null: unverified (see `reason`). */
  verdict: CheckVerdict | null
  reason: UnverifiedReason | null
  /** Verbatim text of the paper Claude gave as evidence. */
  quote: string | null
  /** The page where the app found the quote (Claude's page when it was not found); null for page-less text. */
  page: number | null
  /** The quote was found in the paper's indexed text (the chat's normalization). */
  found: boolean
  note: string | null
}

/** What a pair shows: its verdict; `no_evidence` when a verdict that claims support has no quote found in the paper. */
export const ENTRY_OUTCOMES = ['supports', 'partial', 'does_not_support', 'not_found', 'no_evidence', 'unverified'] as const
export type EntryOutcome = (typeof ENTRY_OUTCOMES)[number]

export function entryOutcome(e: CheckEntry): EntryOutcome {
  if (e.verdict === null) return 'unverified'
  if (e.verdict === 'not_found') return 'not_found'
  return e.found ? e.verdict : 'no_evidence'
}

/** The weakest outcome first: a citation of several papers is colored by the weakest one. */
const OUTCOME_ORDER: EntryOutcome[] = ['does_not_support', 'not_found', 'no_evidence', 'partial', 'unverified', 'supports']

export function weakestOutcome(outcomes: EntryOutcome[]): EntryOutcome {
  return OUTCOME_ORDER.find((o) => outcomes.includes(o)) ?? 'unverified'
}

export interface CheckedSentence {
  /** Offsets of the sentence in the checked text. */
  start: number
  end: number
  /** Whitespace collapsed. */
  text: string
  /** The sentence's citations (offsets in the checked text) with their keys. */
  citations: { start: number; end: number; keys: string[] }[]
  /** One entry per distinct key the sentence cites, in order. */
  entries: CheckEntry[]
}

/** Pairs by outcome; `unverified` counts the unverified pairs and those whose evidence was not found. */
export interface CheckCounts {
  supports: number
  partial: number
  does_not_support: number
  not_found: number
  unverified: number
}

export interface CiteCheckResult {
  format: CiteFormat
  sentences: CheckedSentence[]
  counts: CheckCounts
  /** Claude calls planned and made. */
  batches: number
  checkedBatches: number
  costUsd: number
  /** The model that answered (the requested alias until a call answers). */
  model: string
  stopped: boolean
  /** Why the check ended early (a user-facing error code: budget_exceeded, llm_quota…), or null. */
  error: string | null
  /** Answer entries left out: invalid, for a sentence or key not asked, or repeated. */
  dropped: number
}

/** The confirmation's numbers: the check's estimate (per call × calls, at most the cap) and what it will check. */
export interface CiteCheckPlan extends WritingPlan {
  /** Sentences with at least one key that can be checked, and their (sentence, key) pairs. */
  sentences: number
  pairs: number
  batches: number
  /** The learned estimate of one call. */
  perCallUsd: number
  /** Pairs that cannot be checked (unknown, trashed or no text). */
  unverifiable: number
  /** The project's default model. */
  model: LlmModel
}

export interface CiteCheckProgress {
  batches: number
  done: number
}

export interface CiteCheckRequest {
  text: string
  format: CiteFormat
  /** The project's default when absent. */
  model?: LlmModel
}

export type CiteCheckPlanResult = { ok: true; plan: CiteCheckPlan } | { ok: false; error: string }
export type CiteCheckRunResult = { ok: true; result: CiteCheckResult } | { ok: false; error: string }

export function checkCounts(sentences: CheckedSentence[]): CheckCounts {
  const counts: CheckCounts = { supports: 0, partial: 0, does_not_support: 0, not_found: 0, unverified: 0 }
  for (const s of sentences)
    for (const e of s.entries) {
      const o = entryOutcome(e)
      if (o === 'no_evidence' || o === 'unverified') counts.unverified++
      else counts[o]++
    }
  return counts
}

/** A key state that cannot be checked, as its unverified reason. */
export function reasonOfState(state: KeyState): UnverifiedReason | null {
  return state === 'ok' ? null : state
}

/** The words of «Exportar informe», in the window's language. */
export interface ReportLabels {
  title: string
  summary: (counts: CheckCounts) => string
  outcome: (o: EntryOutcome) => string
  reason: (r: UnverifiedReason) => string
  page: (page: number) => string
  /** «Detenida», «Se detuvo: …» and the like; null when the check ran to the end. */
  ended: string | null
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The report in Markdown: the summary, then each sentence with each paper's outcome, quote, page and note. */
export function citeCheckMarkdown(result: CiteCheckResult, labels: ReportLabels): string {
  const lines = [`# ${labels.title}`, '', labels.summary(result.counts)]
  if (labels.ended) lines.push('', `> ${labels.ended}`)
  result.sentences.forEach((s, i) => {
    lines.push('', `## ${i + 1}. ${oneLine(s.text)}`, '')
    for (const e of s.entries) {
      const o = entryOutcome(e)
      const why = o === 'unverified' && e.reason ? ` (${labels.reason(e.reason)})` : ''
      lines.push(`- **${e.key}**: ${labels.outcome(o)}${why}`)
      if (e.quote) lines.push(`  > "${oneLine(e.quote)}"${e.page !== null ? ` (${labels.page(e.page)})` : ''}`)
      if (e.note) lines.push(`  ${oneLine(e.note)}`)
    }
  })
  return `${lines.join('\n')}\n`
}
