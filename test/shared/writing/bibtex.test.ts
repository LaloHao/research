import { describe, expect, it } from 'vitest'
import { bibFields, chapterBibReport, chapterBibText, missingFields, similarity, suggestKey } from '../../../src/shared/writing/bibtex'

const DRAIN = '@inproceedings{he2017drain,\n  title = {Drain: An Online Log Parsing Approach},\n  author = {He, Pinjia and Zhu, Jieming},\n  booktitle = {ICWS},\n  year = {2017}\n}'
const LOGHUB = '@misc{zhu2023loghub,\n  title = "Loghub",\n  author = {Zhu, Jieming},\n  year = 2023\n}'

describe('bibFields', () => {
  it('reads braced, quoted and bare values, nested braces included', () => {
    const f = bibFields('@article{k,\n  title = {A {GPU} study},\n  journal = "J. Logs",\n  year = 2020,\n  note = {}\n}')
    expect(Object.fromEntries(f)).toEqual({ title: 'A {GPU} study', journal: 'J. Logs', year: '2020', note: '' })
  })
})

describe('missingFields', () => {
  it('reports a missing or empty year, authors and venue', () => {
    expect(missingFields(DRAIN)).toEqual([])
    expect(missingFields(LOGHUB)).toEqual(['venue'])
    expect(missingFields('@misc{k,\n  title = {T},\n  year = {}\n}')).toEqual(['year', 'authors', 'venue'])
    expect(missingFields('@book{k, editor = {E}, date = {2020}, publisher = {P}}')).toEqual([])
  })
})

describe('suggestions for unknown keys', () => {
  const papers = new Map([
    ['he2017drain', { title: 'Drain: An Online Log Parsing Approach' }],
    ['zhu2023loghub', { title: 'Loghub: A Large Collection of System Log Datasets' }]
  ])

  it('suggests the closest key or the paper whose title has the key’s words', () => {
    expect(suggestKey('he2017drian', papers)?.key).toBe('he2017drain')
    expect(suggestKey('Zhu2023LogHub', papers)?.key).toBe('zhu2023loghub')
    expect(suggestKey('datasets2023collection', papers)?.key).toBe('zhu2023loghub')
    expect(suggestKey('qwerty', papers)).toBeNull()
  })

  it('scores identical strings 1 and unrelated ones near 0', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
  })
})

describe('chapterBibReport', () => {
  const library = new Map([
    ['zhu2023loghub', { title: 'Loghub', bibtex: LOGHUB }],
    ['he2017drain', { title: 'Drain', bibtex: DRAIN }],
    ['bad', { title: 'Broken', bibtex: null }]
  ])

  it('keeps only cited library entries and reports the rest', () => {
    const report = chapterBibReport({ keys: ['zhu2023loghub', 'gone', 'he2017drian', 'he2017drain', 'bad'], library, trashed: new Set(['gone']) })
    expect(report.entries.map((e) => e.key)).toEqual(['zhu2023loghub', 'he2017drain'])
    expect(report.trashed).toEqual(['gone'])
    expect(report.unknown).toEqual([{ key: 'he2017drian', suggestion: { key: 'he2017drain', title: 'Drain' } }])
    expect(report.incomplete).toEqual([{ key: 'zhu2023loghub', missing: ['venue'] }])
    expect(report.invalid).toEqual(['bad'])
  })

  it('writes the .bib in order of appearance or by key', () => {
    const report = chapterBibReport({ keys: ['zhu2023loghub', 'he2017drain'], library, trashed: new Set() })
    const appearance = chapterBibText(report, 'appearance')
    expect(appearance.indexOf('zhu2023loghub')).toBeLessThan(appearance.indexOf('he2017drain'))
    const alphabetical = chapterBibText(report, 'alphabetical')
    expect(alphabetical.indexOf('he2017drain')).toBeLessThan(alphabetical.indexOf('zhu2023loghub'))
    expect(alphabetical.startsWith('% ')).toBe(true)
  })
})
