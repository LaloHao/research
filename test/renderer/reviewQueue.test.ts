import { describe, expect, it } from 'vitest'
import type { ReviewItem } from '../../src/shared/summary'
import { afterResolve, current, next, prev, progressLabel, type ReviewCursor } from '../../src/renderer/lib/reviewQueue'

const item = (paperId: string, key: string): ReviewItem => ({ paperId, title: `Title ${paperId}`, section: 'fields', key })

const items: ReviewItem[] = [item('p1', 'tldr'), item('p2', 'method'), item('p3', 'results')]

describe('reviewQueue', () => {
  it('next stays at the last item when already at the end', () => {
    const c: ReviewCursor = { items, index: 2 }
    expect(next(c)).toEqual({ items, index: 2 })
  })

  it('next advances the index', () => {
    const c: ReviewCursor = { items, index: 0 }
    expect(next(c)).toEqual({ items, index: 1 })
  })

  it('prev stays at the first item when already at the start', () => {
    const c: ReviewCursor = { items, index: 0 }
    expect(prev(c)).toEqual({ items, index: 0 })
  })

  it('prev moves the index back', () => {
    const c: ReviewCursor = { items, index: 2 }
    expect(prev(c)).toEqual({ items, index: 1 })
  })

  it('current returns the item at the index, or null when empty', () => {
    expect(current({ items, index: 1 })).toEqual(items[1])
    expect(current({ items: [], index: 0 })).toBeNull()
  })

  it('afterResolve removes the resolved item in the middle and keeps the index pointing at the next item', () => {
    const c: ReviewCursor = { items, index: 1 }
    const result = afterResolve(c, items[1])
    expect(result.items).toEqual([items[0], items[2]])
    expect(result.index).toBe(1)
    expect(current(result)).toEqual(items[2])
  })

  it('afterResolve removes the resolved item at the end and points to the new last item', () => {
    const c: ReviewCursor = { items, index: 2 }
    const result = afterResolve(c, items[2])
    expect(result.items).toEqual([items[0], items[1]])
    expect(result.index).toBe(1)
    expect(current(result)).toEqual(items[1])
  })

  it('afterResolve on the last remaining item leaves an empty queue', () => {
    const c: ReviewCursor = { items: [items[0]], index: 0 }
    const result = afterResolve(c, items[0])
    expect(result.items).toEqual([])
    expect(current(result)).toBeNull()
  })

  it('progressLabel reports a 1-based position and the total', () => {
    expect(progressLabel({ items, index: 0 })).toEqual({ position: 1, total: 3 })
    expect(progressLabel({ items, index: 2 })).toEqual({ position: 3, total: 3 })
    expect(progressLabel({ items: [], index: 0 })).toEqual({ position: 0, total: 0 })
  })
})
