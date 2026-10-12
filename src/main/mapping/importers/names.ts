import type { Author } from '../../../shared/schemas'

/** Longer "names" are cut here before any parsing (a broken export can put a whole paragraph in one). */
export const MAX_NAME_LENGTH = 300
/** Authors kept per record. */
export const MAX_AUTHORS = 500

/** "P.", "M.R.", "J.-L.": initials, as Scopus writes them after the family name. */
const INITIALS = /^(?:\p{Lu}\.?-?)+$/u

/**
 * One author as any export writes it: "Family, Given" (BibTeX, RIS, Scopus full names, with Scopus's "(author id)"),
 * "Family I." (Scopus short names) or "Given Family" (IEEE Xplore). A single word is a family name.
 */
export function parseName(raw: string): Author | null {
  const s = raw
    .slice(0, MAX_NAME_LENGTH)
    .replace(/\(\s*\d+\s*\)/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^,+|,+$/g, '')
    .trim()
  if (!s) return null
  const comma = s.indexOf(',')
  if (comma >= 0) {
    const family = s.slice(0, comma).trim()
    const given = s.slice(comma + 1).trim()
    if (!family) return given ? { family: given } : null
    return given ? { family, given } : { family }
  }
  const parts = s.split(' ')
  if (parts.length === 1) return { family: s }
  let cut = parts.length
  while (cut > 1 && INITIALS.test(parts[cut - 1])) cut--
  if (cut < parts.length) return { family: parts.slice(0, cut).join(' '), given: parts.slice(cut).join(' ') }
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') }
}

/** The authors of a list joined by `separator`, at most MAX_AUTHORS. */
export function splitAuthors(raw: string, separator: RegExp): Author[] {
  return parseNames(raw.split(separator, MAX_AUTHORS * 4))
}

/** Each name parsed, empty ones dropped, at most MAX_AUTHORS. */
export function parseNames(names: Iterable<string>): Author[] {
  const out: Author[] = []
  for (const name of names) {
    const author = parseName(name)
    if (author) out.push(author)
    if (out.length >= MAX_AUTHORS) break
  }
  return out
}
