import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import {
  draftOf,
  draftOutdated,
  draftProblems,
  filtersFor,
  highlight,
  keepPosition,
  openAlexTypesFor,
  phaseLabel,
  planLines,
  prismaFileName,
  prismaLabels,
  sameDraft,
  screeningCommand,
  searchFilters,
  searchSource,
  withThesisQuestions,
  yearValue
} from '../../src/renderer/lib/mappings'
import { EMPTY_PHASE_VIEW } from '../../src/shared/mapping'
import { AT, protocolFile, search } from '../helpers/mappings'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction

describe('screeningCommand', () => {
  const ctx = { phase: 'title_abstract' as const, choosing: false, exclusions: ['E1', 'E2'] }
  it('maps the review keys, the exclusion list and its numbers', () => {
    expect(screeningCommand('i', ctx)).toEqual({ kind: 'include' })
    expect(screeningCommand('E', ctx)).toEqual({ kind: 'choose_exclusion' })
    expect(screeningCommand('e', { ...ctx, exclusions: ['E3'] })).toEqual({ kind: 'exclude', criterion: 'E3' })
    expect(screeningCommand('e', { ...ctx, exclusions: [] })).toBeNull()
    expect(screeningCommand('2', { ...ctx, choosing: true })).toEqual({ kind: 'exclude', criterion: 'E2' })
    expect(screeningCommand('9', { ...ctx, choosing: true })).toBeNull()
    expect(screeningCommand('Escape', { ...ctx, choosing: true })).toEqual({ kind: 'close_list' })
    expect(screeningCommand('Escape', ctx)).toBeNull()
    expect(screeningCommand('d', ctx)).toEqual({ kind: 'uncertain' })
    expect(screeningCommand('n', ctx)).toBeNull()
    expect(screeningCommand('N', { ...ctx, phase: 'full_text' })).toEqual({ kind: 'not_retrieved' })
    expect(screeningCommand('a', ctx)).toEqual({ kind: 'accept' })
    expect(screeningCommand('u', ctx)).toEqual({ kind: 'undo' })
    expect(screeningCommand('ArrowRight', ctx)).toEqual({ kind: 'next' })
    expect(screeningCommand('ArrowLeft', ctx)).toEqual({ kind: 'prev' })
    expect(screeningCommand('x', ctx)).toBeNull()
  })
})

describe('queue helpers', () => {
  it('keeps the current record, or moves to the next one still there', () => {
    expect(keepPosition(['a', 'b', 'c'], 1, ['a', 'b', 'c'])).toBe(1)
    expect(keepPosition(['a', 'b', 'c'], 1, ['a', 'c'])).toBe(1)
    expect(keepPosition(['a', 'b'], 1, ['a'])).toBe(0)
    expect(keepPosition([], 0, [])).toBe(0)
  })

  it('offers «not retrieved» only on full text', () => {
    expect(filtersFor('title_abstract')).not.toContain('not_retrieved')
    expect(filtersFor('full_text')).toContain('not_retrieved')
  })
})

describe('protocol drafts', () => {
  it('copies the protocol into a draft and finds its problems', () => {
    const draft = draftOf(protocolFile())
    expect(draft.exclusion).toEqual([
      { id: 'E1', text: 'Not about software logs.' },
      { id: 'E2', text: 'Not peer reviewed.' }
    ])
    expect(sameDraft(draft, draftOf(protocolFile()))).toBe(true)
    expect(draftProblems(draft)).toEqual([])
    expect(draftProblems({ ...draft, years: { from: 15, to: null } })).toEqual(['mappings.protocol.errors.years'])
    expect(draftProblems({ ...draft, title: ' ', inclusion: [{ id: null, text: '' }], years: { from: 2020, to: 2010 } })).toEqual([
      'mappings.protocol.errors.title',
      'mappings.protocol.errors.empty_item',
      'mappings.protocol.errors.years'
    ])
  })

  it('appends the thesis questions it does not have yet', () => {
    const draft = draftOf(protocolFile())
    const next = withThesisQuestions(draft, { research_questions: [{ id: 'RQ1', text: 'which techniques anonymize logs?' }, { id: 'RQ2', text: 'How are they evaluated?' }] })
    expect(next.research_questions).toEqual([...draft.research_questions, { id: null, text: 'How are they evaluated?' }])
  })

  it('reads a year field as typed: empty is no year, anything else is checked by draftProblems', () => {
    expect(yearValue('')).toBeNull()
    expect(yearValue('  ')).toBeNull()
    expect(yearValue('2')).toBe(2)
    expect(yearValue('2019')).toBe(2019)
    const draft = draftOf(protocolFile())
    expect(draftProblems({ ...draft, years: { from: yearValue('2'), to: null } })).toEqual(['mappings.protocol.errors.years'])
    expect(draftProblems({ ...draft, years: { from: yearValue('2019.5'), to: null } })).toEqual(['mappings.protocol.errors.years'])
    expect(draftProblems({ ...draft, years: { from: yearValue('abc'), to: null } })).toEqual(['mappings.protocol.errors.years'])
  })

  it('tells when the saved protocol changed under a draft being edited', () => {
    const file = protocolFile()
    const edit = { base: file.version, from: draftOf(file) }
    expect(draftOutdated(edit, file)).toBe(false)
    // Edited in place elsewhere (before any decision the version stays 1).
    expect(draftOutdated(edit, protocolFile({}, { objective: 'Changed on another machine.' }))).toBe(true)
    // A new version elsewhere, even with the same body.
    expect(draftOutdated(edit, protocolFile({ version: 2 }))).toBe(true)
  })

  it('prefills the OpenAlex types from the accepted publication types', () => {
    expect(openAlexTypesFor(['article', 'conference', 'chapter', 'web'])).toEqual(['article', 'book-chapter'])
  })
})

describe('labels', () => {
  const file = protocolFile()
  it('names states with their criterion, and searches by source and filters', () => {
    expect(phaseLabel(t, { ...EMPTY_PHASE_VIEW, state: 'exclude', criterion: 'E1' }, file)).toBe('mappings.state.exclude · E1 · Not about software logs.')
    expect(phaseLabel(t, EMPTY_PHASE_VIEW, file)).toBe('mappings.state.pending')
    expect(searchSource(t, search())).toBe('Scopus')
    expect(searchSource(t, search({ kind: 'library', database: 'library' }))).toBe('mappings.sources.library')
    expect(searchSource(t, search({ kind: 'snowball', database: 'OpenAlex', origin: { direction: 'forward', from: [], iteration: 2 } }))).toBe(
      'mappings.searches.snowball_label {"iteration":2,"direction":"mappings.searches.directions.forward"}'
    )
    expect(searchFilters(search({ filters: { publication_year: '2015-2026', type: 'article' } }))).toBe('publication_year: 2015-2026 · type: article')
  })

  it('shows a criterion with the wording of the protocol version the decision was made with', () => {
    const changed = protocolFile(
      { version: 2, history: [{ version: 1, replaced_at: AT, protocol: protocolFile().protocol }] },
      { exclusion: [{ id: 'E1', text: 'Not about logs at all.' }] }
    )
    expect(phaseLabel(t, { ...EMPTY_PHASE_VIEW, state: 'exclude', criterion: 'E1', protocolVersion: 1 }, changed)).toBe('mappings.state.exclude · E1 · Not about software logs.')
    expect(phaseLabel(t, { ...EMPTY_PHASE_VIEW, state: 'exclude', criterion: 'E1', protocolVersion: 2 }, changed)).toBe('mappings.state.exclude · E1 · Not about logs at all.')
    expect(phaseLabel(t, { ...EMPTY_PHASE_VIEW, state: 'exclude', criterion: 'E2', protocolVersion: 1 }, changed)).toBe('mappings.state.exclude · E2 · Not peer reviewed.')
    expect(phaseLabel(t, { ...EMPTY_PHASE_VIEW, state: 'exclude', criterion: 'E9' }, changed)).toBe('mappings.state.exclude · E9')
  })

  it('writes the cost lines of a suggestion plan', () => {
    const plan = { phase: 'title_abstract' as const, count: 45, calls: 3, estimateUsd: 0.3, perCallUsd: 0.5, batchCapUsd: 10, monthSpentUsd: 1.234, monthCapUsd: null, withoutText: 0 }
    expect(planLines(t, plan)).toEqual([
      'mappings.screening.suggest_confirm {"count":45,"calls":3,"cost":"0.30"}',
      'mappings.screening.suggest_caps {"call":"0.50","batch":"10.00"}',
      'mappings.screening.month_no_cap {"spent":"1.23"}'
    ])
    expect(planLines(t, { ...plan, phase: 'full_text', monthCapUsd: 20, withoutText: 2 }).slice(2)).toEqual([
      'mappings.screening.month {"spent":"1.23","cap":"20.00"}',
      'mappings.screening.without_text {"count":2}'
    ])
  })

  it('finds a quote inside an abstract for its highlight', () => {
    expect(highlight('We propose an online log parser.', 'online  log parser')).toEqual({ before: 'We propose an ', match: 'online log parser', after: '.' })
    expect(highlight('We propose an online log parser.', 'not there at all')).toBeNull()
    expect(highlight('Text.', null)).toBeNull()
  })

  it('labels the PRISMA boxes with the criteria texts, and names its files', () => {
    const labels = prismaLabels(t, file)
    expect(labels.reason('E1', 2)).toBe('mappings.prisma.reason {"criterion":"E1 · Not about software logs.","count":2}')
    expect(labels.source({ kind: 'snowball', database: 'snowball', count: 4 })).toBe('mappings.prisma.source {"source":"mappings.prisma.snowball","count":4}')
    expect(labels.screened(5, 0)).toBe('mappings.prisma.screened {"count":5}')
    expect(labels.screened(5, 2)).toBe('mappings.prisma.screened_pending {"count":5,"pending":2}')
    expect(prismaFileName('Anonimización de logs: 2026', 'svg')).toBe('prisma-anonimizacion-de-logs-2026.svg')
    expect(prismaFileName('¿?', 'png')).toBe('prisma-mapeo.png')
  })
})
