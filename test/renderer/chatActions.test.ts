import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { actionKey, actionOutcome, actionText, approvalReason, costLines, minutesLeft } from '../../src/renderer/lib/chatActions'
import type { ActionMessage } from '../../src/shared/chat'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction
const record = (over: Partial<ActionMessage> = {}): ActionMessage => ({
  role: 'action',
  at: '2026-10-12T10:00:00.000Z',
  id: 'a0b1c2',
  tool: 'write_note',
  state: 'executed',
  approval: 'request',
  request: 'add a note',
  args: {},
  result: {},
  ...over
})

describe('actionKey', () => {
  it("picks each tool's sentence, its variants, the undo and a fallback for unknown tools", () => {
    expect(actionKey('trash_papers', {})).toBe('chat.actions.tools.trash_papers')
    expect(actionKey('resolve_proposed_value', { decision: 'map' })).toBe('chat.actions.tools.resolve_proposed_value_map')
    expect(actionKey('resolve_proposed_value', { decision: 'accept' })).toBe('chat.actions.tools.resolve_proposed_value_accept')
    expect(actionKey('attach_pdf', { replace: true })).toBe('chat.actions.tools.attach_pdf_replace')
    expect(actionKey('attach_pdf', {})).toBe('chat.actions.tools.attach_pdf')
    expect(actionKey('fill_facets', {})).toBe('chat.actions.tools.fill_facets_all')
    expect(actionKey('fill_facets', { paper_ids: ['he2017drain'] })).toBe('chat.actions.tools.fill_facets')
    expect(actionKey('review_summary', { status: 'verified' })).toBe('chat.actions.tools.review_summary_all')
    expect(actionKey('undo', { action: 'a0b1c2' })).toBe('chat.actions.tools.undo')
    expect(actionKey('rename_project', {})).toBe('chat.actions.tools.unknown')
  })
})

describe('actionText', () => {
  it('fills the sentence from the arguments', () => {
    expect(actionText(t, 'trash_papers', { paper_ids: ['he2017drain', 'zhu2020loghub'] })).toContain('"papers":"he2017drain, zhu2020loghub"')
    const relation = actionText(t, 'decide_relation', { relation_id: 'he2017drain__zhu2020loghub__extends', decision: 'change_type', type: 'contradicts' })
    expect(relation).toContain('"relation":"he2017drain – zhu2020loghub"')
    expect(relation).toContain('chat.actions.decisions.change_type')
    expect(relation).toContain('typed.types.contradicts')
    expect(actionText(t, 'resolve_sync_conflicts', { choices: [{}, {}] })).toContain('"count":2')
    expect(actionText(t, 'edit_summary', { paper_id: 'he2017drain', section: 'thesis', key: 'relation' })).toContain('chat.actions.thesis')
  })
})

describe('actionOutcome', () => {
  it('says who allowed it, why it did not run, or what failed', () => {
    expect(actionOutcome(t, record())).toBe('chat.actions.executed_request {"request":"add a note"}')
    expect(actionOutcome(t, record({ approval: 'user', request: null }))).toBe('chat.actions.executed_user')
    expect(actionOutcome(t, record({ approval: 'user', request: null, result: { state: 'running' } }))).toBe('chat.actions.executed_user chat.actions.still_running')
    expect(actionOutcome(t, record({ state: 'denied', approval: null, result: { reason: 'timeout' } }))).toBe('chat.actions.denied.timeout')
    expect(actionOutcome(t, record({ state: 'denied', approval: null, result: { reason: 'odd' } }))).toBe('chat.actions.denied.user')
    expect(actionOutcome(t, record({ state: 'failed', result: { sync_error: 'offline' } }))).toBe('chat.actions.failed {"error":"sync.errors.offline"}')
    expect(actionOutcome(t, record({ state: 'failed', result: { error: 'trash_problem' } }))).toContain('errors.trash_problem')
    expect(actionOutcome(t, record({ tool: 'undo', approval: 'user', request: null }))).toBe('chat.actions.undone_by_you')
  })
})

describe('approval card texts', () => {
  it('explains why it asks, prices what spends money and counts the minutes left', () => {
    expect(approvalReason(t, { risk: 'spends' })).toBe('chat.actions.risk.spends')
    expect(approvalReason(t, { risk: 'edits' })).toBe('chat.actions.risk.edits')
    expect(approvalReason(t, { risk: null })).toBe('chat.actions.not_requested')
    expect(approvalReason(t, { risk: null, reason: 'not_requested' })).toBe('chat.actions.not_requested')
    expect(approvalReason(t, { risk: null, reason: 'limit' })).toBe('chat.actions.limit')
    // The limit reason wins even when a tool's own risk happens to be set alongside it.
    expect(approvalReason(t, { risk: 'spends', reason: 'limit' })).toBe('chat.actions.limit')
    expect(costLines(t, { count: 2, estimateUsd: 0.1, perOperationUsd: 0.5, batchCapUsd: 10, monthSpentUsd: 1.5, monthCapUsd: 20 })).toEqual([
      'chat.actions.cost.estimate {"count":2,"cost":"$0.10"}',
      'chat.actions.cost.caps {"cap":"$0.50","batch":"$10.00"}',
      'chat.actions.cost.month {"spent":"$1.50","cap":"$20.00"}'
    ])
    expect(costLines(t, { count: 1, estimateUsd: 0.5, perOperationUsd: 2, batchCapUsd: null, monthSpentUsd: 0, monthCapUsd: null }).slice(1)).toEqual([
      'chat.actions.cost.cap {"cap":"$2.00"}',
      'chat.actions.cost.month_no_cap {"spent":"$0.00"}'
    ])
    const now = Date.parse('2026-10-12T10:00:00.000Z')
    expect(minutesLeft('2026-10-12T10:05:00.000Z', now)).toBe(5)
    expect(minutesLeft('2026-10-12T10:00:20.000Z', now)).toBe(1)
    expect(minutesLeft('2026-10-12T09:59:00.000Z', now)).toBe(1)
  })
})
