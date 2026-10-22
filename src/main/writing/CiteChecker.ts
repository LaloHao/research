import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import { MAX_CHECK_CHARS } from '../../shared/writing/api'
import { keyState, parseCitations, type CiteFormat, type KeyIndex } from '../../shared/writing/citations'
import {
  checkCounts,
  MAX_KEYS_PER_SENTENCE,
  MAX_SENTENCES_PER_CALL,
  reasonOfState,
  type CheckedSentence,
  type CheckEntry,
  type CiteCheckPlan,
  type CiteCheckProgress,
  type CiteCheckResult
} from '../../shared/writing/citeCheck'
import type { IndexCache } from '../cache/IndexCache'
import type { Embedder } from '../embeddings/Embedder'
import { UserFacingError, toUserFacing } from '../library/UserFacingError'
import { startAgentRun } from '../log/agentLog'
import { operationCap, type BudgetGuard, type BudgetLimits } from '../llm/BudgetGuard'
import { operationPlan, runCappedOperation, type CappedDeps } from '../llm/cappedOperation'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type CompleteResult, type LlmProvider } from '../llm/LlmProvider'
import type { ProjectStore } from '../project/ProjectStore'
import { locateQuote } from '../summary/evidence'
import { pagesFromChunks, type PageText } from '../summary/paperText'
import { retryNote } from '../summary/prompt'
import { citeCheckInput, citeCheckSchema, citeCheckSystemPrompt, parseCiteCheck, type BatchSentence, type ParsedVerdict } from './citeCheckPrompt'
import { PassageFinder, WINDOW_CHARS } from './passages'

/** Passages shown per (sentence, paper), and the most passage text one call carries (fewer per pair when it would exceed it). */
export const PASSAGES_PER_PAIR = 3
export const MAX_BATCH_PASSAGE_CHARS = 60_000
/** Below this much left of the check's cap, no further call starts. */
const MIN_CALL_USD = 0.01
const CONTEXT_CHARS = 300
const CALL_TIMEOUT_MS = 5 * 60_000
/** A quote of a word or two matches almost any paper, so it never counts as evidence. */
const MIN_QUOTE_WORDS = 3

export interface CiteCheckerDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  limits: () => BudgetLimits
  /** The local multilingual model, or null when it is not on disk (passages are then ranked by their words only). */
  embedder: () => Promise<Embedder | null>
}

export interface CiteCheckRun {
  text: string
  format: CiteFormat
  model?: LlmModel
  signal?: AbortSignal
  onProgress?: (p: CiteCheckProgress) => void
}

/** A sentence to send: its index in the result and the keys Claude judges for it. */
interface Work {
  index: number
  keys: string[]
}

/**
 * «Verificar con Claude»: for each sentence citing papers with indexed text, whether each cited paper supports it.
 * The app picks each paper's passages for the sentence (see passages.ts), Claude judges up to MAX_SENTENCES_PER_CALL
 * sentences per structured call (no tools), and the app checks each quote against the paper's text. The whole check
 * shares one cap (`per_cite_check_usd`); each call is logged as `cite_check`. Reads only; nothing is written to the
 * project. Callable outside the window (a local API) with `run`.
 */
export class CiteChecker {
  constructor(private readonly deps: CiteCheckerDeps) {}

  private get capped(): CappedDeps {
    return { budget: this.deps.budget, ledger: this.deps.ledger, limits: this.deps.limits }
  }

  /** What the confirmation shows: what will be checked, in how many calls, and their estimate (at most the cap). */
  async plan(text: string, format: CiteFormat): Promise<CiteCheckPlan> {
    const { sentences, work } = this.prepare(text, format)
    const base = await operationPlan(this.capped, 'cite_check')
    const batches = Math.ceil(work.length / MAX_SENTENCES_PER_CALL)
    const pairs = work.reduce((n, w) => n + w.keys.length, 0)
    const unverifiable = sentences.reduce((n, s) => n + s.entries.filter((e) => e.reason !== null && e.reason !== 'not_checked').length, 0)
    return {
      ...base,
      perCallUsd: base.estimateUsd,
      estimateUsd: Math.min(base.estimateUsd * batches, base.capUsd),
      sentences: work.length,
      pairs,
      batches,
      unverifiable,
      model: this.deps.store.config.llm.model
    }
  }

  /**
   * Runs the check. Stopping (`signal`), reaching the cap or a failed call ends it early: the sentences checked so far
   * keep their verdicts, the rest stay unverified (`not_checked`), and `stopped` / `error` say why. A batch whose answer
   * is invalid twice leaves its sentences unverified (`invalid_output`) and the check goes on.
   */
  async run(req: CiteCheckRun): Promise<CiteCheckResult> {
    const { store, cache, provider } = this.deps
    if (req.text.length > MAX_CHECK_CHARS) throw new UserFacingError('request_rejected')
    if (req.model !== undefined && !LLM_MODELS.includes(req.model)) throw new UserFacingError('request_rejected')
    const { sentences, work } = this.prepare(req.text, req.format)
    const batches: Work[][] = []
    for (let i = 0; i < work.length; i += MAX_SENTENCES_PER_CALL) batches.push(work.slice(i, i + MAX_SENTENCES_PER_CALL))
    const cap = operationCap(this.deps.limits(), 'cite_check')
    const requested: string = req.model ?? store.config.llm.model
    let model = requested
    let spent = 0
    let checkedBatches = 0
    let dropped = 0
    let stopped = false
    let error: string | null = null
    const finder = new PassageFinder({ chunks: (id) => cache.chunksFor(id), embedder: this.deps.embedder })
    const pages = new Map<string, PageText[]>()
    const pagesOf = (id: string): PageText[] => {
      let p = pages.get(id)
      if (!p) pages.set(id, (p = pagesFromChunks(cache.chunksFor(id))))
      return p
    }
    req.onProgress?.({ batches: batches.length, done: 0 })

    for (const [b, batch] of batches.entries()) {
      if (req.signal?.aborted) {
        stopped = true
        break
      }
      const left = cap - spent
      if (left < MIN_CALL_USD) {
        error = 'cite_check_budget'
        break
      }
      const log = startAgentRun({ kind: 'cite_check', subject: `batch ${b + 1}/${batches.length}`, model: requested, capUsd: left, ids: { sentences: batch.length } })
      let batchCost = 0
      try {
        const prompt = await this.batchPrompt(req.text, sentences, batch, finder, req.signal)
        const asked = new Map(prompt.map((s) => [s.id, new Set(s.papers.map((p) => p.key))]))
        const base = { system: citeCheckSystemPrompt(store.config.content_language), input: citeCheckInput(prompt), schema: citeCheckSchema(), model: requested, signal: req.signal, timeoutMs: CALL_TIMEOUT_MS }
        let parsed: { verdicts: ParsedVerdict[]; dropped: number } | null = null
        let lastError = ''
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
          const input = attempt === 0 ? base.input : `${base.input}\n\n${retryNote(lastError)}`
          const remaining = cap - spent - batchCost
          if (attempt > 0 && remaining < MIN_CALL_USD) break
          let result: CompleteResult
          try {
            result = await runCappedOperation(this.capped, { kind: 'cite_check', model: requested }, (maxUsd) =>
              provider.complete({ ...base, input, maxUsd: Math.min(maxUsd, remaining) })
            )
          } catch (e) {
            // runCappedOperation logged what a cut-off call cost; the check's total counts it too.
            batchCost += failedCallCost(e).costUsd
            throw e
          }
          batchCost += result.costUsd
          model = result.model
          const out = parseCiteCheck(result.value, asked)
          if (out.ok) parsed = out
          else lastError = out.error
        }
        spent += batchCost
        if (!parsed) {
          for (const w of batch) for (const e of sentences[w.index].entries) if (w.keys.includes(e.key)) e.reason = 'invalid_output'
          log.fail(new LlmError('llm_invalid_output', batchCost), { costUsd: batchCost })
        } else {
          dropped += parsed.dropped
          this.apply(sentences, batch, parsed.verdicts, pagesOf)
          log.end({ costUsd: batchCost, extra: { verdicts: parsed.verdicts.length, dropped: parsed.dropped } })
        }
        checkedBatches++
        req.onProgress?.({ batches: batches.length, done: b + 1 })
      } catch (e) {
        spent += batchCost
        log.fail(e, { costUsd: batchCost })
        if (req.signal?.aborted) stopped = true
        else {
          const code = toUserFacing(e).message
          error = code === 'operation_budget' ? 'cite_check_budget' : code
        }
        break
      }
    }
    return {
      format: req.format,
      sentences,
      counts: checkCounts(sentences),
      batches: batches.length,
      checkedBatches,
      costUsd: spent,
      model,
      stopped,
      error,
      dropped
    }
  }

  /** The sentences with citations (`\nocite` makes no claim), each key's entry, and what goes to Claude. */
  private prepare(text: string, format: CiteFormat): { sentences: CheckedSentence[]; work: Work[] } {
    const index = this.keyIndex()
    const bySentence = new Map<number, CheckedSentence>()
    for (const c of parseCitations(text, format)) {
      if (c.command.replace(/\*$/, '') === 'nocite') continue
      let s = bySentence.get(c.sentence.start)
      if (!s) bySentence.set(c.sentence.start, (s = { start: c.sentence.start, end: c.sentence.end, text: c.sentence.text, citations: [], entries: [] }))
      s.citations.push({ start: c.start, end: c.end, keys: [...c.keys] })
      for (const key of c.keys) {
        if (s.entries.some((e) => e.key === key)) continue
        s.entries.push({ key, verdict: null, reason: reasonOfState(keyState(key, index)) ?? 'not_checked', quote: null, page: null, found: false, note: null })
      }
    }
    const sentences = [...bySentence.values()].sort((a, b) => a.start - b.start)
    const work: Work[] = []
    sentences.forEach((s, i) => {
      const keys = s.entries.filter((e) => e.reason === 'not_checked').map((e) => e.key).slice(0, MAX_KEYS_PER_SENTENCE)
      if (keys.length > 0) work.push({ index: i, keys })
    })
    return { sentences, work }
  }

  private keyIndex(): KeyIndex {
    const { cache } = this.deps
    return {
      papers: new Map(
        cache
          .listPapers()
          .filter((r) => !r.problem)
          .map((r) => [r.id, { hasText: r.text_status === 'ok' }])
      ),
      trashed: new Set(cache.trashedIds())
    }
  }

  /** Each sentence of the batch as Claude sees it, with each paper's best passages for it. */
  private async batchPrompt(text: string, sentences: CheckedSentence[], batch: Work[], finder: PassageFinder, signal?: AbortSignal): Promise<BatchSentence[]> {
    const pairs = batch.reduce((n, w) => n + w.keys.length, 0)
    const perPair = Math.max(1, Math.min(PASSAGES_PER_PAIR, Math.floor(MAX_BATCH_PASSAGE_CHARS / (pairs * WINDOW_CHARS))))
    const out: BatchSentence[] = []
    for (const [i, w] of batch.entries()) {
      const s = sentences[w.index]
      const claim = claimText(text, s)
      const query = claimText(text, s, '')
      const papers: BatchSentence['papers'] = []
      for (const key of w.keys) {
        signal?.throwIfAborted()
        const row = this.deps.cache.getPaper(key)
        papers.push({ key, title: row?.title ?? key, year: row?.year ?? null, passages: await finder.find(key, query, perPair, signal) })
      }
      out.push({ id: i + 1, claim, context: contextBefore(text, s.start), papers })
    }
    return out
  }

  /** Claude's verdicts onto the entries, each quote checked against the paper's text; pairs left unanswered say so. */
  private apply(sentences: CheckedSentence[], batch: Work[], verdicts: ParsedVerdict[], pagesOf: (id: string) => PageText[]): void {
    for (const [i, w] of batch.entries()) {
      const s = sentences[w.index]
      for (const key of w.keys) {
        const entry = s.entries.find((e) => e.key === key)!
        const v = verdicts.find((x) => x.sentence === i + 1 && x.paper === key)
        if (!v) {
          entry.reason = 'no_answer'
          continue
        }
        Object.assign(entry, verifiedEntry(v, pagesOf(key)))
      }
    }
  }
}

/** A verdict with its quote located in the paper (the chat's normalization); a quote too short to mean anything is not evidence. */
export function verifiedEntry(v: ParsedVerdict, pages: PageText[]): Omit<CheckEntry, 'key'> {
  if (!v.quote) return { verdict: v.verdict, reason: null, quote: null, page: null, found: false, note: v.note }
  const words = v.quote.split(/\s+/).filter(Boolean).length
  const located = words >= MIN_QUOTE_WORDS ? locateQuote(v.quote, pages, v.page) : { page: v.page, found: false }
  return { verdict: v.verdict, reason: null, quote: v.quote, page: located.page, found: located.found, note: v.note }
}

/** The sentence with each citation as `[cite: key, key]` (or replaced by `with`), whitespace collapsed. */
function claimText(text: string, s: CheckedSentence, withCitations?: string): string {
  let out = ''
  let at = s.start
  for (const c of s.citations) {
    out += text.slice(at, c.start) + (withCitations ?? `[cite: ${c.keys.join(', ')}]`)
    at = c.end
  }
  out += text.slice(at, s.end)
  return out.replace(/\s+/g, ' ').trim()
}

/** Up to CONTEXT_CHARS of text before `start`, from a word boundary. */
function contextBefore(text: string, start: number): string {
  const from = Math.max(0, start - CONTEXT_CHARS)
  let slice = text.slice(from, start)
  if (from > 0) slice = slice.replace(/^\S*\s/, '')
  return slice.replace(/\s+/g, ' ').trim()
}
