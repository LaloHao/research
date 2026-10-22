/**
 * «Estilo»: Claude's style suggestions for pasted text, checked and applied by the app. Pure: the main process validates
 * what Claude returned, the renderer applies what the user accepts, and a later API can do either.
 *
 * Rules (each suggestion is checked on its own, then against the others):
 * - `original` must occur verbatim (exact characters) in the text. When it occurs more than once (overlapping
 *   occurrences count), the suggestion must carry a `context`: a longer verbatim excerpt that occurs exactly once in the
 *   text and contains `original` exactly once; that occurrence is the one changed. Otherwise it is dropped as ambiguous
 *   (never «the first one»: a change in the wrong place is worse than none).
 * - The text with the suggestion applied keeps every protected construct exactly as written and in the same order,
 *   adding or removing none, and the edit changes the count of none of their delimiters (`%`, `$`, `{`, `}`):
 *   citations (the citation parser's), math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, math environments), LaTeX commands and
 *   escapes (`\emph`, `\%`), and whole for the commands whose argument is a reference or a name (`\ref`, `\label`,
 *   `\begin{…}`, `\url`…), the app's citation markers, Org links (`[[…]]`, `[[…][…]]`), macros (`{{{…}}}`) and, in
 *   Org, keyword lines (`#+…`). An `original` that cuts through one of them is dropped too.
 * - Overlapping suggestions: the one that starts first wins (on a tie, the one Claude listed first); the others are
 *   dropped. A suggestion equal to its original is dropped as unchanged.
 */
import { z } from 'zod'
import { CITATION_MARKER } from '../chatCitations'
import type { LlmModel } from '../summary'
import { parseCitations, type CiteFormat } from './citations'

/** The longest text «Estilo» reviews. */
export const MAX_STYLE_CHARS = 20_000
/** The most suggestions one review returns (more are invalid output). */
export const MAX_STYLE_SUGGESTIONS = 80
const MAX_ORIGINAL = 2000
const MAX_SUGGESTION = 3000
const MAX_REASON = 500
const MAX_CONTEXT = 4000

/** What the review looks at: claridad, concisión, registro académico, ortografía y gramática, coherencia. */
export const STYLE_FOCUSES = ['clarity', 'concision', 'register', 'grammar', 'coherence'] as const
export type StyleFocus = (typeof STYLE_FOCUSES)[number]

export const STYLE_DROP_REASONS = ['not_found', 'ambiguous', 'protected', 'overlap', 'unchanged'] as const
export type StyleDropReason = (typeof STYLE_DROP_REASONS)[number]

/** One suggestion as Claude returns it. */
export interface RawStyleSuggestion {
  original: string
  suggestion: string
  reason: string
  category: StyleFocus
  /** A longer verbatim excerpt around `original`, needed only when `original` occurs more than once. */
  context: string | null
}

/** A suggestion the app checked: where it applies (offsets of the reviewed text). */
export interface StyleSuggestion {
  /** Its position among the kept suggestions, in text order. */
  id: number
  start: number
  end: number
  original: string
  suggestion: string
  reason: string
  category: StyleFocus
}

export interface StyleReview {
  /** In text order, disjoint. */
  suggestions: StyleSuggestion[]
  dropped: Record<StyleDropReason, number>
}

export interface StyleRequest {
  text: string
  format: CiteFormat
  /** At least one; all by default in the window. */
  focus: StyleFocus[]
  model?: LlmModel
}

export interface StyleReviewRun extends StyleReview {
  costUsd: number
  model: string
}
export type StyleReviewResult = { ok: true; run: StyleReviewRun } | { ok: false; error: string }

// ---------------------------------------------------------------------------------------------------------------------
// Claude's output

const suggestionSchema = z.strictObject({
  original: z.string().min(1).max(MAX_ORIGINAL),
  suggestion: z.string().max(MAX_SUGGESTION),
  reason: z.string().trim().min(1).max(MAX_REASON),
  category: z.enum(STYLE_FOCUSES),
  context: z.string().min(1).max(MAX_CONTEXT).nullable()
})
const outputSchema = z.strictObject({ suggestions: z.array(suggestionSchema).max(MAX_STYLE_SUGGESTIONS) })

/** The JSON Schema the review's answer must satisfy (--json-schema). */
export function styleSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['suggestions'],
    properties: {
      suggestions: {
        type: 'array',
        maxItems: MAX_STYLE_SUGGESTIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['original', 'suggestion', 'reason', 'category', 'context'],
          properties: {
            original: { type: 'string', minLength: 1, maxLength: MAX_ORIGINAL },
            suggestion: { type: 'string', maxLength: MAX_SUGGESTION },
            reason: { type: 'string', minLength: 1, maxLength: MAX_REASON },
            category: { type: 'string', enum: [...STYLE_FOCUSES] },
            context: { type: ['string', 'null'], minLength: 1, maxLength: MAX_CONTEXT }
          }
        }
      }
    }
  }
}

/** Claude's answer, strictly: any extra field, wrong category or overlong string makes the whole answer invalid. */
export function parseStyleOutput(raw: unknown): { ok: true; suggestions: RawStyleSuggestion[] } | { ok: false; error: string } {
  const parsed = outputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  return { ok: true, suggestions: parsed.data.suggestions }
}

// ---------------------------------------------------------------------------------------------------------------------
// Where a suggestion applies

/** Every occurrence of `needle` in `text`, overlapping ones included. */
function occurrences(text: string, needle: string): number[] {
  const out: number[] = []
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** The occurrence of `original` a suggestion means, by the rules above. */
export function locateOriginal(text: string, original: string, context: string | null): { start: number; end: number } | 'not_found' | 'ambiguous' {
  if (!original) return 'not_found'
  const found = occurrences(text, original)
  if (found.length === 0) return 'not_found'
  if (found.length === 1) return { start: found[0], end: found[0] + original.length }
  if (!context) return 'ambiguous'
  const where = occurrences(text, context)
  const inside = occurrences(context, original)
  if (where.length !== 1 || inside.length !== 1) return 'ambiguous'
  const start = where[0] + inside[0]
  return { start, end: start + original.length }
}

// ---------------------------------------------------------------------------------------------------------------------
// Protected constructs

export interface Span {
  start: number
  end: number
}

/** Whether the character at `i` is escaped by an odd run of backslashes before it. */
function escaped(text: string, i: number): boolean {
  let n = 0
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++
  return n % 2 === 1
}

/** Matches of `re` (global) whose first character is not escaped; a skipped match lets the search resume one character on. */
function unescapedMatches(text: string, re: RegExp): Span[] {
  const out: Span[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (escaped(text, m.index)) {
      re.lastIndex = m.index + 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

const MATH_ENVS = ['equation', 'align', 'alignat', 'flalign', 'gather', 'multline', 'eqnarray', 'math', 'displaymath', 'split', 'dmath']
const MATH_ENV = new RegExp(`\\\\begin\\{(${MATH_ENVS.join('|')})(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}`, 'g')
const DISPLAY_BRACKETS = /\\\[[\s\S]*?\\\]/g
const INLINE_PARENS = /\\\([\s\S]*?\\\)/g
const DISPLAY_DOLLARS = /\$\$[\s\S]+?\$\$/g
/** Commands whose first argument is a reference, a label or a name, protected with their options and that argument. */
const ARGUMENT_COMMANDS = new Set([
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'cref',
  'Cref',
  'vref',
  'nameref',
  'label',
  'url',
  'href',
  'input',
  'include',
  'subfile',
  'includegraphics',
  'begin',
  'end',
  'bibliography',
  'addbibresource',
  'usepackage',
  'documentclass'
])
const COMMAND = /\\(?:[A-Za-z]+\*?|[^A-Za-z\s])/g
const ORG_LINK = /\[\[[^\]\n]+\](?:\[[^\n]*?\])?\]/g
const MACRO = /\{\{\{[\s\S]*?\}\}\}/g
const ORG_KEYWORD = /^[ \t]*#\+[^\n]*/gm

/** `$…$` as pandoc reads it: no space after the opening `$`, none before the closing one, no digit right after it. */
function inlineDollars(text: string): Span[] {
  const out: Span[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || escaped(text, i)) continue
    if (text[i + 1] === '$') {
      i++
      continue
    }
    if (!text[i + 1] || /\s/.test(text[i + 1])) continue
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\n' && text[j + 1] === '\n') break
      if (text[j] !== '$' || escaped(text, j)) continue
      if (!/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? '')) {
        out.push({ start: i, end: j + 1 })
        i = j
      }
      break
    }
  }
  return out
}

/** The end of a balanced `{…}` (or `[…]`) group opening at `i`, or -1. */
function groupEnd(text: string, i: number, open: string, close: string): number {
  if (text[i] !== open) return -1
  let depth = 0
  for (let k = i; k < text.length; k++) {
    if (escaped(text, k)) continue
    if (text[k] === open) depth++
    else if (text[k] === close && --depth === 0) return k + 1
  }
  return -1
}

/** LaTeX commands and escapes; those of ARGUMENT_COMMANDS with their `[…]` options and first `{…}` argument. */
function commands(text: string): Span[] {
  return unescapedMatches(text, COMMAND).map((s) => {
    const name = text.slice(s.start + 1, s.end).replace(/\*$/, '')
    if (!ARGUMENT_COMMANDS.has(name)) return s
    let end = s.end
    for (let opt = groupEnd(text, end, '[', ']'); opt > 0; opt = groupEnd(text, end, '[', ']')) end = opt
    const arg = groupEnd(text, end, '{', '}')
    return { start: s.start, end: arg > 0 ? arg : end }
  })
}

/** Sorted and merged: overlapping spans become one (a citation command and the command it is). */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Every protected construct of a text, as disjoint spans in order. */
export function protectedSpans(text: string, format: CiteFormat): Span[] {
  const spans: Span[] = [
    ...parseCitations(text, format).map((c) => ({ start: c.start, end: c.end })),
    ...[...text.matchAll(CITATION_MARKER)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
    ...unescapedMatches(text, MATH_ENV),
    ...unescapedMatches(text, DISPLAY_BRACKETS),
    ...unescapedMatches(text, INLINE_PARENS),
    ...unescapedMatches(text, DISPLAY_DOLLARS),
    ...inlineDollars(text),
    ...commands(text),
    ...[...text.matchAll(ORG_LINK)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
    ...[...text.matchAll(MACRO)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
    ...(format === 'org' ? [...text.matchAll(ORG_KEYWORD)].map((m) => ({ start: m.index, end: m.index + m[0].length })) : [])
  ]
  return merge(spans)
}

/** The characters whose count an edit must not change: they open or close math, groups and LaTeX comments. */
const DELIMITERS: Record<CiteFormat, readonly string[]> = { latex: ['%', '$', '{', '}'], org: ['%', '$', '{', '}'], markdown: ['$'] }

/** How many unescaped `ch` lie in `text[start, end)` (escapes judged on the whole text). */
function countUnescaped(text: string, start: number, end: number, ch: string): number {
  let n = 0
  for (let i = start; i < end; i++) if (text[i] === ch && !escaped(text, i)) n++
  return n
}

/**
 * Whether replacing `text[start, end)` by `suggestion` keeps every protected construct, judged on the result: the range
 * never cuts through one, the new text has exactly the same protected constructs, written the same and in the same
 * order (`kept`, the text's, as strings), and the edit adds or removes none of the characters that open or close them
 * (unescaped `%`, `$`, `{`, `}` in LaTeX and Org; `$` in Markdown), so a `%` cannot comment out a citation that follows,
 * nor a `$` or a brace swallow the text around it. `spans` are the text's.
 */
export function keepsProtected(text: string, spans: Span[], kept: readonly string[], start: number, end: number, suggestion: string, format: CiteFormat): boolean {
  for (const s of spans) {
    if (s.end <= start || s.start >= end) continue
    if (s.start < start || s.end > end) return false
  }
  const result = text.slice(0, start) + suggestion + text.slice(end)
  const after = start + suggestion.length
  if (DELIMITERS[format].some((ch) => countUnescaped(text, start, end, ch) !== countUnescaped(result, start, after, ch))) return false
  const now = protectedSpans(result, format)
  return now.length === kept.length && now.every((p, i) => result.slice(p.start, p.end) === kept[i])
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation and application

export function emptyDrops(): Record<StyleDropReason, number> {
  return Object.fromEntries(STYLE_DROP_REASONS.map((r) => [r, 0])) as Record<StyleDropReason, number>
}

/** Claude's suggestions checked against the text: the ones kept, in text order, and how many were dropped and why. */
export function validateStyleSuggestions(text: string, format: CiteFormat, raw: RawStyleSuggestion[]): StyleReview {
  const dropped = emptyDrops()
  const spans = protectedSpans(text, format)
  const kept = spans.map((p) => text.slice(p.start, p.end))
  const located: (Omit<StyleSuggestion, 'id'> & { order: number })[] = []
  raw.forEach((s, order) => {
    if (s.suggestion === s.original) {
      dropped.unchanged++
      return
    }
    const where = locateOriginal(text, s.original, s.context)
    if (where === 'not_found' || where === 'ambiguous') {
      dropped[where]++
      return
    }
    if (!keepsProtected(text, spans, kept, where.start, where.end, s.suggestion, format)) {
      dropped.protected++
      return
    }
    located.push({ start: where.start, end: where.end, original: s.original, suggestion: s.suggestion, reason: s.reason.trim(), category: s.category, order })
  })
  located.sort((a, b) => a.start - b.start || a.order - b.order)
  const suggestions: StyleSuggestion[] = []
  let reached = 0
  for (const { order: _order, ...s } of located) {
    if (s.start < reached) {
      dropped.overlap++
      continue
    }
    suggestions.push({ id: suggestions.length, ...s })
    reached = s.end
  }
  return { suggestions, dropped }
}

export function droppedCount(dropped: Record<StyleDropReason, number>): number {
  return STYLE_DROP_REASONS.reduce((n, r) => n + dropped[r], 0)
}

/** The text with the accepted suggestions applied (they are disjoint, so the order of acceptance does not matter). */
export function applyStyleSuggestions(text: string, suggestions: StyleSuggestion[], accepted: ReadonlySet<number>): string {
  return styleSegments(text, suggestions, accepted)
    .map((s) => (s.kind === 'text' ? s.text : s.accepted ? s.suggestion : s.original))
    .join('')
}

export type StyleSegment = { kind: 'text'; text: string } | { kind: 'change'; id: number; original: string; suggestion: string; accepted: boolean }

/** The text cut at each suggestion, for the diff view: unchanged stretches and each change with whether it is accepted. */
export function styleSegments(text: string, suggestions: StyleSuggestion[], accepted: ReadonlySet<number>): StyleSegment[] {
  const out: StyleSegment[] = []
  let cursor = 0
  for (const s of [...suggestions].sort((a, b) => a.start - b.start)) {
    if (s.start < cursor || text.slice(s.start, s.end) !== s.original) continue
    if (s.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, s.start) })
    out.push({ kind: 'change', id: s.id, original: s.original, suggestion: s.suggestion, accepted: accepted.has(s.id) })
    cursor = s.end
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) })
  return out
}
