import type { Author } from '../../shared/schemas'

const STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'with', 'from', 'by', 'at', 'as', 'is', 'are',
  'towards', 'toward', 'via', 'using', 'into', 'its', 'our', 'we', 'how', 'what', 'why', 'when', 'do', 'does', 'can',
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'para', 'por', 'con', 'y', 'o', 'die', 'der', 'das'
])

export function asciiFold(s: string): string {
  return s
    .replace(/ß/g, 'ss')
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Øø]/g, 'o')
    .replace(/[Łł]/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

const slug = (s: string): string => asciiFold(s).replace(/[^a-z0-9]/g, '')

/** `<family><year|nd><first significant title word>`, lowercase ASCII, starting with a letter. */
export function baseCitekey(input: { authors: Author[]; year?: number; title: string; site?: string }): string {
  const who = slug(input.authors[0]?.family ?? input.site ?? '').replace(/^[0-9]+/, '') || 'anon'
  const year = input.year !== undefined ? String(input.year) : 'nd'
  const word = input.title.split(/\s+/).map(slug).find((w) => w.length > 0 && !STOPWORDS.has(w)) ?? ''
  return `${who}${year}${word}`
}

export function uniqueCitekey(base: string, isTaken: (id: string) => boolean): string {
  if (!isTaken(base)) return base
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (const a of letters) if (!isTaken(base + a)) return base + a
  for (const a of letters) for (const b of letters) if (!isTaken(base + a + b)) return base + a + b
  throw new Error(`No free citation key for ${base}`)
}
