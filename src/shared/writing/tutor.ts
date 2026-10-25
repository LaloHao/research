/**
 * The tutor: Claude reads the author's text and points, explains and asks, but never writes it. Pure: the main
 * process checks what Claude returned (here), the local API answers it to the editor.
 *
 * - `tutor`: issues in a passage, each with a verbatim excerpt, its kind, why it may weaken the text and one Socratic
 *   question. The answer has no field for a rewrite, and an issue whose explanation or question smuggles one in (a
 *   quoted span of 8 words or more that is not in the passage) is dropped and counted.
 * - `alternatives`: two or three other ways to phrase one sentence the author wrote, each saying what it changes
 *   (emphasis, order, rhythm…), so the author compares and chooses; each one keeps the sentence's citations, math and
 *   commands exactly (style.ts's protected constructs: the same ones, written the same, though an alternative may move
 *   them, since changing the order is one of the things it offers), or it is dropped.
 *
 * Excerpts are located in the author's text ignoring differences in whitespace (a line break where Claude wrote a
 * space), never ignoring any other character.
 */
import { z } from 'zod'
import type { LlmModel } from '../summary'
import type { CiteFormat } from './citations'
import { protectedSpans, type Span } from './style'

// ---------------------------------------------------------------------------------------------------------------------
// Locating an excerpt

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A pattern for `excerpt` where every run of whitespace matches any run of whitespace. */
function loosePattern(excerpt: string): RegExp | null {
  const words = excerpt.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return new RegExp(words.map(escapeRegExp).join('\\s+'), 'g')
}

/** Every occurrence of `excerpt` in `text` (whitespace-tolerant), as spans, overlapping ones included. */
export function looseOccurrences(text: string, excerpt: string): Span[] {
  const re = loosePattern(excerpt)
  if (!re) return []
  const out: Span[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length })
    re.lastIndex = m.index + 1
  }
  return out
}

/**
 * Where `excerpt` is in `text`: its only occurrence, or, when it occurs more than once, the one inside `context` (a
 * longer excerpt that occurs once and contains it once). `within` limits the search to a part of the text.
 */
export function locateExcerpt(text: string, excerpt: string, context: string | null, within?: Span): Span | 'not_found' | 'ambiguous' {
  const inside = (s: Span): boolean => !within || (s.start >= within.start && s.end <= within.end)
  const found = looseOccurrences(text, excerpt).filter(inside)
  if (found.length === 0) return 'not_found'
  if (found.length === 1) return found[0]
  if (!context) return 'ambiguous'
  const where = looseOccurrences(text, context).filter(inside)
  if (where.length !== 1) return 'ambiguous'
  const hits = found.filter((s) => s.start >= where[0].start && s.end <= where[0].end)
  return hits.length === 1 ? hits[0] : 'ambiguous'
}

// ---------------------------------------------------------------------------------------------------------------------
// Rewrites smuggled into an explanation

/** A quoted span this long (in words) that the author did not write reads as a rewrite. */
export const REWRITE_MIN_WORDS = 8
const QUOTED = /«([^»]*)»|"([^"]*)"|“([^”]*)”|‘([^’]*)’|'([^']*)'/g
const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Whether `note` quotes REWRITE_MIN_WORDS or more words in a row that are not, in that order, in `original`. */
export function quotesRewrite(note: string, original: string): boolean {
  const source = ` ${wordsOf(original).join(' ')} `
  for (const m of note.matchAll(QUOTED)) {
    const quoted = wordsOf(m.slice(1).find((g) => g !== undefined) ?? '')
    if (quoted.length >= REWRITE_MIN_WORDS && !source.includes(` ${quoted.join(' ')} `)) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------------
// tutor

/** The longest passage the tutor reads at once. */
export const MAX_TUTOR_CHARS = 8000
export const MAX_TUTOR_ISSUES = 30
const MAX_EXCERPT = 600
const MAX_CONTEXT = 1500
export const MAX_TUTOR_EXPLANATION = 300
export const MAX_TUTOR_QUESTION = 200

/**
 * What the tutor points at: ambigüedad, salto lógico, conector, sujeto perdido, registro, cohesión, ritmo, precisión.
 */
export const TUTOR_KINDS = ['ambiguity', 'logical_gap', 'connector', 'lost_subject', 'register', 'cohesion', 'rhythm', 'precision'] as const
export type TutorKind = (typeof TUTOR_KINDS)[number]

export const TUTOR_DROP_REASONS = ['not_found', 'ambiguous', 'rewrite'] as const
export type TutorDropReason = (typeof TUTOR_DROP_REASONS)[number]

export interface RawTutorIssue {
  excerpt: string
  context: string | null
  kind: TutorKind
  explanation: string
  question: string
}

/** An issue the app located in the passage. */
export interface TutorIssue {
  start: number
  end: number
  excerpt: string
  kind: TutorKind
  explanation: string
  question: string
}

export interface TutorRequest {
  text: string
  format: CiteFormat
  model?: LlmModel
}

export interface TutorReview {
  /** In text order. */
  issues: TutorIssue[]
  dropped: Record<TutorDropReason, number>
}

export interface TutorRun extends TutorReview {
  costUsd: number
  model: string
}

const tutorOutput = z.strictObject({
  issues: z
    .array(
      z.strictObject({
        excerpt: z.string().min(1).max(MAX_EXCERPT),
        context: z.string().min(1).max(MAX_CONTEXT).nullable(),
        kind: z.enum(TUTOR_KINDS),
        explanation: z.string().trim().min(1).max(MAX_TUTOR_EXPLANATION),
        question: z.string().trim().min(1).max(MAX_TUTOR_QUESTION)
      })
    )
    .max(MAX_TUTOR_ISSUES)
})

/** The JSON Schema of the tutor's answer (--json-schema): no field holds a rewrite. */
export function tutorSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['issues'],
    properties: {
      issues: {
        type: 'array',
        maxItems: MAX_TUTOR_ISSUES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['excerpt', 'context', 'kind', 'explanation', 'question'],
          properties: {
            excerpt: { type: 'string', minLength: 1, maxLength: MAX_EXCERPT },
            context: { type: ['string', 'null'], minLength: 1, maxLength: MAX_CONTEXT },
            kind: { type: 'string', enum: [...TUTOR_KINDS] },
            explanation: { type: 'string', minLength: 1, maxLength: MAX_TUTOR_EXPLANATION },
            question: { type: 'string', minLength: 1, maxLength: MAX_TUTOR_QUESTION }
          }
        }
      }
    }
  }
}

/** Claude's answer, strictly: an extra field (a rewrite among them), a wrong kind or an overlong text makes it invalid. */
export function parseTutorOutput(raw: unknown): { ok: true; value: RawTutorIssue[] } | { ok: false; error: string } {
  const parsed = tutorOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  return { ok: true, value: parsed.data.issues }
}

const emptyTutorDrops = (): Record<TutorDropReason, number> => ({ not_found: 0, ambiguous: 0, rewrite: 0 })

/** The issues located in the passage (verbatim excerpt, unique or with its context) and without a rewrite. */
export function validateTutorIssues(text: string, raw: RawTutorIssue[]): TutorReview {
  const dropped = emptyTutorDrops()
  const issues: TutorIssue[] = []
  for (const issue of raw) {
    const where = locateExcerpt(text, issue.excerpt, issue.context)
    if (where === 'not_found' || where === 'ambiguous') {
      dropped[where]++
      continue
    }
    if (quotesRewrite(issue.explanation, text) || quotesRewrite(issue.question, text)) {
      dropped.rewrite++
      continue
    }
    issues.push({ ...where, excerpt: text.slice(where.start, where.end), kind: issue.kind, explanation: issue.explanation.trim(), question: issue.question.trim() })
  }
  issues.sort((a, b) => a.start - b.start || a.end - b.end)
  return { issues, dropped }
}

// ---------------------------------------------------------------------------------------------------------------------
// alternatives

/** The longest sentence and context paragraph `alternatives` takes. */
export const MAX_ALTERNATIVES_SENTENCE = 600
export const MAX_ALTERNATIVES_CONTEXT = 4000
const MAX_ALTERNATIVE_TEXT = 1200
export const MAX_WHAT_CHANGES = 200

/** What an alternative changes: énfasis, orden, ritmo, concisión, registro, precisión, enlace con lo anterior. */
export const ALTERNATIVE_ASPECTS = ['emphasis', 'order', 'rhythm', 'concision', 'register', 'precision', 'connection'] as const
export type AlternativeAspect = (typeof ALTERNATIVE_ASPECTS)[number]

export const ALTERNATIVE_DROP_REASONS = ['unchanged', 'protected', 'duplicate', 'too_long'] as const
export type AlternativeDropReason = (typeof ALTERNATIVE_DROP_REASONS)[number]

export interface Alternative {
  text: string
  aspect: AlternativeAspect
  what_changes: string
}

export interface AlternativesRequest {
  sentence: string
  /** The paragraph around it, read for context only. */
  context: string | null
  format: CiteFormat
  model?: LlmModel
}

export interface AlternativesReview {
  alternatives: Alternative[]
  dropped: Record<AlternativeDropReason, number>
}

export interface AlternativesRun extends AlternativesReview {
  costUsd: number
  model: string
}

const alternativesOutput = z.strictObject({
  alternatives: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(MAX_ALTERNATIVE_TEXT),
        aspect: z.enum(ALTERNATIVE_ASPECTS),
        what_changes: z.string().trim().min(1).max(MAX_WHAT_CHANGES)
      })
    )
    .min(2)
    .max(3)
})

export function alternativesSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['alternatives'],
    properties: {
      alternatives: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'aspect', 'what_changes'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_ALTERNATIVE_TEXT },
            aspect: { type: 'string', enum: [...ALTERNATIVE_ASPECTS] },
            what_changes: { type: 'string', minLength: 1, maxLength: MAX_WHAT_CHANGES }
          }
        }
      }
    }
  }
}

export function parseAlternativesOutput(raw: unknown): { ok: true; value: Alternative[] } | { ok: false; error: string } {
  const parsed = alternativesOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  return { ok: true, value: parsed.data.alternatives }
}

/** An alternative may be a little longer than the sentence, never a paragraph in its place. */
export const maxAlternativeLength = (sentence: string): number => Math.ceil(sentence.trim().length * 1.6) + 40

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ')

/** The characters that open or close math, groups and comments: an alternative must have as many of each. */
const DELIMITERS = ['%', '$', '{', '}']
const count = (s: string, ch: string): number => s.split(ch).length - 1

/**
 * Whether `alternative` has exactly the protected constructs of `sentence` (the same strings, as many times; their
 * order may change) and as many `%`, `$` and braces, so it cannot comment out, swallow or break one.
 */
export function sameProtected(sentence: string, alternative: string, format: CiteFormat): boolean {
  const of = (text: string): string[] =>
    protectedSpans(text, format)
      .map((s) => text.slice(s.start, s.end))
      .sort()
  const a = of(sentence)
  const b = of(alternative)
  return a.length === b.length && a.every((x, i) => x === b[i]) && DELIMITERS.every((ch) => count(sentence, ch) === count(alternative, ch))
}

/**
 * The alternatives worth showing: each different from the sentence and from the others, not much longer, and keeping
 * every protected construct of the sentence exactly as written (`sameProtected`).
 */
export function validateAlternatives(sentence: string, format: CiteFormat, raw: Alternative[]): AlternativesReview {
  const dropped: Record<AlternativeDropReason, number> = { unchanged: 0, protected: 0, duplicate: 0, too_long: 0 }
  const original = sentence.trim()
  const seen = new Set<string>([squash(original)])
  const alternatives: Alternative[] = []
  for (const alt of raw) {
    const text = alt.text.trim()
    if (squash(text) === squash(original)) {
      dropped.unchanged++
      continue
    }
    if (seen.has(squash(text))) {
      dropped.duplicate++
      continue
    }
    if (text.length > maxAlternativeLength(original)) {
      dropped.too_long++
      continue
    }
    if (!sameProtected(original, text, format)) {
      dropped.protected++
      continue
    }
    seen.add(squash(text))
    alternatives.push({ text, aspect: alt.aspect, what_changes: alt.what_changes.trim() })
  }
  return { alternatives, dropped }
}
