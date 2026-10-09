import { describe, expect, it } from 'vitest'
import { applyAliases, DEFAULT_EXTRACTION_FORM, formHash, loadForm } from '../../../src/main/summary/extractionForm'

describe('loadForm', () => {
  it('reports a missing form', () => {
    expect(loadForm(undefined)).toEqual({ status: 'missing' })
  })

  it('accepts the default draft', () => {
    const load = loadForm(DEFAULT_EXTRACTION_FORM)
    expect(load.status).toBe('ok')
  })

  it('lists readable errors for an invalid form', () => {
    const load = loadForm({ facets: [{ key: 'Bad Key', type: 'text', description: 'd' }] })
    expect(load.status).toBe('invalid')
    if (load.status === 'invalid') expect(load.errors.join('\n')).toContain('facets')
  })

  it('rejects a scale whose min is above its max', () => {
    const load = loadForm({ facets: [{ key: 'rigor', type: 'scale', description: 'd', min: 5, max: 1 }] })
    expect(load.status).toBe('invalid')
    expect(loadForm({ facets: [{ key: 'rigor', type: 'scale', description: 'd', min: 3, max: 3 }] }).status).toBe('ok')
  })

  it('rejects duplicated facet keys', () => {
    const load = loadForm({ facets: [{ key: 'a', type: 'text', description: 'd' }, { key: 'a', type: 'text', description: 'e' }] })
    expect(load).toMatchObject({ status: 'invalid' })
  })
})

describe('formHash', () => {
  it('ignores key order and value_aliases, but not facet content', () => {
    const a = { facets: [{ key: 'task', type: 'text' as const, description: 'd' }], value_aliases: {} }
    const b = { value_aliases: { task: { x: 'y' } }, facets: [{ description: 'd', type: 'text' as const, key: 'task' }] }
    expect(formHash(a)).toBe(formHash(b))
    expect(formHash(a)).not.toBe(formHash({ ...a, facets: [{ key: 'task', type: 'text', description: 'changed' }] }))
  })

  it('ignores a facet\'s allowed values, but not its description, type, range or presence', () => {
    const base = { facets: [{ key: 'technique', type: 'multi' as const, description: 'd', values: ['ner'] }], value_aliases: {} }
    const moreValues = { ...base, facets: [{ ...base.facets[0], values: ['ner', 'pseudonymization'] }] }
    const fewerValues = { ...base, facets: [{ ...base.facets[0], values: [] }] }
    expect(formHash(base)).toBe(formHash(moreValues))
    expect(formHash(base)).toBe(formHash(fewerValues))

    const renamed = { ...base, facets: [{ ...base.facets[0], key: 'other' }] }
    const changedDescription = { ...base, facets: [{ ...base.facets[0], description: 'changed' }] }
    const changedType = { ...base, facets: [{ key: 'technique', type: 'text' as const, description: 'd' }] }
    const addedFacet = { ...base, facets: [...base.facets, { key: 'extra', type: 'text' as const, description: 'd' }] }
    const removedFacet = { ...base, facets: [] }
    const scaleRange = { facets: [{ key: 'relevance', type: 'scale' as const, description: 'd', min: 1, max: 5 }], value_aliases: {} }
    const changedRange = { ...scaleRange, facets: [{ ...scaleRange.facets[0], max: 10 }] }
    expect(formHash(base)).not.toBe(formHash(renamed))
    expect(formHash(base)).not.toBe(formHash(changedDescription))
    expect(formHash(base)).not.toBe(formHash(changedType))
    expect(formHash(base)).not.toBe(formHash(addedFacet))
    expect(formHash(base)).not.toBe(formHash(removedFacet))
    expect(formHash(scaleRange)).not.toBe(formHash(changedRange))
  })
})

describe('applyAliases', () => {
  const form = {
    facets: [{ key: 'technique', type: 'multi' as const, description: 'd', values: ['ner', 'pseudonymization'] }],
    value_aliases: { technique: { tokenization: 'pseudonymization' } }
  }

  it('maps aliased proposals to known values and keeps genuine proposals', () => {
    expect(applyAliases(form, 'technique', ['tokenization', 'format_preserving_encryption', 'ner'])).toEqual({
      known: ['pseudonymization', 'ner'],
      proposed: ['format_preserving_encryption']
    })
  })

  it('normalizes proposals to snake_case and drops duplicates', () => {
    expect(applyAliases(form, 'technique', ['Format Preserving Encryption', 'format_preserving_encryption'])).toEqual({
      known: [],
      proposed: ['format_preserving_encryption']
    })
  })
})
