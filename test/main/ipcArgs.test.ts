import { describe, expect, it } from 'vitest'
import { arg, InvalidIpcArgument, ipcArgs } from '../../src/main/ipcArgs'

describe('IPC argument validation', () => {
  it('accepts citation keys and rejects anything that could escape the papers folder', () => {
    expect(arg(ipcArgs.paperId, 'he2017drain', 'id')).toBe('he2017drain')
    for (const bad of ['../etc', 'He2017', '2017he', '', 'a/b', 42, null]) {
      expect(() => arg(ipcArgs.paperId, bad, 'id')).toThrow('Invalid IPC argument: id')
    }
  })

  it('accepts only http(s) addresses for the app browser', () => {
    expect(arg(ipcArgs.webUrl, ' https://towardsdatascience.com/x ', 'url')).toBe('https://towardsdatascience.com/x')
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'towardsdatascience.com', '', 3, null, `https://a.test/${'x'.repeat(4000)}`]) {
      expect(() => arg(ipcArgs.webUrl, bad, 'url')).toThrow()
    }
  })

  it('accepts a metadata edit of known fields only', () => {
    const edit = { title: 'T', authors: [{ family: 'Roe', given: 'Jane' }], year: 2024, date: '2024-05', venue: null, url: 'https://acme.test/x' }
    expect(arg(ipcArgs.metadataEdit, edit, 'edit')).toEqual(edit)
    expect(arg(ipcArgs.metadataEdit, {}, 'edit')).toEqual({})
    for (const bad of [
      { id: 'other' },
      { title: 5 },
      { authors: [{ family: 'Roe', orcid: 'x' }] },
      { year: 20245 },
      { year: 2024.5 },
      { date: '2024-13-01' },
      { date: '05/2024' },
      { url: 'file:///etc/passwd' },
      null
    ]) {
      expect(() => arg(ipcArgs.metadataEdit, bad, 'edit')).toThrow()
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
    for (const name of ['chapter.bib', 'outline.tex', 'outline.md', 'outline.org']) expect(arg(ipcArgs.exportName, name, 'name')).toBe(name)
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

  it('accepts a renderer error report, cutting long texts', () => {
    const report = arg(ipcArgs.rendererError, { kind: 'error', message: 'x'.repeat(3000), stack: null, source: 'app.js:1' }, 'report')
    expect(report.message).toHaveLength(2000)
    expect(report.source).toBe('app.js:1')
    for (const bad of [null, { kind: 'warn', message: 'm', stack: null, source: null }, { kind: 'error', message: 'm', stack: null, source: null, extra: 1 }, { kind: 'error', message: 7, stack: null, source: null }]) {
      expect(() => arg(ipcArgs.rendererError, bad, 'report')).toThrow()
    }
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

  it('accepts chat ids, titles, queries, messages and the per-message cap, nothing else', () => {
    expect(arg(ipcArgs.llmPatch, { budget: { per_chat_message_usd: 0.2 } }, 'patch')).toEqual({ budget: { per_chat_message_usd: 0.2 } })
    expect(() => arg(ipcArgs.llmPatch, { budget: { per_chat_message_usd: 0 } }, 'patch')).toThrow()
    expect(arg(ipcArgs.llmPatch, { budget: { per_draft_usd: 2, per_cite_check_usd: 1, per_outline_usd: 0.3, per_style_usd: 0.2 } }, 'patch')).toEqual({
      budget: { per_draft_usd: 2, per_cite_check_usd: 1, per_outline_usd: 0.3, per_style_usd: 0.2 }
    })
    expect(() => arg(ipcArgs.llmPatch, { budget: { per_style_usd: -1 } }, 'patch')).toThrow()
    expect(arg(ipcArgs.chatId, '20261011-120000-a1b2-0f9e8d', 'id')).toBe('20261011-120000-a1b2-0f9e8d')
    for (const bad of ['', '../x', '20261011-120000-A1B2', `20261011-120000-a1b2${'-0f9e8d'.repeat(9)}`, 7, null]) {
      expect(() => arg(ipcArgs.chatId, bad, 'id')).toThrow()
    }
    expect(arg(ipcArgs.chatTitle, '  Drain ', 'title')).toBe('Drain')
    for (const bad of ['   ', 'x'.repeat(121), 3]) expect(() => arg(ipcArgs.chatTitle, bad, 'title')).toThrow()
    expect(arg(ipcArgs.chatListQuery, undefined, 'query')).toBeUndefined()
    expect(arg(ipcArgs.chatListQuery, { text: 'drain', paper: 'he2017drain' }, 'query')).toEqual({ text: 'drain', paper: 'he2017drain' })
    for (const bad of [{ paper: 'He' }, { text: 'x'.repeat(201) }, { paper: 'a'.repeat(201) }, { extra: 1 }, 'drain']) {
      expect(() => arg(ipcArgs.chatListQuery, bad, 'query')).toThrow()
    }
    const send = { chatId: null, scope: { paper: 'he2017drain' }, model: 'sonnet', text: ' Why? ', excerpt: { paper: 'he2017drain', page: 3, quote: 'a tree' } }
    expect(arg(ipcArgs.chatSend, send, 'request')).toEqual({ ...send, text: 'Why?' })
    expect(arg(ipcArgs.chatSend, { ...send, chatId: '20261011-120000-a1b2', scope: 'library', excerpt: null }, 'request')).toMatchObject({ scope: 'library' })
    for (const bad of [
      { ...send, text: '  ' },
      { ...send, text: 'x'.repeat(20001) },
      { ...send, chatId: '../x' },
      { ...send, scope: 'global' },
      { ...send, scope: { paper: 'a'.repeat(201) } },
      { ...send, scope: { paper: 'he2017drain', extra: 1 } },
      { ...send, model: 'gpt' },
      { ...send, excerpt: { paper: 'he2017drain', page: 0, quote: 'a' } },
      { ...send, excerpt: { paper: 'he2017drain', page: 1.5, quote: 'a' } },
      { ...send, excerpt: { paper: 'He', page: 1, quote: 'a' } },
      { ...send, excerpt: { paper: 'he2017drain', page: null, quote: ' ' } },
      { ...send, excerpt: { paper: 'he2017drain', page: null, quote: 'x'.repeat(1001) } },
      { ...send, excerpt: undefined },
      { ...send, extra: 1 }
    ]) {
      expect(() => arg(ipcArgs.chatSend, bad, 'request')).toThrow()
    }
    expect(arg(ipcArgs.chatModel, 'opus', 'model')).toBe('opus')
    for (const bad of ['gpt', '', null]) expect(() => arg(ipcArgs.chatModel, bad, 'model')).toThrow()
    expect(arg(ipcArgs.messageIndex, 3, 'index')).toBe(3)
    for (const bad of [-1, 1.5, '3', 100_001]) expect(() => arg(ipcArgs.messageIndex, bad, 'index')).toThrow()
    // «Guardar en notas del paper»: a paper only when the user picked one.
    expect(arg(ipcArgs.notesPaper, undefined, 'paper')).toBeUndefined()
    expect(arg(ipcArgs.notesPaper, null, 'paper')).toBeNull()
    expect(arg(ipcArgs.notesPaper, 'he2017drain', 'paper')).toBe('he2017drain')
    for (const bad of ['He', '../x', 'a'.repeat(201), 3]) expect(() => arg(ipcArgs.notesPaper, bad, 'paper')).toThrow()
  })

  it('accepts the chat switches, approval and action ids, and the switches of a new conversation', () => {
    expect(arg(ipcArgs.chatTools, { actions: true }, 'tools')).toEqual({ actions: true })
    expect(arg(ipcArgs.chatTools, { actions: false, sync: true }, 'tools')).toEqual({ actions: false, sync: true })
    for (const bad of [{ actions: 'yes' }, { other: true }, { actions: 1 }, { sync: null }, {}, null, 'actions', [true]]) {
      expect(() => arg(ipcArgs.chatTools, bad, 'tools')).toThrow()
    }
    expect(arg(ipcArgs.approvalId, 'a0b1c2', 'approval')).toBe('a0b1c2')
    expect(arg(ipcArgs.actionId, 'a0b1c2', 'action')).toBe('a0b1c2')
    for (const bad of ['', 'A0B1C2', 'a0b1c2d', 'a0b1c', '../x', 'a0b1c2\n', 7, null]) {
      expect(() => arg(ipcArgs.approvalId, bad, 'approval')).toThrow()
      expect(() => arg(ipcArgs.actionId, bad, 'action')).toThrow()
    }
    // The decision is a plain boolean (the user's click), never a string or a path.
    expect(arg(ipcArgs.approve, true, 'approve')).toBe(true)
    for (const bad of ['true', 1, null, undefined, { approve: true }, '/tmp/a.pdf']) expect(() => arg(ipcArgs.approve, bad, 'approve')).toThrow()
    const send = { chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null, actions: true, sync: false }
    expect(arg(ipcArgs.chatSend, send, 'request')).toEqual(send)
    expect(() => arg(ipcArgs.chatSend, { ...send, actions: 1 }, 'request')).toThrow()
    expect(() => arg(ipcArgs.chatSend, { ...send, sync: 'on' }, 'request')).toThrow()
  })
  it('checks the mapping arguments: ids, the protocol draft, searches, imports and decisions', () => {
    expect(arg(ipcArgs.mappingId, '20261012-090000-a1b2', 'id')).toBe('20261012-090000-a1b2')
    for (const bad of ['../x', '20261012-090000-A1B2', '', 3, null]) expect(() => arg(ipcArgs.mappingId, bad, 'id')).toThrow()
    expect(arg(ipcArgs.recordId, 'r0123456789ab', 'record')).toBe('r0123456789ab')
    expect(() => arg(ipcArgs.recordId, 'r1', 'record')).toThrow()
    expect(arg(ipcArgs.mappingTitle, 'Log anonymization', 'title')).toBe('Log anonymization')
    for (const bad of ['  ', 'x'.repeat(301), 3]) expect(() => arg(ipcArgs.mappingTitle, bad, 'title')).toThrow()
    const draft = {
      title: 'T',
      objective: '',
      research_questions: [],
      inclusion: [{ id: null, text: 'x' }],
      exclusion: [{ id: 'E1', text: 'y' }],
      years: { from: 2015, to: null },
      publication_types: ['article']
    }
    expect(arg(ipcArgs.protocolDraft, draft, 'draft')).toEqual(draft)
    expect(() => arg(ipcArgs.protocolDraft, { ...draft, version: 3 }, 'draft')).toThrow()
    expect(() => arg(ipcArgs.protocolDraft, { ...draft, title: ' ' }, 'draft')).toThrow()
    // Nested objects are strict too: nothing but the editable fields reaches the service.
    expect(() => arg(ipcArgs.protocolDraft, { ...draft, inclusion: [{ id: null, text: 'x', at: 'now' }] }, 'draft')).toThrow()
    expect(() => arg(ipcArgs.protocolDraft, { ...draft, years: { from: null, to: null, extra: 1 } }, 'draft')).toThrow()
    expect(arg(ipcArgs.protocolVersion, 2, 'version')).toBe(2)
    for (const bad of [0, 1.5, '2', 10_001]) expect(() => arg(ipcArgs.protocolVersion, bad, 'version')).toThrow()
    const search = { query: 'log AND anonymization', fromYear: 2015, toYear: null, types: ['article', 'book-chapter'], cap: 500 }
    expect(arg(ipcArgs.openalexSearch, search, 'search')).toEqual(search)
    for (const bad of [{ ...search, cap: 6000 }, { ...search, types: ['conference'] }, { ...search, query: '' }, { ...search, mailto: 'x' }]) {
      expect(() => arg(ipcArgs.openalexSearch, bad, 'search')).toThrow()
    }
    // The count before confirming: the same search without a cap (a cap, or anything else, is refused).
    const { cap: _cap, ...count } = search
    expect(arg(ipcArgs.openalexCount, count, 'search')).toEqual(count)
    for (const bad of [search, { ...count, query: ' ' }, { ...count, fromYear: 1700 }, { ...count, types: ['conference'] }]) expect(() => arg(ipcArgs.openalexCount, bad, 'search')).toThrow()
    expect(arg(ipcArgs.importSource, { database: 'Scopus', query: '' }, 'source')).toEqual({ database: 'Scopus', query: '' })
    expect(() => arg(ipcArgs.importSource, { database: 'Scopus', query: '', path: '/etc/passwd' }, 'source')).toThrow()
    // The file to import is named by the token the main process's dialog handed out, never by a path.
    expect(arg(ipcArgs.importToken, '123e4567-e89b-42d3-a456-426614174000', 'file')).toBe('123e4567-e89b-42d3-a456-426614174000')
    for (const bad of ['/etc/passwd', 'C:\\x.bib', '', 3, null]) expect(() => arg(ipcArgs.importToken, bad, 'file')).toThrow()
    const decide = { recordId: 'r0123456789ab', phase: 'title_abstract', decision: 'exclude', criterion: 'E2', suggestionId: null }
    expect(arg(ipcArgs.decideRequest, decide, 'request')).toEqual(decide)
    for (const bad of [{ ...decide, decision: 'none' }, { ...decide, criterion: 'X1' }, { ...decide, by: 'suggestion' }]) expect(() => arg(ipcArgs.decideRequest, bad, 'request')).toThrow()
    expect(arg(ipcArgs.decisionId, 'd0123456789ab', 'decision')).toBe('d0123456789ab')
    expect(() => arg(ipcArgs.decisionId, 'g0123456789ab', 'decision')).toThrow()
    expect(arg(ipcArgs.searchId, 's0123456789ab', 'search')).toBe('s0123456789ab')
    expect(() => arg(ipcArgs.searchId, 's01', 'search')).toThrow()
    expect(arg(ipcArgs.queueQuery, { phase: 'full_text', filter: 'not_retrieved' }, 'query')).toEqual({ phase: 'full_text', filter: 'not_retrieved' })
    expect(() => arg(ipcArgs.queueQuery, { phase: 'quality', filter: 'all' }, 'query')).toThrow()
    expect(() => arg(ipcArgs.phase, 'quality', 'phase')).toThrow()
    expect(arg(ipcArgs.snowballDirection, 'both', 'direction')).toBe('both')
    expect(() => arg(ipcArgs.snowballDirection, 'sideways', 'direction')).toThrow()
    expect(() => arg(ipcArgs.discardReason, '   ', 'reason')).toThrow()
    expect(() => arg(ipcArgs.mappingPaperIds, [], 'ids')).toThrow()
    expect(arg(ipcArgs.mappingPaperIds, ['he2017drain'], 'ids')).toEqual(['he2017drain'])
    expect(arg(ipcArgs.mappingRecordIds, ['r0000000000a1'], 'ids')).toEqual(['r0000000000a1'])
    for (const bad of [undefined, [], ['r1']]) expect(() => arg(ipcArgs.mappingRecordIds, bad, 'ids')).toThrow()
    expect(arg(ipcArgs.mappingRecordScope, undefined, 'ids')).toBeUndefined()
    expect(() => arg(ipcArgs.mappingRecordScope, ['r1'], 'ids')).toThrow()
  })

  it('takes a costly mapping request only with the confirmation of the user\'s click', () => {
    expect(arg(ipcArgs.confirmed, true, 'confirmed')).toBe(true)
    for (const bad of [false, 'true', 1, null, undefined]) expect(() => arg(ipcArgs.confirmed, bad, 'confirmed')).toThrow()
  })

  it('checks «Redacción»’s sources and scopes: a bounded text or a file token, never a path', () => {
    expect(arg(ipcArgs.writingSource, { kind: 'text', text: '\\cite{a}', format: 'latex' }, 'source')).toEqual({ kind: 'text', text: '\\cite{a}', format: 'latex' })
    const token = '123e4567-e89b-42d3-a456-426614174000'
    expect(arg(ipcArgs.writingSource, { kind: 'file', token }, 'source')).toEqual({ kind: 'file', token })
    for (const bad of [
      { kind: 'file', path: '/etc/passwd' },
      { kind: 'file', token: '../x' },
      { kind: 'text', text: 'x', format: 'docx' },
      { kind: 'text', text: 'x'.repeat(2_000_001), format: 'org' },
      { kind: 'text', text: 'x', format: 'org', extra: 1 }
    ])
      expect(() => arg(ipcArgs.writingSource, bad, 'source')).toThrow()
    expect(arg(ipcArgs.outlineScope, { kind: 'papers', ids: ['he2017drain'] }, 'scope')).toEqual({ kind: 'papers', ids: ['he2017drain'] })
    expect(arg(ipcArgs.outlineScope, { kind: 'library' }, 'scope')).toEqual({ kind: 'library' })
    for (const bad of [{ kind: 'papers', ids: ['../x'] }, { kind: 'mapping', mappingId: '../x' }, { kind: 'all' }]) expect(() => arg(ipcArgs.outlineScope, bad, 'scope')).toThrow()
  })

  it('checks «Borrador»’s form, ids and edits', () => {
    const input = { title: 'Parsing', purpose: '', rq: 'RQ1', papers: ['he2017drain'], length: 'short', model: 'sonnet' }
    expect(arg(ipcArgs.draftInput, input, 'input')).toEqual(input)
    for (const bad of [
      { ...input, papers: [] },
      { ...input, papers: ['../x'] },
      { ...input, papers: Array.from({ length: 61 }, (_v, i) => `p${i}`) },
      { ...input, length: 'huge' },
      { ...input, rq: 'Q1' },
      { ...input, title: ' ' },
      { ...input, extra: 1 }
    ])
      expect(() => arg(ipcArgs.draftInput, bad, 'input')).toThrow()
    expect(arg(ipcArgs.draftTarget, null, 'id')).toBeNull()
    expect(() => arg(ipcArgs.draftId, '../x', 'id')).toThrow()
    expect(() => arg(ipcArgs.draftText, 'x'.repeat(100_001), 'text')).toThrow()
  })

  it('checks «Verificar con Claude»’s request: a bounded text, a known format and model, nothing else', () => {
    expect(arg(ipcArgs.citeCheckRequest, { text: '\\cite{a}', format: 'latex', model: 'haiku' }, 'request')).toEqual({ text: '\\cite{a}', format: 'latex', model: 'haiku' })
    expect(arg(ipcArgs.citeCheckRequest, { text: 'x', format: 'org' }, 'request')).toEqual({ text: 'x', format: 'org' })
    for (const bad of [
      { text: 'x'.repeat(30_001), format: 'org' },
      { text: 'x', format: 'docx' },
      { text: 'x', format: 'org', model: 'gpt' },
      { text: 'x', format: 'org', maxUsd: 9 }
    ])
      expect(() => arg(ipcArgs.citeCheckRequest, bad, 'request')).toThrow()
    expect(() => arg(ipcArgs.checkText, 'x'.repeat(30_001), 'text')).toThrow()
    expect(() => arg(ipcArgs.citeFormat, 'tex', 'format')).toThrow()
  })
})
