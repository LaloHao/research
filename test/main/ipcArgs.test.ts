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

  it('accepts the OpenAlex API key in the settings patch', () => {
    expect(arg(ipcArgs.settingsPatch, { openalexApiKey: 'k' }, 'patch')).toEqual({ openalexApiKey: 'k' })
    expect(() => arg(ipcArgs.settingsPatch, { openalexApiKey: 3 }, 'patch')).toThrow()
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
    expect(arg(ipcArgs.llmPatch, { auto_suggest_relations: true }, 'patch')).toEqual({ auto_suggest_relations: true })
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

  it('validates the citation, map and export arguments', () => {
    expect(arg(ipcArgs.openalexId, 'W2754665629', 'id')).toBe('W2754665629')
    for (const bad of ['https://openalex.org/W1', 'w1', 'W', 3]) expect(() => arg(ipcArgs.openalexId, bad, 'id')).toThrow()
    expect(arg(ipcArgs.candidateQuery, { direction: 'references', minCount: 2 }, 'q')).toEqual({ direction: 'references', minCount: 2 })
    expect(arg(ipcArgs.candidateQuery, { direction: 'all', minCount: 1, paperId: 'he2017drain' }, 'q').paperId).toBe('he2017drain')
    expect(() => arg(ipcArgs.candidateQuery, { direction: 'sideways', minCount: 1 }, 'q')).toThrow()
    expect(() => arg(ipcArgs.candidateQuery, { direction: 'all', minCount: 0 }, 'q')).toThrow()
    expect(arg(ipcArgs.chartQuery, { kind: 'bubbles', facet: 'task', facetY: 'llm_usage', onlyReviewed: false }, 'q').kind).toBe('bubbles')
    expect(() => arg(ipcArgs.chartQuery, { kind: 'bubbles', facet: 'task', onlyReviewed: false }, 'q')).toThrow()
    expect(() => arg(ipcArgs.chartQuery, { kind: 'pie', facet: 'task', onlyReviewed: false }, 'q')).toThrow()
    expect(arg(ipcArgs.facetFilters, [{ facet: 'task', value: 'log_parsing' }], 'f')).toHaveLength(1)
    expect(() => arg(ipcArgs.facetFilters, [{ facet: 'Task', value: 'x' }], 'f')).toThrow()
    expect(arg(ipcArgs.exportName, 'bars-task.svg', 'name')).toBe('bars-task.svg')
    for (const bad of ['../x.png', 'a/b.png', 'x.exe', '']) expect(() => arg(ipcArgs.exportName, bad, 'name')).toThrow()
    expect(arg(ipcArgs.exportData, new Uint8Array([1]), 'data')).toEqual(new Uint8Array([1]))
    expect(arg(ipcArgs.exportData, 'a,b\n', 'data')).toBe('a,b\n')
    expect(() => arg(ipcArgs.exportData, 42, 'data')).toThrow()
  })
})
