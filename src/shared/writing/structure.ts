/**
 * The structure of a section or chapter, for the tutor's structural reads: its headings and prose paragraphs (split by
 * the app, so their offsets are the app's, never Claude's), the reverse outline (each paragraph's main idea and what
 * may be wrong with it) and the coverage of the thesis' research questions per heading. Pure.
 *
 * A paragraph is a run of prose lines; a blank line or a line that is not prose ends it. Not prose: headings (Org `*`,
 * Markdown `#`, LaTeX `\section`…), Org keyword lines (`#+…`), comment lines (`# `, `%`), drawers, Org blocks and
 * LaTeX environments that hold no prose (source, examples, exports, math, figures, tables, verbatim), tables, fixed-
 * width lines, Markdown code fences and lines holding only a LaTeX command.
 */
import { z } from 'zod'
import type { LlmModel } from '../summary'
import type { CiteFormat } from './citations'
import { looseOccurrences } from './tutor'

export interface ProseParagraph {
  /** 1-based, in text order across the whole text. */
  index: number
  start: number
  end: number
  text: string
}

export interface ProseSection {
  /** `S1`, `S2`… in text order. */
  id: string
  /** The heading's text; null for the prose before the first heading. */
  heading: string | null
  /** 1 for `*`, `#` or `\chapter`/`\section`… relative depth; 0 without heading. */
  level: number
  /** From the heading line (or the text's start) to the next heading (or the end). */
  start: number
  end: number
  paragraphs: ProseParagraph[]
}

const SKIPPED_BLOCKS = new Set(['src', 'example', 'export', 'comment', 'quote', 'verse'])
const SKIPPED_ENVS = new Set([
  'equation',
  'align',
  'gather',
  'multline',
  'eqnarray',
  'displaymath',
  'math',
  'figure',
  'table',
  'tabular',
  'tabularx',
  'longtable',
  'lstlisting',
  'verbatim',
  'minted',
  'tikzpicture',
  'algorithm',
  'algorithmic',
  'comment'
])
const LATEX_LEVELS: Record<string, number> = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }

/** The heading a line is, in any of the three formats (Org and Markdown only in their own format). */
function headingOf(line: string, format: CiteFormat): { level: number; text: string } | null {
  if (format === 'org') {
    const m = /^(\*+)\s+(.*?)\s*$/.exec(line)
    if (m) return { level: m[1].length, text: cleanHeading(m[2]) }
  }
  if (format === 'markdown') {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m) return { level: m[1].length, text: m[2] }
  }
  const latex = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{(.*)\}\s*$/.exec(line)
  if (latex) return { level: LATEX_LEVELS[latex[1]], text: latex[2] }
  return null
}

/** An Org heading without its TODO keyword, priority and tags. */
function cleanHeading(text: string): string {
  return text
    .replace(/^(?:TODO|DONE|NEXT|WAIT|HOLD|CANCELLED)\s+/, '')
    .replace(/^\[#[A-Z]\]\s+/, '')
    .replace(/\s+:[\w@#%:]+:\s*$/, '')
    .trim()
}

const NOT_PROSE = [
  /^\s*$/,
  /^\s*#\+/,
  /^\s*#(?:\s|$)/,
  /^\s*%/,
  /^\s*\|/,
  /^\s*\+-/,
  /^\s*:(?:\s|$)/,
  /^\s*(?:CLOSED|DEADLINE|SCHEDULED):/,
  /^\s*\\[a-zA-Z]+\*?(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})*\s*$/
]

/** The text split into sections (by heading) and prose paragraphs. A section without paragraphs is kept (it may be a parent heading). */
export function splitSections(text: string, format: CiteFormat): ProseSection[] {
  const sections: ProseSection[] = []
  let current: ProseSection = { id: '', heading: null, level: 0, start: 0, end: text.length, paragraphs: [] }
  let paragraph: { start: number; end: number } | null = null
  let close: RegExp | null = null
  let index = 0
  const flush = (): void => {
    if (!paragraph) return
    index++
    current.paragraphs.push({ index, start: paragraph.start, end: paragraph.end, text: text.slice(paragraph.start, paragraph.end) })
    paragraph = null
  }
  const lineRe = /[^\n]*(?:\n|$)/g
  for (let m = lineRe.exec(text); m && m.index < text.length; m = lineRe.exec(text)) {
    const start = m.index
    const raw = m[0]
    const line = raw.replace(/\n$/, '')
    const end = start + line.length
    if (raw.length === 0) break
    let prose = false
    if (close) {
      if (close.test(line)) close = null
    } else {
      const heading = headingOf(line, format)
      const block = /^\s*#\+begin_(\w+)/i.exec(line)
      const env = /^\s*\\begin\{([a-zA-Z]+)\*?\}/.exec(line)
      const drawer = /^\s*:([\w-]+):\s*$/.exec(line)
      if (heading) {
        flush()
        current.end = start
        if (current.heading !== null || current.paragraphs.length > 0) sections.push(current)
        current = { id: '', heading: heading.text, level: heading.level, start, end: text.length, paragraphs: [] }
      } else if (block) {
        if (SKIPPED_BLOCKS.has(block[1].toLowerCase())) close = new RegExp(`^\\s*#\\+end_${block[1]}\\b`, 'i')
      } else if (env) {
        if (SKIPPED_ENVS.has(env[1]) && !new RegExp(`\\\\end\\{${env[1]}\\*?\\}`).test(line)) close = new RegExp(`\\\\end\\{${env[1]}\\*?\\}`)
      } else if (drawer && drawer[1].toUpperCase() !== 'END' && format === 'org') {
        close = /^\s*:END:\s*$/i
      } else if (/^\s*```/.test(line) && format === 'markdown') {
        close = /^\s*```/
      } else if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) {
        close = /\$\$/
      } else if (/^\s*\\\[/.test(line) && !/\\\]/.test(line)) {
        close = /\\\]/
      } else if (!NOT_PROSE.some((re) => re.test(line))) {
        prose = true
      }
    }
    if (prose) {
      if (paragraph && /^\s*(?:[-+*]|\d+[.)])\s/.test(line) && format !== 'latex') flush()
      if (paragraph) paragraph.end = end
      else paragraph = { start, end }
    } else {
      flush()
    }
  }
  flush()
  if (current.heading !== null || current.paragraphs.length > 0) sections.push(current)
  sections.forEach((s, i) => (s.id = `S${i + 1}`))
  return sections
}

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length

// ---------------------------------------------------------------------------------------------------------------------
// reverse_outline

export const MAX_REVERSE_OUTLINE_CHARS = 20_000
export const MAX_REVERSE_OUTLINE_PARAGRAPHS = 120
export const MAX_MAIN_IDEA_WORDS = 20
const MAX_MAIN_IDEA = 240
export const MAX_FLAG_NOTE = 200

/** dos ideas en un párrafo, falta la transición con el anterior, se aparta del encabezado. */
export const PARAGRAPH_FLAGS = ['two_ideas', 'missing_transition', 'off_topic'] as const
export type ParagraphFlag = (typeof PARAGRAPH_FLAGS)[number]

export interface ReverseOutlineRequest {
  text: string
  format: CiteFormat
  model?: LlmModel
}

export interface OutlinedParagraph {
  index: number
  start: number
  end: number
  heading: string | null
  main_idea: string
  flags: { flag: ParagraphFlag; note: string }[]
}

export interface ReverseOutline {
  paragraphs: OutlinedParagraph[]
  /** `off_topic` on a paragraph without a heading to be off: dropped. */
  dropped: { off_topic_without_heading: number }
}

export interface ReverseOutlineRun extends ReverseOutline {
  costUsd: number
  model: string
}

interface RawOutlined {
  n: number
  main_idea: string
  flags: { flag: ParagraphFlag; note: string }[]
}

const reverseOutlineOutput = z.strictObject({
  paragraphs: z.array(
    z.strictObject({
      n: z.number().int().min(1),
      main_idea: z.string().trim().min(1).max(MAX_MAIN_IDEA),
      flags: z.array(z.strictObject({ flag: z.enum(PARAGRAPH_FLAGS), note: z.string().trim().min(1).max(MAX_FLAG_NOTE) })).max(PARAGRAPH_FLAGS.length)
    })
  )
})

export function reverseOutlineSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['paragraphs'],
    properties: {
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['n', 'main_idea', 'flags'],
          properties: {
            n: { type: 'integer', minimum: 1 },
            main_idea: { type: 'string', minLength: 1, maxLength: MAX_MAIN_IDEA },
            flags: {
              type: 'array',
              maxItems: PARAGRAPH_FLAGS.length,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['flag', 'note'],
                properties: { flag: { type: 'string', enum: [...PARAGRAPH_FLAGS] }, note: { type: 'string', minLength: 1, maxLength: MAX_FLAG_NOTE } }
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Claude's reverse outline, strictly: exactly one entry per paragraph sent (by its number), each main idea at most
 * MAX_MAIN_IDEA_WORDS words. Anything else is invalid (asked again once).
 */
export function parseReverseOutline(raw: unknown, count: number): { ok: true; value: RawOutlined[] } | { ok: false; error: string } {
  const parsed = reverseOutlineOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  const seen = new Set<number>()
  for (const p of parsed.data.paragraphs) {
    if (p.n > count) return { ok: false, error: `Paragraph ${p.n} does not exist: there are ${count}.` }
    if (seen.has(p.n)) return { ok: false, error: `Paragraph ${p.n} appears twice.` }
    seen.add(p.n)
    if (countWords(p.main_idea) > MAX_MAIN_IDEA_WORDS) return { ok: false, error: `The main idea of paragraph ${p.n} has more than ${MAX_MAIN_IDEA_WORDS} words.` }
  }
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !seen.has(n))
  if (missing.length > 0) return { ok: false, error: `Missing paragraphs: ${missing.join(', ')}.` }
  return { ok: true, value: parsed.data.paragraphs }
}

/** The outline in paragraph order with the app's offsets; a repeated flag is kept once. */
export function buildReverseOutline(sections: ProseSection[], raw: RawOutlined[]): ReverseOutline {
  const byIndex = new Map(raw.map((r) => [r.n, r]))
  const dropped = { off_topic_without_heading: 0 }
  const paragraphs: OutlinedParagraph[] = []
  for (const section of sections) {
    for (const p of section.paragraphs) {
      const r = byIndex.get(p.index)
      if (!r) continue
      const flags: OutlinedParagraph['flags'] = []
      for (const f of r.flags) {
        if (flags.some((g) => g.flag === f.flag)) continue
        if (f.flag === 'off_topic' && section.heading === null) {
          dropped.off_topic_without_heading++
          continue
        }
        flags.push({ flag: f.flag, note: f.note.trim() })
      }
      paragraphs.push({ index: p.index, start: p.start, end: p.end, heading: section.heading, main_idea: r.main_idea.trim(), flags })
    }
  }
  return { paragraphs, dropped }
}

// ---------------------------------------------------------------------------------------------------------------------
// rq_coverage

export const MAX_RQ_COVERAGE_CHARS = 40_000
export const MAX_RQ_COVERAGE_SECTIONS = 80
const MAX_EVIDENCE = 300
const MAX_ADDRESSES = 10

export interface RqCoverageRequest {
  text: string
  format: CiteFormat
  model?: LlmModel
}

export interface SectionCoverage {
  id: string
  heading: string | null
  start: number
  end: number
  addresses: { rq: string; excerpt: string; start: number; end: number }[]
}

export interface RqCoverage {
  /** Every section with prose, in text order. */
  sections: SectionCoverage[]
  /** The research questions no section addresses with verified evidence, in the thesis' order. */
  not_addressed: string[]
  /** Evidence not found verbatim in its section (its claim is dropped). */
  dropped: { not_found: number }
}

export interface RqCoverageRun extends RqCoverage {
  costUsd: number
  model: string
}

interface RawCoverage {
  id: string
  addresses: { rq: string; excerpt: string }[]
}

const rqCoverageOutput = z.strictObject({
  sections: z.array(
    z.strictObject({
      id: z.string().regex(/^S[1-9][0-9]*$/),
      addresses: z.array(z.strictObject({ rq: z.string().regex(/^RQ[1-9][0-9]*$/), excerpt: z.string().min(1).max(MAX_EVIDENCE) })).max(MAX_ADDRESSES)
    })
  )
})

export function rqCoverageSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['sections'],
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'addresses'],
          properties: {
            id: { type: 'string', pattern: '^S[1-9][0-9]*$' },
            addresses: {
              type: 'array',
              maxItems: MAX_ADDRESSES,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['rq', 'excerpt'],
                properties: { rq: { type: 'string', pattern: '^RQ[1-9][0-9]*$' }, excerpt: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE } }
              }
            }
          }
        }
      }
    }
  }
}

/** Claude's coverage, strictly: exactly the sections sent, once each, and only the research questions sent. */
export function parseRqCoverage(raw: unknown, sectionIds: readonly string[], questionIds: readonly string[]): { ok: true; value: RawCoverage[] } | { ok: false; error: string } {
  const parsed = rqCoverageOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  const seen = new Set<string>()
  for (const s of parsed.data.sections) {
    if (!sectionIds.includes(s.id)) return { ok: false, error: `${s.id} is not a section id.` }
    if (seen.has(s.id)) return { ok: false, error: `${s.id} appears twice.` }
    seen.add(s.id)
    const unknown = s.addresses.find((a) => !questionIds.includes(a.rq))
    if (unknown) return { ok: false, error: `${unknown.rq} is not one of the research questions.` }
  }
  const missing = sectionIds.filter((id) => !seen.has(id))
  if (missing.length > 0) return { ok: false, error: `Missing sections: ${missing.join(', ')}.` }
  return { ok: true, value: parsed.data.sections }
}

/** The coverage with each excerpt verified inside its own section (whitespace-tolerant); one claim per question and section. */
export function buildRqCoverage(text: string, sections: ProseSection[], raw: RawCoverage[], questionIds: readonly string[]): RqCoverage {
  const byId = new Map(raw.map((r) => [r.id, r]))
  let notFound = 0
  const addressed = new Set<string>()
  const out: SectionCoverage[] = []
  for (const s of sections) {
    const r = byId.get(s.id)
    if (!r) continue
    const addresses: SectionCoverage['addresses'] = []
    for (const a of r.addresses) {
      if (addresses.some((b) => b.rq === a.rq)) continue
      // Evidence only has to be in its section: when it occurs there several times, the first one is shown.
      const span = looseOccurrences(text, a.excerpt).find((o) => o.start >= s.start && o.end <= s.end)
      if (!span) {
        notFound++
        continue
      }
      addresses.push({ rq: a.rq, excerpt: text.slice(span.start, span.end), start: span.start, end: span.end })
      addressed.add(a.rq)
    }
    out.push({ id: s.id, heading: s.heading, start: s.start, end: s.end, addresses })
  }
  return { sections: out, not_addressed: questionIds.filter((q) => !addressed.has(q)), dropped: { not_found: notFound } }
}

