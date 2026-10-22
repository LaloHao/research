import { describe, expect, it } from 'vitest'
import { DEFAULT_WRITING_PREFS, exportFileName, keyIndexOf, loadWritingPrefs, saveWritingPrefs, writingPlanLines } from '../../src/renderer/lib/writing'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('writing preferences', () => {
  it('defaults to Org with \\cite and remembers the choice per project', () => {
    const storage = memoryStorage()
    expect(loadWritingPrefs('/a', storage)).toEqual({ format: 'org', latexCommand: 'cite' })
    saveWritingPrefs('/a', { format: 'latex', latexCommand: 'autocite' }, storage)
    expect(loadWritingPrefs('/a', storage)).toEqual({ format: 'latex', latexCommand: 'autocite' })
    expect(loadWritingPrefs('/b', storage)).toEqual(DEFAULT_WRITING_PREFS)
  })

  it('falls back to the defaults on invalid data or unavailable storage', () => {
    const storage = memoryStorage()
    storage.data.set('writing-prefs:/a', '{"format":"docx","latexCommand":"citep"}')
    expect(loadWritingPrefs('/a', storage)).toEqual({ format: 'org', latexCommand: 'citep' })
    storage.data.set('writing-prefs:/a', 'not json')
    expect(loadWritingPrefs('/a', storage)).toEqual(DEFAULT_WRITING_PREFS)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(loadWritingPrefs('/a', broken)).toEqual(DEFAULT_WRITING_PREFS)
    expect(() => saveWritingPrefs('/a', DEFAULT_WRITING_PREFS, broken)).not.toThrow()
    expect(loadWritingPrefs('/a', null)).toEqual(DEFAULT_WRITING_PREFS)
  })
})

describe('keyIndexOf', () => {
  it('indexes library keys with their text and trashed keys', () => {
    const index = keyIndexOf({ papers: [{ id: 'a', title: 'A', year: null, hasText: false }], trashed: [{ id: 't', title: 'T' }] })
    expect(index.papers.get('a')).toEqual({ hasText: false })
    expect(index.trashed.has('t')).toBe(true)
  })
})

describe('exportFileName', () => {
  it('makes a bare name the save dialog accepts', () => {
    expect(exportFileName('capítulo 2.tex', 'bib')).toBe('cap-tulo-2.bib')
    expect(exportFileName('thesis.org', 'bib')).toBe('thesis.bib')
    expect(exportFileName('', 'org')).toBe('export.org')
    expect(exportFileName('../../etc/passwd', 'bib')).toMatch(/^[\w.-]{1,100}\.bib$/)
  })
})

describe('writingPlanLines', () => {
  const t = ((key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`) as unknown as Parameters<typeof writingPlanLines>[0]

  it('names the estimate, the kind’s cap and the month, with or without a monthly cap', () => {
    const plan = { estimateUsd: 0.12, capUsd: 0.5, monthSpentUsd: 3, monthCapUsd: 10, model: 'sonnet' as const }
    expect(writingPlanLines(t, 'style', plan)).toEqual([
      'writing.claude.estimate {"cost":"~$0.12"}',
      'writing.claude.cap_style {"cap":"0.50"}',
      'writing.claude.month {"spent":"3.00","cap":"10.00"}'
    ])
    expect(writingPlanLines(t, 'outline', { ...plan, monthCapUsd: null })[2]).toBe('writing.claude.month_no_cap {"spent":"3.00"}')
  })
})
