interface Paragraph {
  text: string
  start: number
}

export interface PassageSegment {
  text: string
  marked: boolean
}

/** Splits `text` into paragraphs on blank lines (one or more, `\n` or `\r\n`), keeping a single
 * line break as part of a paragraph's own text, and trimming a leading/trailing run of blank
 * lines from the whole passage. Each paragraph keeps its offset in the original `text`. */
function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  const blankLine = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = blankLine.exec(text))) {
    paragraphs.push({ text: text.slice(last, m.index), start: last })
    last = m.index + m[0].length
  }
  paragraphs.push({ text: text.slice(last), start: last })

  // Trim a leading/trailing blank-only edge (whitespace that didn't already form a full blank-line
  // separator above, e.g. the passage itself starts or ends with a newline), adjusting offsets.
  const first = paragraphs[0]
  const leading = first.text.match(/^[ \t\r\n]+/)
  if (leading) paragraphs[0] = { text: first.text.slice(leading[0].length), start: first.start + leading[0].length }
  const lastParagraph = paragraphs[paragraphs.length - 1]
  const trailing = lastParagraph.text.match(/[ \t\r\n]+$/)
  if (trailing) paragraphs[paragraphs.length - 1] = { text: lastParagraph.text.slice(0, -trailing[0].length), start: lastParagraph.start }

  // Drop paragraphs left empty by the trims above (but never the last one, so an all-blank
  // passage still yields a single empty paragraph instead of an empty array).
  while (paragraphs.length > 1 && paragraphs[0].text === '') paragraphs.shift()
  while (paragraphs.length > 1 && paragraphs[paragraphs.length - 1].text === '') paragraphs.pop()
  return paragraphs
}

/** The slice of `paragraph.text` covered by `match` (offsets in the full passage), split into
 * unmarked/marked/unmarked segments (either side is omitted when empty). */
function segmentsFor(paragraph: Paragraph, match: { start: number; end: number } | null): PassageSegment[] {
  if (!match) return [{ text: paragraph.text, marked: false }]
  const paragraphEnd = paragraph.start + paragraph.text.length
  const start = Math.max(match.start, paragraph.start) - paragraph.start
  const end = Math.min(match.end, paragraphEnd) - paragraph.start
  if (start >= end) return [{ text: paragraph.text, marked: false }]
  const segments: PassageSegment[] = []
  if (start > 0) segments.push({ text: paragraph.text.slice(0, start), marked: false })
  segments.push({ text: paragraph.text.slice(start, end), marked: true })
  if (end < paragraph.text.length) segments.push({ text: paragraph.text.slice(end), marked: false })
  return segments
}

/**
 * Splits `passage` into paragraphs (on blank lines) and, within each, the segments of text
 * covered by `match` (offsets in `passage`) versus not — so a match spanning a paragraph break
 * comes back marked in every paragraph it touches.
 */
export function paragraphSegments(passage: string, match: { start: number; end: number } | null): PassageSegment[][] {
  return splitParagraphs(passage).map((p) => segmentsFor(p, match))
}
