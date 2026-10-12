import type { TFunction } from 'i18next'
import type { ActionMessage } from '../../shared/chat'
import { ACTION_TOOLS, DENIAL_REASONS, UNDO_TOOL, type ActionCost, type ActionRisk, type ChatTools, type PendingApproval } from '../../shared/chatActions'
import { SYNC_ERROR_CODES } from '../../shared/sync'
import { costText } from './chat'
import { errorText } from './errorText'

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const DECISIONS: readonly string[] = ['confirm', 'reject', 'back_to_suggested', 'change_type', 'reverse', 'accept', 'restore']

/** Why the gate asked: the action's own risk (or that it is unknown), that the latest message did not ask for it, or the per-message limit. */
export type GateReason = 'risk' | 'not_requested' | 'limit'

/** The i18n key of an action's sentence: some tools say something different for a decision or an option. */
export function actionKey(tool: string, args: Record<string, unknown>): string {
  if (tool === 'resolve_proposed_value') return `chat.actions.tools.resolve_proposed_value_${args.decision === 'map' ? 'map' : 'accept'}`
  if (tool === 'attach_pdf' && args.replace === true) return 'chat.actions.tools.attach_pdf_replace'
  if (tool === 'fill_facets' && strings(args.paper_ids).length === 0) return 'chat.actions.tools.fill_facets_all'
  if (tool === 'review_summary' && !args.section) return 'chat.actions.tools.review_summary_all'
  return tool === UNDO_TOOL || (ACTION_TOOLS as readonly string[]).includes(tool) ? `chat.actions.tools.${tool}` : 'chat.actions.tools.unknown'
}

/** What an action did or wants to do, in one sentence (the same in its record and on its approval card). */
export function actionText(t: TFunction, tool: string, args: Record<string, unknown>): string {
  const decision = str(args.decision)
  return t(actionKey(tool, args), {
    tool,
    papers: strings(args.paper_ids).join(', '),
    paper: str(args.paper_id),
    identifier: str(args.identifier),
    relation: str(args.relation_id).split('__').slice(0, 2).join(' – '),
    decision: DECISIONS.includes(decision) ? t(`chat.actions.decisions.${decision}`, { type: args.type ? t(`typed.types.${str(args.type)}`) : '' }) : decision,
    key: args.section === 'thesis' ? t('chat.actions.thesis') : str(args.key),
    status: t(`chat.actions.review_status.${args.status === 'generated' ? 'generated' : 'verified'}`),
    facet: str(args.facet),
    value: str(args.value),
    to: str(args.to),
    suggestion: str(args.suggestion_id),
    count: Array.isArray(args.choices) ? args.choices.length : 0,
    action: str(args.action)
  })
}

/** How a recorded action ended: who allowed it, why it did not run, or what failed. */
export function actionOutcome(t: TFunction, m: ActionMessage): string {
  if (m.tool === UNDO_TOOL) return t('chat.actions.undone_by_you')
  if (m.state === 'denied') {
    const reason = str(m.result.reason)
    return t(`chat.actions.denied.${(DENIAL_REASONS as readonly string[]).includes(reason) ? reason : 'user'}`)
  }
  if (m.state === 'failed') {
    const sync = str(m.result.sync_error)
    const error = (SYNC_ERROR_CODES as readonly string[]).includes(sync) ? t(`sync.errors.${sync}`) : errorText(t, str(m.result.error) || 'unknown')
    return t('chat.actions.failed', { error })
  }
  const how = m.approval === 'request' && m.request ? t('chat.actions.executed_request', { request: m.request }) : t('chat.actions.executed_user')
  return m.result.state === 'running' ? `${how} ${t('chat.actions.still_running')}` : how
}

/**
 * Why the card asks: the action's own risk (`chat.actions.risk.<risk>`), that the latest message did not ask for it
 * in those words, or that this message already ran the per-message limit of actions without asking.
 */
export function approvalReason(t: TFunction, a: Pick<PendingApproval, 'risk'> & { reason?: GateReason }): string {
  if (a.reason === 'limit') return t('chat.actions.limit')
  return a.risk ? t(`chat.actions.risk.${a.risk as ActionRisk}`) : t('chat.actions.not_requested')
}

/** The estimate and the caps of an action that spends money, one line each. */
export function costLines(t: TFunction, c: ActionCost): string[] {
  return [
    t('chat.actions.cost.estimate', { count: c.count, cost: costText(c.estimateUsd) }),
    c.batchCapUsd === null
      ? t('chat.actions.cost.cap', { cap: costText(c.perOperationUsd) })
      : t('chat.actions.cost.caps', { cap: costText(c.perOperationUsd), batch: costText(c.batchCapUsd) }),
    c.monthCapUsd === null
      ? t('chat.actions.cost.month_no_cap', { spent: costText(c.monthSpentUsd) })
      : t('chat.actions.cost.month', { spent: costText(c.monthSpentUsd), cap: costText(c.monthCapUsd) })
  ]
}

/** Whole minutes (at least 1) until a pending approval counts as denied. */
export function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000))
}

/** What each switch that is on lets Claude do, in the order of the header. */
export function switchHints(t: TFunction, tools: ChatTools): string[] {
  return [...(tools.actions ? [t('chat.actions.switch_actions_hint')] : []), ...(tools.sync ? [t('chat.actions.switch_sync_hint')] : [])]
}
