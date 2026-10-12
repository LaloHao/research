import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { toYaml } from '../../../src/main/project/yamlFile'
import { keepOurs, mergeCostsText, mergeFacetSuggestionsText, mergeProjectText, mergeRelationsText, mergerFor, mergeTrashedText } from '../../../src/main/sync/mergers'
import type { FacetSuggestion } from '../../../src/shared/facetSuggestions'
import { aliasSuggestion, newFacetSuggestion, newValueSuggestion } from '../../helpers/facets'
import type { TypedRelation } from '../../../src/shared/typedRelations'
import { typedRelation } from '../../helpers/relations'

const relationsText = (relations: TypedRelation[], analyzed: Record<string, unknown> = {}): string => toYaml({ schema_version: 1, relations, analyzed })
const ids = (text: string | null): string[] => (parse(text ?? '') as { relations: TypedRelation[] }).relations.map((r) => r.id)

const EXTENDS = typedRelation()
const SAME = typedRelation({ type: 'same_problem' })
const USES = typedRelation({ type: 'uses_method_of' })

describe('mergerFor', () => {
  it('picks a merger by the path inside the project, and none for the files that need a decision', () => {
    expect(mergerFor('relations.yaml')).toBe(mergeRelationsText)
    expect(mergerFor('costs/22222222-2222-2222-2222-222222222222.jsonl')).toBe(mergeCostsText)
    expect(mergerFor('project.yaml')).toBe(mergeProjectText)
    expect(mergerFor('.trash/he2017drain/trashed.yaml')).toBe(mergeTrashedText)
    expect(mergerFor('exports/library.bib')).toBe(keepOurs)
    for (const path of ['papers/he2017drain/summary.md', 'papers/he2017drain/notes.md', 'papers/x/relations.yaml', 'costs/../x.jsonl', 'notes.md']) {
      expect(mergerFor(path)).toBeNull()
    }
  })
})

describe('relations.yaml', () => {
  it('joins by id, the newest change wins, and a removal the other side did not touch stays removed', () => {
    const base = relationsText([EXTENDS, SAME])
    const ours = relationsText([{ ...EXTENDS, status: 'confirmed', updated_at: '2026-10-11T00:00:00.000Z' }, USES])
    const theirs = relationsText([{ ...EXTENDS, justification: 'An older edit.', updated_at: '2026-10-10T06:00:00.000Z' }, SAME])
    const merged = parse(mergeRelationsText({ base, ours, theirs })!) as { relations: TypedRelation[] }
    expect(merged.relations.map((r) => r.id)).toEqual([EXTENDS.id, USES.id])
    expect(merged.relations[0].status).toBe('confirmed')
  })

  it('keeps a relation one side removed while the other changed it', () => {
    const base = relationsText([EXTENDS])
    const edited = { ...EXTENDS, justification: 'Reworded.', updated_at: '2026-10-11T00:00:00.000Z' }
    expect(ids(mergeRelationsText({ base, ours: relationsText([]), theirs: relationsText([edited]) }))).toEqual([EXTENDS.id])
  })

  it('joins the analyzed papers, newest analysis first', () => {
    const older = { candidates: ['zhu2020loghub'], at: '2026-10-10T00:00:00.000Z' }
    const newer = { candidates: ['zhu2020loghub', 'x2021y'], at: '2026-10-11T00:00:00.000Z' }
    const merged = parse(
      mergeRelationsText({ base: null, ours: relationsText([], { he2017drain: older }), theirs: relationsText([], { he2017drain: newer, zhu2020loghub: older }) })!
    ) as { analyzed: Record<string, unknown> }
    expect(merged.analyzed).toEqual({ he2017drain: newer, zhu2020loghub: older })
  })

  it('keeps a one-sided edit even when its clock is behind the base (no clock-skew data loss)', () => {
    const base = relationsText([{ ...EXTENDS, updated_at: '2026-10-11T10:00:00.000Z' }])
    const ours = base
    const theirs = relationsText([{ ...EXTENDS, status: 'confirmed', updated_at: '2026-10-11T09:50:00.000Z' }])
    const merged = parse(mergeRelationsText({ base, ours, theirs })!) as { relations: TypedRelation[] }
    expect(merged.relations[0].status).toBe('confirmed')
  })

  it('the mirror case: our edit survives behind the base clock too', () => {
    const base = relationsText([{ ...EXTENDS, updated_at: '2026-10-11T10:00:00.000Z' }])
    const ours = relationsText([{ ...EXTENDS, status: 'confirmed', updated_at: '2026-10-11T09:50:00.000Z' }])
    const theirs = base
    const merged = parse(mergeRelationsText({ base, ours, theirs })!) as { relations: TypedRelation[] }
    expect(merged.relations[0].status).toBe('confirmed')
  })

  it('keeps a one-sided analysis update despite clock skew too', () => {
    const base = relationsText([], { he2017drain: { candidates: ['a'], at: '2026-10-11T10:00:00.000Z' } })
    const ours = base
    const theirs = relationsText([], { he2017drain: { candidates: ['a', 'b'], at: '2026-10-11T09:50:00.000Z' } })
    const merged = parse(mergeRelationsText({ base, ours, theirs })!) as { analyzed: Record<string, unknown> }
    expect(merged.analyzed.he2017drain).toEqual({ candidates: ['a', 'b'], at: '2026-10-11T09:50:00.000Z' })
  })

  it('leaves to the user a side with invalid entries, another format or broken YAML', () => {
    const ours = relationsText([EXTENDS])
    expect(mergeRelationsText({ base: null, ours, theirs: toYaml({ schema_version: 1, relations: [{ id: 'nope' }], analyzed: {} }) })).toBeNull()
    expect(mergeRelationsText({ base: null, ours, theirs: toYaml({ schema_version: 2, relations: [] }) })).toBeNull()
    expect(mergeRelationsText({ base: null, ours, theirs: 'relations: [' })).toBeNull()
  })
})

describe('the other mergers', () => {
  it('joins the lines of a cost log without repeating any', () => {
    const line = (n: number): string => JSON.stringify({ at: `2026-10-0${n}T00:00:00.000Z`, cost_usd: n })
    expect(mergeCostsText({ base: `${line(1)}\n`, ours: `${line(1)}\n${line(2)}\n`, theirs: `${line(1)}\n${line(3)}\n` })).toBe(`${line(1)}\n${line(2)}\n${line(3)}\n`)
  })

  it('merges project.yaml key by key, joins the dismissed candidates, and leaves a real clash to the user', () => {
    const cfg = (over: Record<string, unknown>): string => toYaml({ schema_version: 1, name: 'Thesis', content_language: 'en', snowball: { dismissed: ['W1'] }, ...over })
    const base = cfg({})
    const ours = cfg({ snowball: { dismissed: ['W1', 'W2'] }, content_language: 'es' })
    const theirs = cfg({ snowball: { dismissed: ['W1', 'W3'] }, thesis: { title: 'Logs' } })
    expect(parse(mergeProjectText({ base, ours, theirs })!)).toEqual({
      schema_version: 1,
      name: 'Thesis',
      content_language: 'es',
      snowball: { dismissed: ['W1', 'W2', 'W3'] },
      thesis: { title: 'Logs' }
    })
    expect(mergeProjectText({ base, ours: cfg({ name: 'Mine' }), theirs: cfg({ name: 'Theirs' }) })).toBeNull()
    expect(mergeProjectText({ base, ours: 'name: [', theirs })).toBeNull()
  })

  it('keeps the newest trashed.yaml when both machines trashed the same paper', () => {
    const at = (iso: string): string => `schema_version: 1\ntrashed_at: '${iso}'\ndevice: 22222222-2222-2222-2222-222222222222\n`
    const early = at('2026-10-11T10:00:00.000Z')
    const late = at('2026-10-11T12:00:00.000Z')
    expect(mergeTrashedText({ base: null, ours: early, theirs: late })).toBe(late)
    expect(mergeTrashedText({ base: null, ours: late, theirs: early })).toBe(late)
    expect(mergeTrashedText({ base: null, ours: 'nope: [', theirs: early })).toBeNull()
  })

  it('keeps this machine\'s generated bibliography (the app writes it again)', () => {
    expect(keepOurs({ base: null, ours: 'mine', theirs: 'theirs' })).toBe('mine')
  })
})

const suggestionsText = (suggestions: FacetSuggestion[], lastRun?: object): string => toYaml({ schema_version: 1, suggestions, ...(lastRun ? { last_run: lastRun } : {}) })
const mergedSuggestions = (text: string | null) => parse(text ?? '') as { suggestions: FacetSuggestion[]; last_run?: { at: string } }

describe('facet-suggestions.yaml', () => {
  const FACET = newFacetSuggestion()
  const VALUE = newValueSuggestion()
  const ALIAS = aliasSuggestion()

  it('is merged by the app', () => {
    expect(mergerFor('facet-suggestions.yaml')).toBe(mergeFacetSuggestionsText)
  })

  it("joins by id, and a suggestion changed on one machine takes that machine's version whatever the clocks say", () => {
    const base = suggestionsText([FACET, VALUE])
    // This machine's clock is behind: its decision still wins, since the other machine left the suggestion as it was.
    const ours = suggestionsText([{ ...FACET, status: 'rejected', updated_at: '2026-10-10T00:00:00.000Z' }, VALUE])
    const theirs = suggestionsText([FACET, VALUE, ALIAS])
    const out = mergedSuggestions(mergeFacetSuggestionsText({ base, ours, theirs }))
    expect(out.suggestions.map((s) => [s.id, s.status])).toEqual([
      [ALIAS.id, 'suggested'],
      [FACET.id, 'rejected'],
      [VALUE.id, 'suggested']
    ])
  })

  it('takes the latest change when both machines changed a suggestion, and keeps a removal the other side did not touch', () => {
    const base = suggestionsText([FACET, VALUE])
    const ours = suggestionsText([{ ...FACET, status: 'rejected', updated_at: '2026-10-11T10:00:00.000Z' }])
    const theirs = suggestionsText([{ ...FACET, status: 'accepted', updated_at: '2026-10-11T11:00:00.000Z' }, VALUE])
    const out = mergedSuggestions(mergeFacetSuggestionsText({ base, ours, theirs }))
    expect(out.suggestions.map((s) => [s.id, s.status])).toEqual([[FACET.id, 'accepted']])
  })

  it('keeps the last run only one machine changed, or the newest when both did', () => {
    const run = (at: string, ok = true) => ({ at, ok, summarized: 3 })
    const base = suggestionsText([], run('2026-10-10T00:00:00.000Z'))
    const later = suggestionsText([], run('2026-10-11T00:00:00.000Z', false))
    expect(mergedSuggestions(mergeFacetSuggestionsText({ base, ours: base, theirs: later })).last_run?.at).toBe('2026-10-11T00:00:00.000Z')
    const newest = suggestionsText([], run('2026-10-12T00:00:00.000Z'))
    expect(mergedSuggestions(mergeFacetSuggestionsText({ base, ours: newest, theirs: later })).last_run?.at).toBe('2026-10-12T00:00:00.000Z')
    expect(mergedSuggestions(mergeFacetSuggestionsText({ base: null, ours: suggestionsText([]), theirs: later })).last_run?.at).toBe('2026-10-11T00:00:00.000Z')
  })

  it('leaves the file to the user when a side cannot be read or has another schema version', () => {
    const ok = suggestionsText([FACET])
    expect(mergeFacetSuggestionsText({ base: null, ours: ok, theirs: 'schema_version: 1\nsuggestions: [{ id: broken }]\n' })).toBeNull()
    expect(mergeFacetSuggestionsText({ base: null, ours: ok, theirs: 'schema_version: 2\nsuggestions: []\n' })).toBeNull()
  })
})
