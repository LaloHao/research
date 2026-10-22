import type { CitationState } from '../chat'
import { parseCitations as parseMarkers, type CitationMarker } from '../chatCitations'
import type { CiteFormat } from './citations'

/** The LaTeX command a converted citation uses (natbib `\citep`, biblatex `\parencite`/`\autocite`, or plain `\cite`). */
export const LATEX_OUTPUT_COMMANDS = ['cite', 'parencite', 'citep', 'autocite'] as const
export type LatexOutputCommand = (typeof LATEX_OUTPUT_COMMANDS)[number]

const LATEX_SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}'
}

/** Prose made safe for LaTeX: `% & # _ $ { } ~ ^ \` escaped; accented letters stay as UTF-8. */
export function escapeLatex(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) => LATEX_SPECIAL[c])
}

/** One citation in the output syntax: `\cite[p.~3]{key}`, `[@key, p. 3]` or `[cite:@key p. 3]`. */
export function formatCitation(c: { key: string; page: number | string | null }, format: CiteFormat, command: LatexOutputCommand = 'cite'): string {
  const page = c.page === null || c.page === '' ? null : String(c.page)
  if (format === 'latex') return page ? `\\${command}[p.~${page}]{${c.key}}` : `\\${command}{${c.key}}`
  if (format === 'markdown') return page ? `[@${c.key}, p. ${page}]` : `[@${c.key}]`
  return page ? `[cite:@${c.key} p. ${page}]` : `[cite:@${c.key}]`
}

/** A comment line in the output format (LaTeX `%`, Org `#`); Markdown's is an inline HTML comment. */
export function commentLine(text: string, format: CiteFormat): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (format === 'latex') return `% ${one}`
  if (format === 'org') return `# ${one}`
  return `<!-- ${one.replace(/--/g, '- -')} -->`
}

/** How the app checked a marker (the chat's verification): only `found` counts as verified. */
export interface MarkerCheck {
  state: CitationState
  /** Where the quote was found (it may differ from the page the marker named). */
  page: number | null
}

export interface ConvertOptions {
  format: CiteFormat
  /** LaTeX only; `\cite` when absent. */
  latexCommand?: LatexOutputCommand
  /** Keep each verbatim quote as a comment next to its citation. */
  quotes?: boolean
  /**
   * The app's check of each marker, in the order the markers appear. A marker without a `found` check is never
   * converted silently: it keeps a «NO VERIFICADA» comment and is counted.
   */
  checks?: readonly (MarkerCheck | null | undefined)[]
}

export interface ConvertResult {
  text: string
  converted: number
  unverified: number
}

/** The marker's notes: its quote when asked for, and the «no verificada» flag. */
function notes(m: CitationMarker, verified: boolean, page: number | null, opts: ConvertOptions): string[] {
  const label = page === null ? m.paper : `${m.paper}, p. ${page}`
  const out: string[] = []
  if (!verified) out.push(opts.format === 'markdown' ? 'no verificada' : `NO VERIFICADA: ${label}`)
  if (opts.quotes) out.push(opts.format === 'markdown' ? `"${m.quote}"` : `${label}: "${m.quote}"`)
  return out
}

/**
 * The app's citation markers (`[[key|p. N|"quote"]]`) turned into LaTeX, Markdown or Org citations. In LaTeX the prose
 * around them is escaped (never the commands the conversion emits). Notes (quotes, unverified flags) go where the format
 * keeps them harmless: comment lines before the paragraph in LaTeX and Org (an Org comment line inside a paragraph
 * would split it), an inline HTML comment right after the citation in Markdown.
 */
export function convertMarkers(text: string, opts: ConvertOptions): ConvertResult {
  const markers = parseMarkers(text)
  const command = opts.latexCommand ?? 'cite'
  let unverified = 0
  // Paragraphs and the blank lines between them, so notes land before the paragraph they belong to.
  const parts = text.split(/(\n[ \t]*\n)/)
  let offset = 0
  let next = 0
  const out = parts.map((part, i) => {
    const start = offset
    offset += part.length
    if (i % 2 === 1) return part
    const end = start + part.length
    let body = ''
    let cursor = start
    const before: string[] = []
    while (next < markers.length && markers[next].start < end) {
      const m = markers[next]
      const check = opts.checks?.[next]
      const verified = check?.state === 'found'
      if (!verified) unverified++
      const page = verified ? check.page : m.page
      body += prose(text.slice(cursor, m.start), opts.format) + formatCitation({ key: m.paper, page }, opts.format, command)
      const n = notes(m, verified, page, opts)
      if (opts.format === 'markdown') body += n.map((note) => ` ${commentLine(note, 'markdown')}`).join('')
      else before.push(...n.map((note) => commentLine(note, opts.format)))
      cursor = m.end
      next++
    }
    body += prose(text.slice(cursor, end), opts.format)
    if (before.length === 0) return body
    // The notes go right above the paragraph's first line, after any leading newline of the part.
    const lead = /^\n*/.exec(body)![0]
    return `${lead}${before.join('\n')}\n${body.slice(lead.length)}`
  })
  return { text: out.join(''), converted: markers.length, unverified }
}

function prose(s: string, format: CiteFormat): string {
  return format === 'latex' ? escapeLatex(s) : s
}
