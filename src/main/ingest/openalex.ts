import type { Author } from '../../shared/schemas'

/** "https://openalex.org/W123" → "W123"; ids are always stored bare. */
export function bareOpenAlexId(id: string): string {
  return id.trim().replace(/^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?/i, '')
}

/** OpenAlex gives names as display strings: the last word is taken as the family name. */
export function authorFromDisplayName(name: string): Author {
  const parts = name.trim().split(/\s+/)
  const family = parts.pop() ?? name.trim()
  return parts.length ? { family, given: parts.join(' ') } : { family }
}

/** Lowercase, without accents or punctuation: two titles are the same paper's when this is equal. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
