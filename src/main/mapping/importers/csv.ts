/** Columns beyond this are ignored (real exports have a few dozen). */
export const MAX_CSV_COLUMNS = 512
/** Rows × header columns read at most, so a hostile file cannot build millions of row objects. */
const MAX_CSV_CELLS = 4_000_000

export interface CsvTable {
  header: string[]
  rows: Record<string, string>[]
  /** Set when rows were left unread (`maxRows` or the cell budget reached). */
  truncated?: true
}

/** `,`, `;` or tab: the one the first line uses most outside quotes (`,` on a tie or when it has none). */
function sniffDelimiter(src: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (let i = 0; i < src.length && i < 65_536; i++) {
    const c = src[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && (c === '\n' || c === '\r')) break
    else if (!quoted && c in counts) counts[c]++
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';'
  if (counts['\t'] > counts[',']) return '\t'
  return ','
}

/**
 * RFC 4180 CSV: quoted fields with doubled quotes and line breaks, CRLF, LF or CR, an optional UTF-8 BOM, and the
 * delimiter sniffed from the first line (`,`, `;` or tab). Blank lines are skipped; a short row reads its missing cells
 * as ''. A quote that never closes is read as a literal character up to the end of its line, so one broken cell does
 * not swallow the rest of the file. Values are trimmed; header names are the keys of each row. Linear in the input.
 */
export function parseCsv(text: string, options: { maxRows?: number } = {}): CsvTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = sniffDelimiter(src)
  const n = src.length
  const atLineEnd = (k: number): boolean => k >= n || src[k] === delimiter || src[k] === '\n' || src[k] === '\r'
  const lineEnd = (k: number): number => {
    while (!atLineEnd(k)) k++
    return k
  }
  let i = 0
  /** No `"` from here to the end (remembered, so many unclosed quotes never rescan the text). */
  let noQuoteFrom = n
  /** Next row, or null at the end of the text. Blank rows come back as []. */
  const nextRow = (): string[] | null => {
    if (i >= n) return null
    const row: string[] = []
    let blank = true
    for (;;) {
      let j = i
      while (j < n && (src[j] === ' ' || (src[j] === '\t' && delimiter !== '\t'))) j++
      let value: string | null = null
      if (src[j] === '"') {
        const parts: string[] = []
        let k = j + 1
        let closed = false
        while (k < noQuoteFrom) {
          const q = src.indexOf('"', k)
          if (q < 0) {
            noQuoteFrom = k
            break
          }
          parts.push(src.slice(k, q))
          if (src[q + 1] === '"') {
            parts.push('"')
            k = q + 2
            continue
          }
          k = q + 1
          closed = true
          break
        }
        if (closed) {
          const e = lineEnd(k)
          value = parts.join('') + src.slice(k, e)
          i = e
        }
      }
      if (value === null) {
        const e = lineEnd(i)
        value = src.slice(i, e)
        i = e
      }
      if (row.length < MAX_CSV_COLUMNS) row.push(value)
      if (blank && value.trim() !== '') blank = false
      if (i < n && src[i] === delimiter) {
        i++
        continue
      }
      if (src[i] === '\r' && src[i + 1] === '\n') i += 2
      else if (i < n) i++
      return blank ? [] : row
    }
  }

  let head: string[] | null = null
  while (head === null) {
    const row = nextRow()
    if (row === null) return { header: [], rows: [] }
    if (row.length > 0) head = row
  }
  const header = head.map((h) => h.trim())
  const budget = Math.floor(MAX_CSV_CELLS / Math.max(1, header.length))
  const maxRows = Math.min(options.maxRows ?? Number.POSITIVE_INFINITY, budget)
  const rows: Record<string, string>[] = []
  for (;;) {
    const cells = nextRow()
    if (cells === null) return { header, rows }
    if (cells.length === 0) continue
    if (rows.length >= maxRows) return { header, rows, truncated: true }
    rows.push(Object.fromEntries(header.map((h, k) => [h, (cells[k] ?? '').trim()])))
  }
}
