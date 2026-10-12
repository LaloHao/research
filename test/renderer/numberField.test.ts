import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import { NUMBER_ISSUES, parseCap, parseCount, parseInteger, parseUsd } from '../../src/renderer/lib/numberField'

describe('parseUsd', () => {
  it('accepts positive amounts, with a dot or a comma', () => {
    expect(parseUsd('0.5')).toEqual({ ok: true, value: 0.5 })
    expect(parseUsd(' 2,25 ')).toEqual({ ok: true, value: 2.25 })
  })
  it('says why a value is rejected', () => {
    expect(parseUsd('')).toEqual({ ok: false, issue: 'required' })
    expect(parseUsd('1e')).toEqual({ ok: false, issue: 'not_number' })
    expect(parseUsd('abc')).toEqual({ ok: false, issue: 'not_number' })
    expect(parseUsd('0')).toEqual({ ok: false, issue: 'not_positive' })
    expect(parseUsd('-3')).toEqual({ ok: false, issue: 'not_positive' })
  })
})

describe('parseCap', () => {
  it('treats an empty field as no cap', () => {
    expect(parseCap('  ')).toEqual({ ok: true, value: null })
  })
  it('rejects zero with a hint about leaving it empty', () => {
    expect(parseCap('0')).toEqual({ ok: false, issue: 'cap_not_positive' })
    expect(parseCap('x')).toEqual({ ok: false, issue: 'not_number' })
    expect(parseCap('5')).toEqual({ ok: true, value: 5 })
  })
})

describe('parseCount', () => {
  it('accepts positive whole numbers only', () => {
    expect(parseCount('120000')).toEqual({ ok: true, value: 120000 })
    expect(parseCount('1.5')).toEqual({ ok: false, issue: 'not_integer' })
    expect(parseCount('0')).toEqual({ ok: false, issue: 'not_positive' })
    expect(parseCount('')).toEqual({ ok: false, issue: 'required' })
    expect(parseCount('1000', 1000)).toEqual({ ok: true, value: 1000 })
    expect(parseCount('1001', 1000)).toEqual({ ok: false, issue: 'too_large' })
  })
})

describe('parseInteger', () => {
  it('accepts negative numbers and zero', () => {
    expect(parseInteger('-3')).toEqual({ ok: true, value: -3 })
    expect(parseInteger('0')).toEqual({ ok: true, value: 0 })
    expect(parseInteger('5')).toEqual({ ok: true, value: 5 })
  })
  it('requires a value and rejects non-integers', () => {
    expect(parseInteger('')).toEqual({ ok: false, issue: 'required' })
    expect(parseInteger('abc')).toEqual({ ok: false, issue: 'not_number' })
    expect(parseInteger('1.5')).toEqual({ ok: false, issue: 'not_integer' })
  })
})

describe('every issue has a Spanish message', () => {
  it.each(NUMBER_ISSUES)('%s', (issue) => {
    expect(typeof (es.settings.invalid as Record<string, unknown>)[issue]).toBe('string')
  })
})
