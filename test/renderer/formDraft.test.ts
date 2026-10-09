import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import type { ExtractionForm } from '../../src/shared/summary'
import {
  DRAFT_ISSUE_CODES,
  addFacet,
  addValue,
  isDirty,
  removeAlias,
  removeFacet,
  removeValue,
  updateFacet,
  validateDraft,
  validateNewValue
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

describe('addFacet', () => {
  it('appends a new facet', () => {
    const next = addFacet(form(), { key: 'novel', type: 'text', description: 'desc' })
    expect(next.facets.map((f) => f.key)).toEqual(['dataset_public', 'methods_used', 'rigor', 'notes', 'novel'])
  })
})

describe('removeFacet', () => {
  it('drops the facet and its aliases', () => {
    const next = removeFacet(form(), 'dataset_public')
    expect(next.facets.map((f) => f.key)).toEqual(['methods_used', 'rigor', 'notes'])
    expect(next.value_aliases.dataset_public).toBeUndefined()
    expect(next.value_aliases.methods_used).toEqual({ poll: 'survey' })
  })

  it('leaves other facets and their aliases untouched', () => {
    const next = removeFacet(form(), 'notes')
    expect(next.value_aliases).toEqual(form().value_aliases)
  })
})

describe('updateFacet', () => {
  it('patches a field on the matching facet only', () => {
    const next = updateFacet(form(), 'rigor', { description: 'New description' })
    const rigor = next.facets.find((f) => f.key === 'rigor')
    expect(rigor?.description).toBe('New description')
    expect(next.facets.find((f) => f.key === 'dataset_public')?.description).toBe('Is the dataset public?')
  })

  it('patches scale min/max', () => {
    const next = updateFacet(form(), 'rigor', { min: 0, max: 10 })
    expect(next.facets.find((f) => f.key === 'rigor')).toMatchObject({ min: 0, max: 10 })
  })
})

describe('addValue', () => {
  it('appends a value to a single/multi facet', () => {
    const next = addValue(form(), 'methods_used', 'experiment')
    expect(next.facets.find((f) => f.key === 'methods_used')).toMatchObject({ values: ['survey', 'interview', 'experiment'] })
  })
})

describe('removeValue', () => {
  it('removes the value and drops aliases pointing to it', () => {
    const next = removeValue(form(), 'dataset_public', 'yes')
    expect(next.facets.find((f) => f.key === 'dataset_public')).toMatchObject({ values: ['no'] })
    expect(next.value_aliases.dataset_public).toBeUndefined()
  })

  it('keeps aliases that still point to a remaining value', () => {
    const base = form()
    base.value_aliases.methods_used = { poll: 'survey', questionnaire: 'survey' }
    const next = removeValue(base, 'methods_used', 'interview')
    expect(next.value_aliases.methods_used).toEqual({ poll: 'survey', questionnaire: 'survey' })
  })
})

describe('removeAlias', () => {
  it('removes a single learned alias', () => {
    const next = removeAlias(form(), 'dataset_public', 'maybe')
    expect(next.value_aliases.dataset_public).toBeUndefined()
  })

  it('keeps other aliases on the same facet', () => {
    const base = form()
    base.value_aliases.dataset_public = { maybe: 'yes', perhaps: 'yes' }
    const next = removeAlias(base, 'dataset_public', 'maybe')
    expect(next.value_aliases.dataset_public).toEqual({ perhaps: 'yes' })
  })
})

describe('isDirty', () => {
  it('is false for an unchanged draft, even with different key order', () => {
    const saved = form()
    const draft: ExtractionForm = { value_aliases: saved.value_aliases, facets: saved.facets }
    expect(isDirty(saved, draft)).toBe(false)
  })

  it('is true once a field changes', () => {
    const saved = form()
    const draft = updateFacet(saved, 'rigor', { description: 'Changed' })
    expect(isDirty(saved, draft)).toBe(true)
  })
})

describe('validateDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateDraft(form())).toEqual({})
  })

  it('flags an empty key as required, a malformed key as key_format', () => {
    const base = form()
    base.facets[0].key = ''
    expect(validateDraft(base)['facets.0.key']).toBe('required')
    const base2 = form()
    base2.facets[0].key = 'Bad Key'
    expect(validateDraft(base2)['facets.0.key']).toBe('key_format')
  })

  it('flags duplicate keys', () => {
    const base = form()
    base.facets[1].key = 'dataset_public'
    expect(validateDraft(base)['facets.0.key']).toBe('key_duplicate')
    expect(validateDraft(base)['facets.1.key']).toBe('key_duplicate')
  })

  it('flags an empty description as required', () => {
    const base = form()
    base.facets[0].description = '  '
    expect(validateDraft(base)['facets.0.description']).toBe('required')
  })

  it('flags single/multi facets with no values', () => {
    const base = form()
    ;(base.facets[0] as { values: string[] }).values = []
    expect(validateDraft(base)['facets.0.values']).toBe('values_required')
  })

  it('flags a malformed or duplicated value', () => {
    const base = form()
    ;(base.facets[0] as { values: string[] }).values = ['Bad Value']
    expect(validateDraft(base)['facets.0.values']).toBe('value_format')
    const base2 = form()
    ;(base2.facets[0] as { values: string[] }).values = ['yes', 'yes']
    expect(validateDraft(base2)['facets.0.values']).toBe('value_duplicate')
  })

  it('flags a scale whose min is above its max', () => {
    const base = form()
    ;(base.facets[2] as { min: number; max: number }).min = 9
    expect(validateDraft(base)['facets.2.max']).toBe('scale_order')
  })

  it('flags non-integer scale bounds', () => {
    const base = form()
    ;(base.facets[2] as { min: number; max: number }).min = 1.5
    expect(validateDraft(base)['facets.2.min']).toBe('not_integer')
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
