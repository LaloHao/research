import { describe, expect, it } from 'vitest'
import { arg, ipcArgs } from '../../src/main/ipcArgs'

describe('IPC argument validation', () => {
  it('accepts citation keys and rejects anything that could escape the papers folder', () => {
    expect(arg(ipcArgs.paperId, 'he2017drain', 'id')).toBe('he2017drain')
    for (const bad of ['../etc', 'He2017', '2017he', '', 'a/b', 42, null]) {
      expect(() => arg(ipcArgs.paperId, bad, 'id')).toThrow('Invalid IPC argument: id')
    }
  })

  it('checks strings, numbers and lists', () => {
    expect(arg(ipcArgs.hash, null, 'hash')).toBeNull()
    expect(() => arg(ipcArgs.text, 5, 'text')).toThrow()
    expect(() => arg(ipcArgs.jobId, '3', 'job')).toThrow()
    expect(() => arg(ipcArgs.jobId, 1.5, 'job')).toThrow()
    expect(() => arg(ipcArgs.paths, ['/a.pdf', 3], 'paths')).toThrow()
    expect(arg(ipcArgs.optionalText, undefined, 'input')).toBeUndefined()
  })

  it('lets the renderer change only the contact email', () => {
    expect(arg(ipcArgs.settingsPatch, { contactEmail: 'me@uni.test' }, 'patch')).toEqual({ contactEmail: 'me@uni.test' })
    expect(() => arg(ipcArgs.settingsPatch, { lastProjectPath: '/elsewhere' }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.settingsPatch, { contactEmail: 1 }, 'patch')).toThrow()
  })

  it('accepts only known project keys and policies', () => {
    expect(arg(ipcArgs.projectPatch, { pdfPolicy: 'lfs', name: 'Tesis' }, 'patch')).toEqual({ pdfPolicy: 'lfs', name: 'Tesis' })
    expect(() => arg(ipcArgs.projectPatch, { pdfPolicy: 'everywhere' }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.projectPatch, { schema_version: 2 }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.projectPatch, { name: '  ' }, 'patch')).toThrow()
  })

  it('checks the summary review arguments', () => {
    expect(arg(ipcArgs.section, 'fields', 'section')).toBe('fields')
    expect(arg(ipcArgs.section, 'facets', 'section')).toBe('facets')
    expect(arg(ipcArgs.section, 'thesis', 'section')).toBe('thesis')
    expect(() => arg(ipcArgs.section, 'other', 'section')).toThrow()

    expect(arg(ipcArgs.fieldKey, 'tldr', 'key')).toBe('tldr')
    expect(arg(ipcArgs.fieldKey, 'research_type', 'key')).toBe('research_type')
    for (const bad of ['Tldr', '1tldr', '', 'tl dr']) expect(() => arg(ipcArgs.fieldKey, bad, 'key')).toThrow()

    expect(arg(ipcArgs.reviewStatus, 'verified', 'status')).toBe('verified')
    expect(arg(ipcArgs.reviewStatus, 'generated', 'status')).toBe('generated')
    expect(() => arg(ipcArgs.reviewStatus, 'edited', 'status')).toThrow()

    expect(arg(ipcArgs.pageNumber, null, 'page')).toBeNull()
    expect(arg(ipcArgs.pageNumber, 3, 'page')).toBe(3)
    expect(() => arg(ipcArgs.pageNumber, 0, 'page')).toThrow()
    expect(() => arg(ipcArgs.pageNumber, '3', 'page')).toThrow()
  })

  it('checks the Claude settings patch', () => {
    expect(arg(ipcArgs.llmPatch, { auto_summarize: true }, 'patch')).toEqual({ auto_summarize: true })
    expect(() => arg(ipcArgs.llmPatch, { model: 'gpt' }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.llmPatch, { unknown: true }, 'patch')).toThrow()
  })

  it('checks the extraction form', () => {
    const form = { facets: [{ key: 'llm_usage', type: 'single', description: 'd', values: ['none'] }], value_aliases: {} }
    expect(arg(ipcArgs.extractionForm, form, 'form')).toEqual(form)
    expect(() => arg(ipcArgs.extractionForm, { ...form, extra: true }, 'form')).toThrow()
    expect(() => arg(ipcArgs.extractionForm, { facets: [{ key: 'Bad', type: 'text', description: 'd' }] }, 'form')).toThrow()
    expect(() => arg(ipcArgs.extractionForm, { facets: [{ key: 'a', type: 'scale', description: 'd', min: 5, max: 1 }] }, 'form')).toThrow()
    expect(() => arg(ipcArgs.extractionForm, 'garbage', 'form')).toThrow()
    expect(() => arg(ipcArgs.extractionForm, null, 'form')).toThrow()
  })
})
