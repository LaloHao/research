import type { ReviewItem } from '../../shared/summary'

export interface ReviewCursor {
  items: ReviewItem[]
  index: number
}

const clamp = (index: number, items: ReviewItem[]): number => Math.min(Math.max(index, 0), Math.max(items.length - 1, 0))

export function next(c: ReviewCursor): ReviewCursor {
  return { items: c.items, index: clamp(c.index + 1, c.items) }
}

export function prev(c: ReviewCursor): ReviewCursor {
  return { items: c.items, index: clamp(c.index - 1, c.items) }
}

export function current(c: ReviewCursor): ReviewItem | null {
  return c.items[c.index] ?? null
}

const sameItem = (a: ReviewItem, b: ReviewItem): boolean => a.paperId === b.paperId && a.section === b.section && a.key === b.key

/** Removes the resolved item; the index then points at what became the next item, or the new last one. */
export function afterResolve(c: ReviewCursor, resolved: ReviewItem): ReviewCursor {
  const items = c.items.filter((it) => !sameItem(it, resolved))
  return { items, index: clamp(c.index, items) }
}

export function progressLabel(c: ReviewCursor): { position: number; total: number } {
  return { position: c.items.length === 0 ? 0 : c.index + 1, total: c.items.length }
}
