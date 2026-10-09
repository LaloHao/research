import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import type { ExtractionForm } from '../../src/shared/summary'
import {
  DRAFT_ISSUE_CODES,
  addFacet,
  addValue,
  draftFromForm,
  formFromDraft,
  isDirty,
  removeAlias,
  removeFacet,
  removeValue,
  replaceFacet,
  updateFacet,
  validateDraft,
  validateNewValue,
  type FormDraft
} from '../../src/renderer/lib/formDraft'

function form(): ExtractionForm {
  return {
    facets: [
      { key: 'dataset_public', type: 'single', description: 'Is the dataset public?', values: ['yes', 'no'] },
      { key: 'methods_used', type: 'multi', description: 'Methods used', values: ['survey', 'interview'] },
      { key: 'rigor', type: 'scale', description: 'Methodological rigor', min: 1, max: 5 },
      { key: 'notes', type: 'text', description: 'Free notes' }
    ],
    value_aliases: { dataset_public: { maybe: 'yes' }, methods_used: { poll: 'survey' } }
  }
}

function draft(): FormDraft {
  return {
    facets: [
      { id: 'a', facet: { key: 'dataset_public', type: 'single', description: 'Is the dataset public?', values: ['yes', 'no'] } },
      { id: 'b', facet: { key: 'methods_used', type: 'multi', description: 'Methods used', values: ['survey', 'interview'] } },
      { id: 'c', facet: { key: 'rigor', type: 'scale', description: 'Methodological rigor', min: 1, max: 5 } },
      { id: 'd', facet: { key: 'notes', type: 'text', description: 'Free notes' } }
    ],
    value_aliases: { dataset_public: { maybe: 'yes' }, methods_used: { poll: 'survey' } }
  }
}

describe('draftFromForm / formFromDraft', () => {
  it('round-trips a form, assigning a distinct id to each facet', () => {
    const f = form()
    const d = draftFromForm(f)
    expect(d.facets).toHaveLength(f.facets.length)
    const ids = new Set(d.facets.map((x) => x.id))
    expect(ids.size).toBe(f.facets.length)
    expect(formFromDraft(d)).toEqual(f)
  })
})

describe('addFacet', () => {
  it('appends a new facet under a fresh id by default', () => {
    const next = addFacet(draft(), { key: 'novel', type: 'text', description: 'desc' })
    expect(next.facets.map((f) => f.facet.key)).toEqual(['dataset_public', 'methods_used', 'rigor', 'notes', 'novel'])
    expect(next.facets.at(-1)?.id).not.toBe('')
  })

  it('accepts an explicit id', () => {
    const next = addFacet(draft(), { key: 'novel', type: 'text', description: 'desc' }, 'new-1')
    expect(next.facets.at(-1)).toEqual({ id: 'new-1', facet: { key: 'novel', type: 'text', description: 'desc' } })
  })
})

describe('replaceFacet', () => {
  it('swaps the facet definition but keeps the id', () => {
    const next = replaceFacet(draft(), 'c', { key: 'rigor', type: 'text', description: 'Methodological rigor' })
    expect(next.facets.find((f) => f.id === 'c')).toEqual({ id: 'c', facet: { key: 'rigor', type: 'text', description: 'Methodological rigor' } })
  })
})

describe('removeFacet', () => {
  it('drops the facet by id and its aliases', () => {
    const next = removeFacet(draft(), 'a')
    expect(next.facets.map((f) => f.id)).toEqual(['b', 'c', 'd'])
    expect(next.value_aliases.dataset_public).toBeUndefined()
    expect(next.value_aliases.methods_used).toEqual({ poll: 'survey' })
  })

  it('leaves other facets and their aliases untouched', () => {
    const next = removeFacet(draft(), 'd')
    expect(next.value_aliases).toEqual(draft().value_aliases)
  })
})

describe('updateFacet', () => {
  it('patches a field on the matching facet only, addressed by id', () => {
    const next = updateFacet(draft(), 'c', { description: 'New description' })
    expect(next.facets.find((f) => f.id === 'c')?.facet.description).toBe('New description')
    expect(next.facets.find((f) => f.id === 'a')?.facet.description).toBe('Is the dataset public?')
  })

  it('renaming a facet keeps its id stable, so later actions still address it', () => {
    const renamed = updateFacet(draft(), 'a', { key: 'dataset_open' })
    expect(renamed.facets.find((f) => f.id === 'a')?.facet.key).toBe('dataset_open')
    const next = updateFacet(renamed, 'a', { description: 'desc2' })
    expect(next.facets.find((f) => f.id === 'a')?.facet).toMatchObject({ key: 'dataset_open', description: 'desc2' })
  })

  it('patches scale min/max', () => {
    const next = updateFacet(draft(), 'c', { min: 0, max: 10 })
    expect(next.facets.find((f) => f.id === 'c')?.facet).toMatchObject({ min: 0, max: 10 })
  })
})

describe('addValue', () => {
  it('appends a value to a single/multi facet, addressed by id', () => {
    const next = addValue(draft(), 'b', 'experiment')
    expect(next.facets.find((f) => f.id === 'b')?.facet).toMatchObject({ values: ['survey', 'interview', 'experiment'] })
  })
})

describe('removeValue', () => {
  it('removes the value and drops aliases pointing to it', () => {
    const next = removeValue(draft(), 'a', 'yes')
    expect(next.facets.find((f) => f.id === 'a')?.facet).toMatchObject({ values: ['no'] })
    expect(next.value_aliases.dataset_public).toBeUndefined()
  })

  it('keeps aliases that still point to a remaining value', () => {
    const base = draft()
    base.value_aliases.methods_used = { poll: 'survey', questionnaire: 'survey' }
    const next = removeValue(base, 'b', 'interview')
    expect(next.value_aliases.methods_used).toEqual({ poll: 'survey', questionnaire: 'survey' })
  })
})

describe('removeAlias', () => {
  it('removes a single learned alias', () => {
    const next = removeAlias(draft(), 'dataset_public', 'maybe')
    expect(next.value_aliases.dataset_public).toBeUndefined()
  })

  it('keeps other aliases on the same facet', () => {
    const base = draft()
    base.value_aliases.dataset_public = { maybe: 'yes', perhaps: 'yes' }
    const next = removeAlias(base, 'dataset_public', 'maybe')
    expect(next.value_aliases.dataset_public).toEqual({ perhaps: 'yes' })
  })
})

describe('isDirty', () => {
  it('is false for an unchanged draft, even with different key order', () => {
    const saved = form()
    const d = draftFromForm(saved)
    expect(isDirty(saved, d)).toBe(false)
  })

  it('is true once a field changes', () => {
    const saved = form()
    const base = draftFromForm(saved)
    const d = updateFacet(base, base.facets[2].id, { description: 'Changed' })
    expect(isDirty(saved, d)).toBe(true)
  })

  it('ignores a facet renamed back to its original key (same content, different id history)', () => {
    const saved = form()
    const base = draftFromForm(saved)
    const renamed = updateFacet(base, base.facets[0].id, { key: 'temp' })
    const back = updateFacet(renamed, renamed.facets[0].id, { key: 'dataset_public' })
    expect(isDirty(saved, back)).toBe(false)
  })
})

describe('validateDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateDraft(draft())).toEqual({})
  })

  it('flags an empty key as required, a malformed key as key_format, keyed by id', () => {
    const empty = updateFacet(draft(), 'a', { key: '' })
    expect(validateDraft(empty)['facets.a.key']).toBe('required')
    const malformed = updateFacet(draft(), 'a', { key: 'Bad Key' })
    expect(validateDraft(malformed)['facets.a.key']).toBe('key_format')
  })

  it('flags duplicate keys on both facets', () => {
    const dup = updateFacet(draft(), 'b', { key: 'dataset_public' })
    expect(validateDraft(dup)['facets.a.key']).toBe('key_duplicate')
    expect(validateDraft(dup)['facets.b.key']).toBe('key_duplicate')
  })

  it('flags an empty description as required', () => {
    const next = updateFacet(draft(), 'a', { description: '  ' })
    expect(validateDraft(next)['facets.a.description']).toBe('required')
  })

  it('flags single/multi facets with no values', () => {
    const next = updateFacet(draft(), 'a', { values: [] })
    expect(validateDraft(next)['facets.a.values']).toBe('values_required')
  })

  it('flags a malformed or duplicated value', () => {
    const malformed = updateFacet(draft(), 'a', { values: ['Bad Value'] })
    expect(validateDraft(malformed)['facets.a.values']).toBe('value_format')
    const duped = updateFacet(draft(), 'a', { values: ['yes', 'yes'] })
    expect(validateDraft(duped)['facets.a.values']).toBe('value_duplicate')
  })

  it('flags a scale whose min is above its max', () => {
    const next = updateFacet(draft(), 'c', { min: 9 })
    expect(validateDraft(next)['facets.c.max']).toBe('scale_order')
  })

  it('flags non-integer scale bounds', () => {
    const next = updateFacet(draft(), 'c', { min: 1.5 })
    expect(validateDraft(next)['facets.c.min']).toBe('not_integer')
  })

  it('keeps pointing at the right facet after one is removed', () => {
    const withBadB = updateFacet(draft(), 'b', { key: '' })
    const afterRemovingA = removeFacet(withBadB, 'a')
    expect(validateDraft(afterRemovingA)['facets.b.key']).toBe('required')
    expect(validateDraft(afterRemovingA)['facets.a.key']).toBeUndefined()
  })
})

describe('validateNewValue', () => {
  it('accepts a value not already present', () => {
    expect(validateNewValue(['yes', 'no'], 'maybe')).toBeUndefined()
  })
  it('rejects an empty value', () => {
    expect(validateNewValue(['yes'], '  ')).toBe('required')
  })
  it('rejects a badly formatted value', () => {
    expect(validateNewValue(['yes'], 'Not Snake')).toBe('value_format')
  })
  it('rejects a duplicate value', () => {
    expect(validateNewValue(['yes', 'no'], 'yes')).toBe('value_duplicate')
  })
})

describe('every draft issue code has a Spanish message', () => {
  const issues = es.settings.form_editor.issues as Record<string, unknown>
  it.each(DRAFT_ISSUE_CODES)('%s', (code) => {
    expect(typeof issues[code]).toBe('string')
  })
})
