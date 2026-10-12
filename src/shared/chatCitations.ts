/**
 * Citation markers in Claude's answers: `[[key|p. N|"quote"]]`, or `[[key|"quote"]]` for text without pages. The quote
 * is verbatim paper text on one line, 1–1000 characters, and never contains `"]]` (which ends the marker) nor `[[`
 * (so a marker the model left unterminated never swallows the next one). Anything else is left as plain text.
 */
export const CITATION_MARKER = /\[\[([a-z][a-z0-9]*)(?:\|p\. ?([1-9][0-9]{0,4}))?\|"((?:(?!\[\[)[^\n]){1,1000}?)"\]\]/g

export interface CitationMarker {
  /** Offsets of the whole marker in the Markdown. */
  start: number
  end: number
  paper: string
  page: number | null
  quote: string
}

export function parseCitations(markdown: string): CitationMarker[] {
  return [...markdown.matchAll(CITATION_MARKER)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    paper: m[1],
    page: m[2] ? Number(m[2]) : null,
    quote: m[3]
  }))
}

/** The marker for a citation: whitespace collapsed, `"]]` (which would end it early) and `[[` broken up. */
export function citationMarker(c: { paper: string; page: number | null; quote: string }): string {
  const quote = c.quote.replace(/\s+/g, ' ').trim().replace(/"\]\]/g, '" ]]').replace(/\[\[/g, '[ [')
  return c.page === null ? `[[${c.paper}|"${quote}"]]` : `[[${c.paper}|p. ${c.page}|"${quote}"]]`
}

/** `key, p. N` (or `key`): the chip's text, and the bracket of the plain-text form. */
export function citationLabel(c: { paper: string; page: number | null }): string {
  return c.page === null ? c.paper : `${c.paper}, p. ${c.page}`
}

/** The answer with each marker as `"quote" [key, p. N]` («Copiar», notes, the history digest). */
export function citationsToText(markdown: string): string {
  return markdown.replace(CITATION_MARKER, (_m, paper: string, page: string | undefined, quote: string) => {
    return `"${quote}" [${citationLabel({ paper, page: page ? Number(page) : null })}]`
  })
}

/** The cited keys, each once, in order of first citation. */
export function citedPapers(markdown: string): string[] {
  return [...new Set(parseCitations(markdown).map((c) => c.paper))]
}
