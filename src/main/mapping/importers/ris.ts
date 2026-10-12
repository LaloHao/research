/** `XY  - value`: two-character tag, two spaces, a dash. */
const TAG = /^([A-Z][A-Z0-9]) {2}- ?([^]*)$/ // [^]: a value may hold U+2028/U+2029
/** A value stops growing here (continuation lines are dropped beyond it). */
export const MAX_RIS_VALUE = 100_000

/**
 * RIS entries from `TY` to `ER`, tag → values in order; a line without a tag continues the previous value. CRLF, LF or
 * CR line ends and a UTF-8 BOM are accepted; an entry the file leaves open is kept. At most `maxEntries`. Never throws.
 */
export function parseRis(text: string, maxEntries = Number.POSITIVE_INFINITY): Record<string, string[]>[] {
  const entries: Record<string, string[]>[] = []
  let current: Record<string, string[]> | null = null
  let last: string | null = null
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (const raw of src.split(/\r\n|\r|\n/)) {
    const line = raw.trimEnd()
    const m = TAG.exec(line)
    if (m) {
      const tag = m[1]
      const value = m[2].trim()
      if (tag === 'TY') {
        if (entries.length >= maxEntries) break
        current = {}
        entries.push(current)
      }
      if (!current) continue
      if (tag === 'ER') {
        current = null
        last = null
        continue
      }
      ;(current[tag] ??= []).push(value.slice(0, MAX_RIS_VALUE))
      last = tag
    } else if (current && last && line.trim()) {
      const values = current[last]
      const previous = values[values.length - 1]
      if (previous.length < MAX_RIS_VALUE) {
        const next = `${previous} ${line.trim()}`
        values[values.length - 1] = next.length > MAX_RIS_VALUE ? next.slice(0, MAX_RIS_VALUE) : next
      }
    }
  }
  return entries
}
