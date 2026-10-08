import type { Author } from './schemas'

export function authorsLabel(authors: Author[]): string {
  if (authors.length === 0) return ''
  if (authors.length === 1) return authors[0].family
  if (authors.length === 2) return `${authors[0].family} & ${authors[1].family}`
  return `${authors[0].family} et al.`
}
