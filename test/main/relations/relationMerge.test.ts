import { describe, expect, it } from 'vitest'
import {
  applyChange,
  interleaveReview,
  mergeSuggestions,
  relationReviewItems,
  retype,
  reverse,
  revertChange,
  toEntry,
  typedEdges,
  viewsFor,
  withJustification,
  withStatus
} from '../../../src/main/relations/relationMerge'
import { InvalidEdit } from '../../../src/main/summary/merge'
import type { ReviewItem } from '../../../src/shared/summary'
import { DRAIN_ID, LOGHUB_ID } from '../../helpers/pair'
import { NOW, typedRelation } from '../../helpers/relations'

const origin = { model: 'claude-sonnet-5', at: NOW, prompt_version: 1, paper: LOGHUB_ID }

describe('toEntry', () => {
  it('stores a fresh suggestion with the analyzing paper, symmetric types in alphabetical order', () => {
    const entry = toEntry({ type: 'same_problem', from: LOGHUB_ID, to: DRAIN_ID, justification: 'j', evidence: [] }, origin)
    expect(entry).toEqual({
      id: 'he2017drain__zhu2020loghub__same_problem',
      type: 'same_problem',
      from: DRAIN_ID,
      to: LOGHUB_ID,
      status: 'suggested',
      edited: false,
      justification: 'j',
      evidence: [],
      origin,
      updated_at: NOW
    })
  })
})

describe('mergeSuggestions', () => {
  it("replaces only this paper's own unreviewed suggestions and never duplicates a reviewed, other-side or retyped id", () => {
    const confirmed = typedRelation({ type: 'uses_method_of', status: 'confirmed' })
    const rejected = typedRelation({ type: 'replicates', status: 'rejected' })
    const editedSuggestion = typedRelation({ type: 'compares_with', from: DRAIN_ID, to: LOGHUB_ID, edited: true })
    const ownStale = typedRelation({ type: 'contradicts' })
    const fromDrainRun = typedRelation({ type: 'same_problem', from: DRAIN_ID, to: LOGHUB_ID })
    const unrelated = typedRelation({ from: 'am2019x', to: 'zz2020y', type: 'same_problem' })
    const retyped = typedRelation({ from: 'am2019x', to: LOGHUB_ID, type: 'extends', status: 'confirmed', edited: true, replaced: ['am2019x__zhu2020loghub__replicates'] })
    const fresh = [
      typedRelation({ type: 'extends', updated_at: NOW }),
      typedRelation({ type: 'uses_method_of', updated_at: NOW }),
      typedRelation({ from: 'am2019x', to: LOGHUB_ID, type: 'replicates', updated_at: NOW, origin })
    ]
    const merged = mergeSuggestions([confirmed, rejected, editedSuggestion, ownStale, fromDrainRun, unrelated, retyped], LOGHUB_ID, fresh)
    expect(merged.map((r) => r.id)).toEqual([
      'am2019x__zhu2020loghub__extends',
      'am2019x__zz2020y__same_problem',
      'he2017drain__zhu2020loghub__compares_with',
      'he2017drain__zhu2020loghub__extends',
      'he2017drain__zhu2020loghub__replicates',
      'he2017drain__zhu2020loghub__same_problem',
      'he2017drain__zhu2020loghub__uses_method_of'
    ])
    expect(merged.find((r) => r.type === 'uses_method_of')).toEqual(confirmed)
    expect(merged.find((r) => r.type === 'same_problem' && r.from === DRAIN_ID)).toEqual(fromDrainRun)
  })
})

describe('status, type, direction and justification changes', () => {
  it('changes the status and stamps the time', () => {
    expect(withStatus(typedRelation(), 'confirmed', NOW)).toMatchObject({ status: 'confirmed', updated_at: NOW })
  })

  it('retyping confirms, marks edited and remembers every id it replaced', () => {
    const original = typedRelation()
    const once = retype(original, 'uses_method_of', NOW)
    expect(once).toMatchObject({ id: 'he2017drain__zhu2020loghub__uses_method_of', type: 'uses_method_of', status: 'confirmed', edited: true, replaced: [original.id] })
    expect(retype(once, 'compares_with', NOW)).toMatchObject({ from: DRAIN_ID, to: LOGHUB_ID, replaced: [original.id, once.id] })
  })

  it('reverses a directed relation and refuses a symmetric one', () => {
    expect(reverse(typedRelation(), NOW)).toMatchObject({ id: 'he2017drain__zhu2020loghub__extends', from: DRAIN_ID, to: LOGHUB_ID, status: 'confirmed', edited: true, updated_at: NOW })
    expect(() => reverse(typedRelation({ type: 'same_problem', from: DRAIN_ID, to: LOGHUB_ID }), NOW)).toThrow(InvalidEdit)
  })

  it('edits the justification, keeping the status, and refuses an empty one', () => {
    expect(withJustification(typedRelation(), '  Loghub reuses Drain.  ', NOW)).toMatchObject({ justification: 'Loghub reuses Drain.', status: 'suggested', edited: true, updated_at: NOW })
    expect(() => withJustification(typedRelation(), '   ', NOW)).toThrow(InvalidEdit)
    expect(() => withJustification(typedRelation(), 'x'.repeat(2001), NOW)).toThrow(InvalidEdit)
  })

  it('applies a change and refuses a missing entry or a taken id', () => {
    const a = typedRelation()
    const b = typedRelation({ type: 'uses_method_of', status: 'confirmed' })
    const change = { before: a, after: withStatus(a, 'rejected', NOW) }
    expect(applyChange([a, b], change).map((r) => r.status)).toEqual(['rejected', 'confirmed'])
    expect(() => applyChange([b], change)).toThrow(InvalidEdit)
    expect(() => applyChange([a, b], { before: a, after: retype(a, 'uses_method_of', NOW) })).toThrow(InvalidEdit)
  })

  it('undoes a change only while the entry is still what the change left', () => {
    const a = typedRelation()
    const change = { before: a, after: retype(a, 'uses_method_of', NOW) }
    const list = applyChange([a], change)
    expect(revertChange(list, change, '2026-10-10T13:00:00.000Z')).toEqual([{ ...a, updated_at: '2026-10-10T13:00:00.000Z' }])
    const later = applyChange(list, { before: change.after, after: withStatus(change.after, 'rejected', NOW) })
    expect(() => revertChange(later, change, NOW)).toThrow(InvalidEdit)
  })

  it('refuses an undo when anything else in the entry changed, even with the same status and timestamp', () => {
    const a = typedRelation()
    const change = { before: a, after: withStatus(a, 'confirmed', NOW) }
    const list = applyChange([a], change)
    const touched = [{ ...change.after, justification: 'Changed by hand.' }]
    expect(() => revertChange(touched, change, NOW)).toThrow(InvalidEdit)
    // The same instant spelled differently is still the same entry.
    const respelled = [{ ...change.after, updated_at: '2026-10-10T12:00:00Z' }]
    expect(revertChange(respelled, change, NOW)).toHaveLength(1)
    expect(revertChange(list, change, NOW)).toEqual([{ ...a, updated_at: NOW }])
  })
})

describe('views, review items and edges', () => {
  const suggested = typedRelation()
  const confirmed = typedRelation({ type: 'uses_method_of', status: 'confirmed' })
  const rejected = typedRelation({ from: 'am2019x', to: DRAIN_ID, type: 'same_problem', status: 'rejected' })

  it('groups the relations of a paper with the paper at the other end', () => {
    const papers = new Map([[LOGHUB_ID, { title: 'Loghub', year: 2020 }]])
    const views = viewsFor([suggested, confirmed, rejected], DRAIN_ID, papers)
    expect(views.suggested.map((r) => r.other)).toEqual([{ id: LOGHUB_ID, title: 'Loghub', year: 2020 }])
    expect(views.confirmed.map((r) => r.id)).toEqual([confirmed.id])
    expect(views.rejected.map((r) => r.other)).toEqual([{ id: 'am2019x', title: 'am2019x', year: null }])
  })

  it('files each suggestion under the first of its papers in the queue order and interleaves it after that paper summary items', () => {
    const rows = [
      { id: LOGHUB_ID, title: 'Loghub' },
      { id: DRAIN_ID, title: 'Drain' }
    ]
    const items = relationReviewItems([suggested, confirmed, rejected], rows)
    expect(items).toEqual([{ paperId: LOGHUB_ID, title: 'Loghub', section: 'relation', key: suggested.id }])
    const summary: ReviewItem[] = [
      { paperId: DRAIN_ID, title: 'Drain', section: 'fields', key: 'tldr' },
      { paperId: LOGHUB_ID, title: 'Loghub', section: 'fields', key: 'tldr' }
    ]
    expect(interleaveReview([LOGHUB_ID, DRAIN_ID], summary, items)).toEqual([summary[1], items[0], summary[0]])
  })

  it('draws suggested and confirmed relations as edges, directed unless symmetric', () => {
    expect(typedEdges([suggested, confirmed, rejected, typedRelation({ from: DRAIN_ID, to: LOGHUB_ID, type: 'same_problem' })])).toEqual([
      { id: suggested.id, source: LOGHUB_ID, target: DRAIN_ID, type: 'extends', status: 'suggested', directed: true },
      { id: confirmed.id, source: LOGHUB_ID, target: DRAIN_ID, type: 'uses_method_of', status: 'confirmed', directed: true },
      { id: 'he2017drain__zhu2020loghub__same_problem', source: DRAIN_ID, target: LOGHUB_ID, type: 'same_problem', status: 'suggested', directed: false }
    ])
  })
})
