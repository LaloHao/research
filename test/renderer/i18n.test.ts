import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import type { JobState } from '../../src/shared/jobs'
import { FILE_PROBLEM_KINDS, JOB_OUTCOMES, TEXT_STATUSES, USER_ERROR_CODES } from '../../src/shared/library'
import { PAPER_KINDS, PDF_POLICIES } from '../../src/shared/schemas'
import { CANDIDATE_DIRECTIONS, CHART_KINDS, CITATIONS_STATUSES } from '../../src/shared/relations'
import { LLM_MODELS, RESEARCH_TYPES, SUMMARY_FIELD_KEYS } from '../../src/shared/summary'
import type { CardStatus } from '../../src/renderer/lib/summaryView'
import { SUMMARY_FILTERS } from '../../src/renderer/lib/badges'
import { MAP_TABS, MAPPING_TABS, VIEWS, WRITING_TABS } from '../../src/renderer/lib/navigation'
import { API_START_ERRORS } from '../../src/shared/localApi'
import { SKIP_REASONS } from '../../src/shared/writing/api'
import { BIB_FIELDS_CHECKED, BIB_ORDERS } from '../../src/shared/writing/bibtex'
import { CITE_FORMATS, KEY_STATES } from '../../src/shared/writing/citations'
import { DUPLICATE_REASONS, OPENALEX_TYPES, PHASE_STATES, PHASES, QUEUE_FILTERS, SNOWBALL_DIRECTIONS } from '../../src/shared/mapping'
import { SETTINGS_TABS } from '../../src/renderer/lib/settingsTabs'
import { RELATION_TYPES } from '../../src/shared/typedRelations'
import { TRASH_PROBLEMS } from '../../src/shared/trash'
import { CONFLICT_SIDES, SYNC_ERROR_CODES } from '../../src/shared/sync'
import { SYNC_STATES } from '../../src/renderer/lib/sync'
import { FACET_SUGGESTION_KINDS, SUGGESTION_VALIDITIES } from '../../src/shared/facetSuggestions'
import { CITATION_STATES } from '../../src/shared/chat'
import { ACTION_RISKS, ACTION_TOOLS, DENIAL_REASONS } from '../../src/shared/chatActions'

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
    ...['problem', 'incomplete', 'web', 'no_pdf', 'summary_none', 'to_review', 'reviewed', 'stale', 'summary_failed', 'no_citations', 'unfilled'].map((b) => `badges.${b}`),
    ...SUMMARY_FIELD_KEYS.map((k) => `summary.fields.${k}`),
    ...RESEARCH_TYPES.map((r) => `summary.research_types.${r}`),
    ...CARD_STATUSES.map((s) => `summary.status.${s}`),
    ...LLM_MODELS.map((m) => `settings.models.${m}`),
    ...SUMMARY_FILTERS.map((f) => `library.summary_filter.${f}`),
    ...SETTINGS_TABS.map((tab) => `settings.tabs.${tab}`),
    ...VIEWS.map((v) => `rail.${v}`),
    ...MAP_TABS.map((tab) => `map.tabs.${tab}`),
    ...MAPPING_TABS.map((tab) => `mappings.tabs.${tab}`),
    ...PHASE_STATES.map((s) => `mappings.state.${s}`),
    ...PHASES.map((p) => `mappings.screening.phases.${p}`),
    ...PHASES.map((p) => `mappings.screening.shortcuts_${p}`),
    ...QUEUE_FILTERS.map((f) => `mappings.screening.filters.${f}`),
    ...DUPLICATE_REASONS.map((r) => `mappings.screening.duplicate_reasons.${r}`),
    ...SNOWBALL_DIRECTIONS.map((d) => `mappings.searches.directions.${d}`),
    ...PAPER_KINDS.map((k) => `mappings.kinds.${k}`),
    ...OPENALEX_TYPES.map((k) => `mappings.openalex_types.${k}`),
    ...['identification', 'screening', 'included'].map((k) => `mappings.prisma.stages.${k}`),
    'mappings.prisma.inconsistent_one',
    'mappings.prisma.inconsistent_other',
    ...['protocol.errors.title', 'protocol.errors.empty_item', 'protocol.errors.years', 'screening.without_text_one', 'screening.without_text_other'].map((k) => `mappings.${k}`),
    ...['confirm_snowball_one', 'confirm_snowball_other', 'truncated', 'pick_again', 'inconsistent', 'years_invalid'].map((k) => `mappings.searches.${k}`),
    ...['count_received', 'count_read', 'count_found'].flatMap((k) => [`mappings.searches.${k}_one`, `mappings.searches.${k}_other`]),
    ...['duplicate_pending', 'inactive', 'conflict_pending', 'unchanged', 'same_keeps'].map((k) => `mappings.screening.${k}`),
    ...['citations', 'cited_by', 'embed', 'model_download', 'suggest_relations', 'fill_facets', 'suggest_facets', 'suggest_facets_auto'].map((type) => `jobs.${type}`),
    ...['mapping_search', 'mapping_snowball', 'screen_suggest', 'ingest_record'].map((type) => `jobs.${type}`),
    ...['coupling_one', 'coupling_other', 'cocitation_one', 'cocitation_other', 'direct', 'content'].map((k) => `relations.reasons.${k}`),
    ...['score', 'no_value', 'no_relation', 'other_values', 'legend_count', 'model_missing', 'export_png', 'exported'].map((k) => `map.graph.${k}`),
    ...['typed', 'hide_suggested', 'typed_hover'].map((k) => `map.graph.${k}`),
    'typed.status.suggested',
    'typed.status.confirmed',
    ...CHART_KINDS.map((k) => `map.charts.kinds.${k}`),
    ...['tip', 'tip_unreviewed', 'only_reviewed', 'empty', 'no_facets'].map((k) => `map.charts.${k}`),
    ...CANDIDATE_DIRECTIONS.map((d) => `map.candidates.directions.${d}`),
    ...['title', 'year', 'authors', 'cited_by_library', 'cites_library', 'total'].map((c) => `map.candidates.columns.${c}`),
    ...['cited_by_queued', 'added', 'empty', 'metadata_error', 'showing'].map((k) => `map.candidates.${k}`),
    'paper.tabs.summary',
    ...['passage_pdf', 'passage_content', 'passage_loading', 'quote_not_in_pdf_reflow'].map((k) => `review.${k}`),
    'paper.content.image',
    'paper.content.image_unavailable',
    'paper.content.quote_not_found',
    'paper.tabs.pdf',
    'paper.tabs.text',
    ...['loading', 'error', 'page', 'previous', 'next', 'go_to', 'search_placeholder', 'search', 'searching', 'results_one', 'results_other', 'result_position', 'no_results', 'previous_result', 'next_result', 'empty_page'].map((k) => `paper.text.${k}`),
    'summary.thesis_missing',
    'summary.thesis_pending',
    'summary.truncated',
    'summary.thesis_outdated',
    ...CITATIONS_STATUSES.map((s) => `relations.state.${s}`),
    'paper.tabs.relations',
    'paper.tabs.chat',
    'chat.ask_claude',
    'chat.ask_claude_unquotable',
    'settings.budget_chat',
    'relations.external_one',
    'relations.external_other',
    'library.citations_queued',
    ...['suggest_relations', 'suggest_relations_all', 'suggest_relations_filtered', 'relations_none', 'relations_queued'].map((k) => `library.${k}`),
    'settings.local_models.state.missing',
    'settings.local_models.state.ready',
    'settings.openalex_key',
    'settings.openalex_key_help',
    ...RELATION_TYPES.flatMap((type) => [`typed.types.${type}`, `typed.sentence.${type}`]),
    ...['confirmed', 'rejected', 'suggested', 'retyped', 'reversed', 'justified'].map((k) => `typed.done.${k}`),
    ...['conflict', 'invalid', 'resolve', 'show', 'resolved_dropped_one', 'resolved_dropped_other', 'dismiss'].map((k) => `typed.file.${k}`),
    ...['title', 'suggest', 'suggest_again', 'suggest_queued', 'pending_one', 'pending_other', 'up_to_date', 'no_candidates', 'suggested', 'confirmed', 'rejected', 'none_suggested', 'none_confirmed', 'confirm', 'reject', 'change_type', 'reverse', 'edit_justification', 'back_to_suggested', 'restore', 'undo', 'retry', 'edited', 'evidence_in', 'open_paper', 'generated_with'].map((k) => `typed.${k}`),
    'review.relation_shortcuts',
    'review.decided',
    'settings.auto_suggest_relations',
    'settings.auto_suggest_relations_help',
    'jobs.attach_pdf',
    'paper.no_pdf',
    ...['attach', 'replace', 'confirm', 'confirm_file', 'confirm_replace', 'cancel', 'queued', 'drop_hint', 'drop_hint_replace', 'only_one_pdf'].map((k) => `paper.attach.${k}`),
    ...['title', 'search_placeholder', 'empty', 'no_results', 'select_visible', 'restore', 'restore_selected', 'delete_forever', 'delete_selected', 'empty_trash', 'delete_confirm_one', 'delete_confirm_other', 'empty_confirm_one', 'empty_confirm_other', 'conflict', 'merge', 'restored_one', 'restored_other', 'restored_as', 'restored_remnant', 'restored_index_failed', 'deleted_one', 'deleted_other', 'removed_on', 'unknown_date', 'problem'].map((k) => `trash.${k}`),
    ...TRASH_PROBLEMS.map((k) => `trash.problems.${k}`),
    ...['this', 'other', 'unknown'].map((k) => `trash.device.${k}`),
    'paper.remove',
    'paper.remove_confirm',
    ...['remove_filtered', 'remove_filtered_hint', 'remove_confirm_one', 'remove_confirm_other'].map((k) => `library.${k}`),
    ...['moved_one', 'moved_other', 'undo', 'undo_conflict'].map((k) => `trash.${k}`),
    ...['in_trash', 'restore', 'restored', 'restore_conflict'].map((k) => `map.candidates.${k}`),
    ...SYNC_STATES.flatMap((s) => [`sync.status.${s}`, `sync.short.${s}`]),
    ...SYNC_ERROR_CODES.map((c) => `sync.errors.${c}`),
    ...CONFLICT_SIDES.map((s) => `sync.sides.${s}`),
    ...['title', 'run', 'repo', 'repo_upstream', 'done', 'rail_title', 'retry'].map((k) => `sync.${k}`),
    ...['no_git', 'no_repo', 'no_remote', 'no_upstream', 'url_label', 'url_placeholder', 'url_help', 'url_fix_help', 'init', 'add_remote', 'connect', 'url_empty', 'url_password', 'url_invalid'].map(
      (k) => `sync.setup.${k}`
    ),
    ...[
      'title',
      'intro',
      'history_note',
      'paper',
      'paper_key',
      'mine',
      'theirs',
      'keep_mine',
      'use_theirs',
      'keep_paper',
      'accept_removal',
      'show_diff',
      'hide_diff',
      'loading_diff',
      'finish',
      'cancel',
      'cancel_help',
      'pending_one',
      'pending_other',
      'changed',
      'wait_sync',
      'diff_mine',
      'diff_theirs',
      'diff_deleted',
      'diff_binary',
      'diff_too_large'
    ].map((k) => `sync.conflicts.${k}`),
    ...['title', 'body', 'sync_and_close', 'close_anyway', 'cancel', 'syncing', 'conflicts', 'open_sync'].map((k) => `sync.close.${k}`),
    ...['title', 'enabled', 'enabled_help', 'minutes', 'minutes_help'].map((k) => `sync.auto.${k}`),
    ...SUGGESTION_VALIDITIES.filter((v) => v !== 'ok').map((v) => `facets.invalid.${v}`),
    ...FACET_SUGGESTION_KINDS.map((k) => `facets.kinds.${k}`),
    ...[
      'title',
      'intro',
      'suggest',
      'confirm_one',
      'confirm_other',
      'queued',
      'running',
      'pending_one',
      'pending_other',
      'none',
      'last_run',
      'last_run_failed',
      'rationale',
      'examples',
      'example_quote',
      'example_page',
      'quote_not_found',
      'close_quote',
      'accept',
      'edit_accept',
      'save_accept',
      'cancel',
      'reject',
      'restore',
      'undo',
      'value_label',
      'to_label',
      'values_label',
      'accepted_title_one',
      'accepted_title_other',
      'rejected_title_one',
      'rejected_title_other',
      'form_dirty',
      'fill_offer_one',
      'fill_offer_other',
      'fill_one',
      'fill_other',
      'fill_queued_one',
      'fill_queued_other',
      'later',
      'unfilled',
      'unfilled_banner',
      'fill_paper',
      'fill_confirm_one',
      'fill_confirm_other'
    ].map((k) => `facets.${k}`),
    ...['fill_facets', 'fill_facets_all', 'fill_facets_filtered', 'fill_none'].map((k) => `library.${k}`),
    ...['accepted', 'rejected', 'restored'].map((k) => `facets.done.${k}`),
    ...['new_value', 'alias'].map((k) => `facets.proposal.${k}`),
    'facets.file.conflict',
    'facets.file.invalid',
    'settings.tabs.form_count',
    ...['auto_suggest_facets', 'auto_suggest_facets_help', 'auto_suggest_facets_after', 'budget_facets'].map((k) => `settings.${k}`),
    ...CITATION_STATES.map((s) => `chat.citation.${s}`),
    ...[
      'new',
      'search_placeholder',
      'paper_filter_all',
      'library_scope',
      'archived_one',
      'archived_other',
      'empty',
      'no_results',
      'intro_library',
      'intro_paper',
      'copy_title',
      'other_machine',
      'problem',
      'about_paper',
      'paper_in_trash_banner',
      'paper_missing_banner',
      'model',
      'total_cost',
      'rename',
      'rename_save',
      'archive',
      'unarchive',
      'delete',
      'delete_confirm',
      'delete_yes',
      'cancel',
      'you',
      'claude',
      'placeholder',
      'send',
      'stop',
      'retry',
      'thinking',
      'tools_one',
      'tools_other',
      'stopped',
      'stopped_empty',
      'empty_answer',
      'unanswered',
      'answer_cost',
      'unverified_one',
      'unverified_other',
      'quoted',
      'copy',
      'copied',
      'save_notes',
      'save_notes_pick',
      'save_notes_confirm',
      'cited_option',
      'saved_notes',
      'copy_bibtex',
      'copied_bibtex',
      'no_citations',
      'excerpt',
      'excerpt_no_page',
      'remove_excerpt',
      'close_evidence'
    ].map((k) => `chat.${k}`),
    ...ACTION_TOOLS.map((tool) => `chat.actions.tools.${tool}`),
    ...['undo', 'unknown', 'resolve_proposed_value_accept', 'resolve_proposed_value_map', 'attach_pdf_replace', 'fill_facets_all', 'review_summary_all'].map((k) => `chat.actions.tools.${k}`),
    ...['confirm', 'reject', 'back_to_suggested', 'change_type', 'reverse', 'accept', 'restore'].map((d) => `chat.actions.decisions.${d}`),
    ...DENIAL_REASONS.map((r) => `chat.actions.denied.${r}`),
    ...ACTION_RISKS.map((r) => `chat.actions.risk.${r}`),
    ...['estimate_one', 'estimate_other', 'cap', 'caps', 'month', 'month_no_cap'].map((k) => `chat.actions.cost.${k}`),
    ...['ours', 'theirs'].map((c) => `chat.actions.conflict_choice.${c}`),
    ...[
      'switch_actions',
      'switch_actions_hint',
      'switch_sync',
      'switch_sync_hint',
      'record_head',
      'thesis',
      'executed_request',
      'executed_user',
      'still_running',
      'undone_by_you',
      'undone',
      'failed',
      'undo',
      'approval_title',
      'not_requested',
      'requested',
      'limit',
      'relations_deleted_one',
      'relations_deleted_other',
      'replaces_pdf',
      'approve',
      'deny',
      'pick_pdf',
      'expires_one',
      'expires_other'
    ].map((k) => `chat.actions.${k}`),
    'chat.actions.review_status.verified',
    'chat.actions.review_status.generated',
    ...WRITING_TABS.map((tab) => `writing.tabs.${tab}`),
    ...CITE_FORMATS.map((f) => `writing.format.formats.${f}`),
    ...KEY_STATES.map((k) => `writing.key_state.${k}`),
    ...API_START_ERRORS.map((e) => `local_api.errors.${e}`),
    ...SKIP_REASONS.map((r) => `writing.bibtex.skip_reasons.${r}`),
    ...BIB_ORDERS.map((o) => `writing.bibtex.orders.${o}`),
    ...BIB_FIELDS_CHECKED.map((f) => `writing.bibtex.fields.${f}`),
    ...['budget_draft', 'budget_cite_check', 'budget_outline', 'budget_style', 'budget_writing_help'].map((k) => `settings.${k}`)
  ])('%s', (path) => {
    expect(typeof lookup(path)).toBe('string')
  })
})

describe('cap errors name the setting that lifts them', () => {
  it('a chat answer at its cap points to the per-message cap, not the per-paper one', () => {
    expect(lookup('errors.chat_message_budget')).toContain(`«${lookup('settings.budget_chat') as string}»`)
    expect(lookup('errors.operation_budget')).toContain(`«${lookup('settings.budget_operation') as string}»`)
  })
})

describe('mapping strings', () => {
  /** Literal `t('mappings.…')` keys of a source file (template keys are covered by the lists above). */
  const keysIn = (text: string): string[] => [...text.matchAll(/\bt\(\s*'(mappings\.[A-Za-z0-9_.-]+)'/g)].map((m) => m[1])

  it('exist for every literal key the mapping components and helpers use', () => {
    const dir = new URL('../../src/renderer/components/mappings/', import.meta.url)
    const files = [new URL('../../src/renderer/lib/mappings.ts', import.meta.url), ...(existsSync(dir) ? readdirSync(dir).map((name) => new URL(name, dir)) : [])]
    const missing = files.flatMap((file) => keysIn(readFileSync(file, 'utf8'))).filter((key) => typeof lookup(key) !== 'string' && typeof lookup(`${key}_other`) !== 'string')
    expect(missing).toEqual([])
  })
})

describe('writing strings', () => {
  /** Literal `t('writing.…')` keys of a source file (template keys are covered by the lists above). */
  const keysIn = (text: string): string[] => [...text.matchAll(/\bt\(\s*'(writing\.[A-Za-z0-9_.-]+)'/g)].map((m) => m[1])

  it('exist for every literal key the writing components use', () => {
    const dir = new URL('../../src/renderer/components/writing/', import.meta.url)
    const files = existsSync(dir) ? readdirSync(dir).map((name) => new URL(name, dir)) : []
    const keys = files.flatMap((file) => keysIn(readFileSync(file, 'utf8')))
    expect(keys.length).toBeGreaterThan(50)
    const missing = keys.filter((key) => typeof lookup(key) !== 'string' && typeof lookup(`${key}_other`) !== 'string')
    expect(missing).toEqual([])
  })
})
