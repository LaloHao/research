import type { PrismaColumn, PrismaCounts, PrismaSource } from '../../shared/mapping'

/** Every text of the diagram, already translated (the component builds them with `t`). */
export interface PrismaLabels {
  databases: string
  other: string
  stages: { identification: string; screening: string; included: string }
  identified: string
  source(s: PrismaSource): string
  duplicates(n: number): string
  screened(n: number, pending: number): string
  excludedScreening(n: number): string
  sought(n: number): string
  notRetrieved(n: number): string
  assessed(n: number, pending: number): string
  excludedFullText: string
  reason(criterion: string, n: number): string
  included(n: number): string
}

export interface PrismaDiagram {
  svg: string
  width: number
  height: number
}

/** Fixed print colors: the diagram goes into documents, whatever the app's theme. */
const INK = '#1c1b1a'
const MUTED = '#6b6966'
const FILL = '#f3f2f0'
const LINE = 16
const PAD = 10
const CHAR_W = 6.6
const MAIN_W = 250
const SIDE_W = 240
const GAP_X = 28
const GAP_Y = 34
const MARGIN = 16
const STAGE_W = 24

/** Characters XML 1.0 does not allow (C0 controls but tab and newlines, lone surrogates, U+FFFE/U+FFFF). */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Text as XML character data: names and titles come from the user's files, so the SVG must stay well-formed. */
const esc = (s: string): string =>
  s.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** Words in lines of at most `max` characters; a word longer than a line (a URL, say) is cut into pieces. */
export function wrap(text: string, max: number): string[] {
  const width = Math.max(1, max)
  const lines: string[] = []
  let line = ''
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      const chars = Array.from(word)
      return Array.from({ length: Math.ceil(chars.length / width) }, (_, i) => chars.slice(i * width, (i + 1) * width).join(''))
    })
  for (const word of words) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

interface Box {
  x: number
  y: number
  w: number
  h: number
  lines: string[]
  head: boolean
}

function box(x: number, w: number, paragraphs: string[], head = false): Box {
  const lines = paragraphs.flatMap((p) => wrap(p, Math.floor((w - 2 * PAD) / CHAR_W)))
  return { x, y: 0, w, h: lines.length * LINE + 2 * PAD, lines, head }
}

/** Each row of a column: the main box and the box beside it (what left the flow at that step). */
function columnRows(c: PrismaColumn, l: PrismaLabels, mainX: number, sideX: number): [Box, Box][] {
  return [
    [box(mainX, MAIN_W, [l.identified, ...c.identified.map((s) => l.source(s))]), box(sideX, SIDE_W, [l.duplicates(c.duplicates)])],
    [box(mainX, MAIN_W, [l.screened(c.screened, c.pendingScreening)]), box(sideX, SIDE_W, [l.excludedScreening(c.excludedScreening)])],
    [box(mainX, MAIN_W, [l.sought(c.sought)]), box(sideX, SIDE_W, [l.notRetrieved(c.notRetrieved)])],
    [box(mainX, MAIN_W, [l.assessed(c.assessed, c.pendingFullText)]), box(sideX, SIDE_W, [l.excludedFullText, ...c.excludedFullText.map((r) => l.reason(r.criterion, r.count))])]
  ]
}

function drawBox(b: Box): string {
  const text = b.lines
    .map((line, i) => `<text x="${b.x + PAD}" y="${b.y + PAD + (i + 1) * LINE - 4}" font-size="12"${b.head ? ' font-weight="600"' : ''} fill="${INK}">${esc(line)}</text>`)
    .join('')
  return `<rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${b.head ? FILL : '#ffffff'}" stroke="${INK}"/>${text}`
}

const arrow = (x1: number, y1: number, x2: number, y2: number): string => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" marker-end="url(#arrow)"/>`

function stage(top: number, bottom: number, label: string): string {
  const cx = MARGIN + STAGE_W / 2 + 4
  const cy = (top + bottom) / 2
  return (
    `<rect class="stage" x="${MARGIN}" y="${top}" width="${STAGE_W}" height="${bottom - top}" rx="4" fill="${FILL}" stroke="${MUTED}"/>` +
    `<text x="${cx}" y="${cy}" font-size="12" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${cx} ${cy})">${esc(label)}</text>`
  )
}

/**
 * The PRISMA 2020 flow diagram as SVG text: the database column and the other-methods column side by side, each with
 * identification, screening, retrieval and eligibility, both flowing into the included studies. Sizes grow with the
 * text; the result is shown as an image and exported as is (or rasterized to PNG).
 */
export function prismaSvg(counts: PrismaCounts, labels: PrismaLabels): PrismaDiagram {
  const c1 = MARGIN + STAGE_W + 12
  const s1 = c1 + MAIN_W + GAP_X
  const c2 = s1 + SIDE_W + GAP_X * 2
  const s2 = c2 + MAIN_W + GAP_X
  const width = s2 + SIDE_W + MARGIN
  const headers = [box(c1, MAIN_W + GAP_X + SIDE_W, [labels.databases], true), box(c2, MAIN_W + GAP_X + SIDE_W, [labels.other], true)]
  let y = MARGIN
  for (const h of headers) h.y = y
  y += Math.max(...headers.map((h) => h.h)) + GAP_Y / 2
  const columns = [columnRows(counts.databases, labels, c1, s1), columnRows(counts.other, labels, c2, s2)]
  const tops: number[] = []
  const bottoms: number[] = []
  for (let r = 0; r < columns[0].length; r++) {
    const row = columns.flatMap((rows) => rows[r])
    for (const b of row) b.y = y
    tops.push(y)
    y += Math.max(...row.map((b) => b.h))
    bottoms.push(y)
    y += GAP_Y
  }
  const included = box(c1, c2 + MAIN_W - c1, [labels.included(counts.included)])
  included.y = y
  const height = y + included.h + MARGIN

  const parts = [
    stage(tops[0], bottoms[0], labels.stages.identification),
    stage(tops[1], bottoms[bottoms.length - 1], labels.stages.screening),
    stage(included.y, included.y + included.h, labels.stages.included)
  ]
  for (const b of [...headers, ...columns.flat(2), included]) parts.push(drawBox(b))
  for (const rows of columns) {
    rows.forEach(([main, side], r) => {
      const cx = main.x + main.w / 2
      const ay = main.y + Math.min(main.h, side.h) / 2
      parts.push(arrow(main.x + main.w, ay, side.x, ay))
      parts.push(arrow(cx, main.y + main.h, cx, r < rows.length - 1 ? rows[r + 1][0].y : included.y))
    })
  }
  const marker = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker></defs>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">${marker}<rect width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`
  return { svg, width, height }
}
