import type { Author } from '../../../shared/schemas'

/** Longer "names" are cut here before any parsing (a broken export can put a whole paragraph in one). */
export const MAX_NAME_LENGTH = 300
/** Authors kept per record. */
export const MAX_AUTHORS = 500

/** "P.", "M.R.", "J.-L.": dotted initials. */
const DOTTED = /^(?:\p{Lu}\.-?)+$/u
/** Initials after a family name: dotted, or one or two capitals ("J", "MR"), so "SMITH" is never taken for initials. */
const TRAILING_INITIALS = /^(?:(?:\p{Lu}\.-?)+|\p{Lu}{1,2})$/u
/** "Jr.", "Sr.", "III": the middle part of "Family, Jr., Given". */
const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i
/** "van", "de", "von": a lowercase word before the last one starts the family name ("Ludwig van Beethoven"). */
const PARTICLE = /^\p{Ll}/u

/**
 * One author as any export writes it: "Family, Given" (BibTeX, RIS, Scopus full names, with Scopus's "(author id)"),
 * "Family, Jr., Given" (BibTeX), "Family I." (Scopus short names) or "Given Family" (IEEE Xplore, with "J." initials
 * first and lowercase particles kept in the family name). A single word is a family name.
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
    let family = s.slice(0, comma).trim()
    let given = s.slice(comma + 1).trim()
    const second = given.indexOf(',')
    if (second >= 0 && SUFFIX.test(given.slice(0, second).trim())) {
      family = `${family} ${given.slice(0, second).trim()}`.trim()
      given = given.slice(second + 1).trim()
    }
    if (!family) return given ? { family: given } : null
    return given ? { family, given } : { family }
  }
  const parts = s.split(' ')
  if (parts.length === 1) return { family: s }
  // "J. YU", "M. R. Lyu": dotted initials first mean "Given Family".
  let lead = 0
  while (lead < parts.length - 1 && DOTTED.test(parts[lead])) lead++
  if (lead > 0) return { family: parts.slice(lead).join(' '), given: parts.slice(0, lead).join(' ') }
  let cut = parts.length
  while (cut > 1 && TRAILING_INITIALS.test(parts[cut - 1])) cut--
  if (cut < parts.length) return { family: parts.slice(0, cut).join(' '), given: parts.slice(cut).join(' ') }
  let start = parts.length - 1
  while (start > 1 && PARTICLE.test(parts[start - 1])) start--
  return { family: parts.slice(start).join(' '), given: parts.slice(0, start).join(' ') }
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
