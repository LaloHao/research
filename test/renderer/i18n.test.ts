import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import type { JobState } from '../../src/shared/jobs'
import { FILE_PROBLEM_KINDS, JOB_OUTCOMES, TEXT_STATUSES, USER_ERROR_CODES } from '../../src/shared/library'
import { PDF_POLICIES } from '../../src/shared/schemas'
import { CANDIDATE_DIRECTIONS, CHART_KINDS, CITATIONS_STATUSES } from '../../src/shared/relations'
import { LLM_MODELS, RESEARCH_TYPES, SUMMARY_FIELD_KEYS } from '../../src/shared/summary'
import type { CardStatus } from '../../src/renderer/lib/summaryView'
import { SUMMARY_FILTERS } from '../../src/renderer/lib/badges'
import { MAP_TABS, VIEWS } from '../../src/renderer/lib/navigation'
import { SETTINGS_TABS } from '../../src/renderer/lib/settingsTabs'

const lookup = (path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], es)
const JOB_STATES: JobState[] = ['queued', 'running', 'done', 'failed', 'cancelled']
const CARD_STATUSES: CardStatus[] = ['generated', 'verified', 'edited', 'evidence_missing']

// Every code the main process can send must have a Spanish string; a missing one would show the raw code.
describe('es.json covers every code the UI can receive', () => {
  it.each([
    ...USER_ERROR_CODES.map((c) => `errors.${c}`),
    ...TEXT_STATUSES.map((s) => `text_status.${s}`),
    ...JOB_OUTCOMES.map((s) => `jobs.outcome.${s}`),
    ...JOB_STATES.map((s) => `jobs.state.${s}`),
    ...PDF_POLICIES.map((p) => `settings.pdf_policy.${p}`),
    ...FILE_PROBLEM_KINDS.map((k) => `paper.problem_kinds.${k}`),
    ...['problem', 'incomplete', 'web', 'no_pdf', 'summary_none', 'to_review', 'reviewed', 'stale', 'summary_failed', 'no_citations'].map((b) => `badges.${b}`),
    ...SUMMARY_FIELD_KEYS.map((k) => `summary.fields.${k}`),
    ...RESEARCH_TYPES.map((r) => `summary.research_types.${r}`),
    ...CARD_STATUSES.map((s) => `summary.status.${s}`),
    ...LLM_MODELS.map((m) => `settings.models.${m}`),
    ...SUMMARY_FILTERS.map((f) => `library.summary_filter.${f}`),
    ...SETTINGS_TABS.map((tab) => `settings.tabs.${tab}`),
    ...VIEWS.map((v) => `rail.${v}`),
    ...MAP_TABS.map((tab) => `map.tabs.${tab}`),
    ...['citations', 'cited_by', 'embed', 'model_download'].map((type) => `jobs.${type}`),
    ...['coupling_one', 'coupling_other', 'cocitation_one', 'cocitation_other', 'direct', 'content'].map((k) => `relations.reasons.${k}`),
    ...['score', 'no_value', 'no_relation', 'other_values', 'legend_count', 'model_missing', 'export_png', 'exported'].map((k) => `map.graph.${k}`),
    ...CHART_KINDS.map((k) => `map.charts.kinds.${k}`),
    ...['tip', 'tip_unreviewed', 'only_reviewed', 'empty', 'no_facets'].map((k) => `map.charts.${k}`),
    ...CANDIDATE_DIRECTIONS.map((d) => `map.candidates.directions.${d}`),
    ...['title', 'year', 'authors', 'cited_by_library', 'cites_library', 'total'].map((c) => `map.candidates.columns.${c}`),
    ...['cited_by_queued', 'added', 'empty', 'metadata_error', 'showing'].map((k) => `map.candidates.${k}`),
    'paper.tabs.summary',
    'summary.thesis_missing',
    'summary.thesis_pending',
    'summary.truncated',
    'summary.thesis_outdated',
    ...CITATIONS_STATUSES.map((s) => `relations.state.${s}`),
    'paper.tabs.relations',
    'relations.external_one',
    'relations.external_other',
    'library.citations_queued',
    'settings.local_models.state.missing',
    'settings.local_models.state.ready',
    'settings.openalex_key',
    'settings.openalex_key_help'
  ])('%s', (path) => {
    expect(typeof lookup(path)).toBe('string')
  })
})
