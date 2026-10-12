import { describe, expect, it } from 'vitest'
import { arg, InvalidIpcArgument, ipcArgs } from '../../src/main/ipcArgs'

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

  it('accepts only an absolute path and a boolean for attaching a PDF', () => {
    expect(arg(ipcArgs.absolutePath, '/home/me/paper.pdf', 'path')).toBe('/home/me/paper.pdf')
    expect(arg(ipcArgs.absolutePath, 'C:\\Users\\me\\paper.pdf', 'path')).toBe('C:\\Users\\me\\paper.pdf')
    for (const bad of ['', 'paper.pdf', '../paper.pdf', 3, null]) expect(() => arg(ipcArgs.absolutePath, bad, 'path')).toThrow()
    expect(arg(ipcArgs.flag, true, 'replace')).toBe(true)
    expect(() => arg(ipcArgs.flag, 'true', 'replace')).toThrow()
    expect(() => arg(ipcArgs.flag, undefined, 'replace')).toThrow()
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

  it('checks the trash arguments: keys only, never an empty list, and the whole trash only by name', () => {
    expect(arg(ipcArgs.trashIds, ['he2017drain'], 'ids')).toEqual(['he2017drain'])
    expect(() => arg(ipcArgs.trashIds, [], 'ids')).toThrow(InvalidIpcArgument)
    expect(() => arg(ipcArgs.trashIds, ['../x'], 'ids')).toThrow(InvalidIpcArgument)
    expect(arg(ipcArgs.trashTarget, 'all', 'target')).toBe('all')
    expect(arg(ipcArgs.trashTarget, ['he2017drain'], 'target')).toEqual(['he2017drain'])
    for (const bad of [undefined, [], 'everything', ['../x']]) expect(() => arg(ipcArgs.trashTarget, bad, 'target')).toThrow(InvalidIpcArgument)
  })
})

describe('typed relation arguments', () => {
  it('accepts well-formed relation ids, statuses and types only', () => {
    expect(arg(ipcArgs.relationId, 'he2017drain__zhu2020loghub__extends', 'id')).toBe('he2017drain__zhu2020loghub__extends')
    expect(() => arg(ipcArgs.relationId, 'he2017drain__zhu2020loghub__cites', 'id')).toThrow(InvalidIpcArgument)
    expect(() => arg(ipcArgs.relationId, '../relations.yaml', 'id')).toThrow(InvalidIpcArgument)
    expect(arg(ipcArgs.relationStatus, 'rejected', 'status')).toBe('rejected')
    expect(() => arg(ipcArgs.relationStatus, 'deleted', 'status')).toThrow(InvalidIpcArgument)
    expect(arg(ipcArgs.relationType, 'same_problem', 'type')).toBe('same_problem')
    expect(() => arg(ipcArgs.relationType, 'cites', 'type')).toThrow(InvalidIpcArgument)
  })

  it('accepts an undo token and a justification, nothing else', () => {
    expect(arg(ipcArgs.undoToken, '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b', 'token')).toBe('3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b')
    expect(() => arg(ipcArgs.undoToken, { before: {}, after: {} }, 'token')).toThrow(InvalidIpcArgument)
    expect(arg(ipcArgs.justification, '  Loghub reuses Drain.  ', 'text')).toBe('Loghub reuses Drain.')
    expect(() => arg(ipcArgs.justification, '   ', 'text')).toThrow(InvalidIpcArgument)
    expect(() => arg(ipcArgs.justification, 'x'.repeat(2001), 'text')).toThrow(InvalidIpcArgument)
  })

  it('lets the renderer turn the automatic sync on or off and set its interval within bounds', () => {
    expect(arg(ipcArgs.settingsPatch, { autoSync: false, autoSyncMinutes: 30 }, 'patch')).toEqual({ autoSync: false, autoSyncMinutes: 30 })
    for (const bad of [{ autoSyncMinutes: 4 }, { autoSyncMinutes: 121 }, { autoSyncMinutes: 7.5 }, { autoSync: 'yes' }]) {
      expect(() => arg(ipcArgs.settingsPatch, bad, 'patch')).toThrow()
    }
  })

  it('accepts only the conflict ids and choices the sync hands out, and a remote URL that is no option and has no password', () => {
    expect(arg(ipcArgs.conflictId, 'file:papers/k/summary.md', 'id')).toBe('file:papers/k/summary.md')
    expect(arg(ipcArgs.conflictId, 'paper:he2017drain', 'id')).toBe('paper:he2017drain')
    for (const bad of ['', 'papers/k/summary.md', 'paper:../x', 'paper:', 'file:', 3]) expect(() => arg(ipcArgs.conflictId, bad, 'id')).toThrow()
    const v = '0123456789abcdef'
    const choices = { 'paper:k': { choice: 'ours', version: v }, 'file:a.md': { choice: 'theirs', version: v } }
    expect(arg(ipcArgs.conflictChoices, choices, 'choices')).toEqual(choices)
    // Each choice carries the version of the conflict the user saw: a bare choice, a bad version or extra keys are refused.
    for (const bad of [
      { 'paper:k': 'ours' },
      { 'paper:k': { choice: 'both', version: v } },
      { 'paper:k': { choice: 'ours' } },
      { 'paper:k': { choice: 'ours', version: 'ABCDEF0123456789' } },
      { 'paper:k': { choice: 'ours', version: v.slice(1) } },
      { 'paper:k': { choice: 'ours', version: v, extra: 1 } },
      { nope: { choice: 'ours', version: v } }
    ]) {
      expect(() => arg(ipcArgs.conflictChoices, bad, 'choices')).toThrow()
    }
    expect(arg(ipcArgs.remoteUrl, '  git@github.com:me/thesis.git ', 'url')).toBe('git@github.com:me/thesis.git')
    expect(arg(ipcArgs.remoteUrl, null, 'url')).toBeNull()
    for (const bad of ['', '--upload-pack=touch /tmp/x', 'https://me:secret@github.com/me/thesis.git', 'a b', 7]) {
      expect(() => arg(ipcArgs.remoteUrl, bad, 'url')).toThrow()
    }
    expect(arg(ipcArgs.closeDecision, 'cancel', 'decision')).toBe('cancel')
    expect(() => arg(ipcArgs.closeDecision, 'sync', 'decision')).toThrow()
  })

  it('accepts the facet suggestion settings, ids and edits, nothing else', () => {
    expect(arg(ipcArgs.llmPatch, { auto_suggest_facets: true, auto_suggest_facets_after: 5, budget: { per_facet_suggestion_usd: 3 } }, 'patch')).toEqual({
      auto_suggest_facets: true,
      auto_suggest_facets_after: 5,
      budget: { per_facet_suggestion_usd: 3 }
    })
    for (const bad of [{ auto_suggest_facets_after: 0 }, { auto_suggest_facets_after: 2.5 }, { budget: { per_facet_suggestion_usd: 0 } }]) {
      expect(() => arg(ipcArgs.llmPatch, bad, 'patch')).toThrow()
    }
    for (const id of ['new_facet__data_source', 'new_value__data_type__metrics', 'alias__task__log_parsing']) expect(arg(ipcArgs.suggestionId, id, 'id')).toBe(id)
    for (const bad of ['', 'data_source', 'new_facet__Data', 'x'.repeat(201), 3]) expect(() => arg(ipcArgs.suggestionId, bad, 'id')).toThrow()
    expect(arg(ipcArgs.suggestionEdit, undefined, 'edit')).toBeUndefined()
    expect(arg(ipcArgs.suggestionEdit, { kind: 'new_value', value: 'system_metrics' }, 'edit')).toEqual({ kind: 'new_value', value: 'system_metrics' })
    expect(arg(ipcArgs.suggestionEdit, { kind: 'new_facet', facet: { key: 'maturity', type: 'scale', description: 'd', min: 1, max: 3 } }, 'edit')).toMatchObject({
      facet: { key: 'maturity', min: 1, max: 3 }
    })
    for (const bad of [
      { kind: 'alias', to: 'Bad' },
      { kind: 'alias', to: 'ok', extra: 1 },
      { kind: 'new_facet', facet: { key: 'a', type: 'scale', description: 'd', min: 3, max: 1 } },
      { kind: 'other', value: 'x' }
    ]) {
      expect(() => arg(ipcArgs.suggestionEdit, bad, 'edit')).toThrow()
    }
  })
})
