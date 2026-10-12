import type { ConflictChoice } from './sync'

/** Tools of the chat's actions server that change something; every call is recorded in the conversation. */
export const ACTION_TOOLS = [
  'add_paper',
  'write_note',
  'decide_relation',
  'review_summary',
  'edit_summary',
  'resolve_proposed_value',
  'decide_facet_suggestion',
  'restore_papers',
  'attach_pdf',
  'summarize',
  'suggest_relations',
  'suggest_facets',
  'fill_facets',
  'trash_papers',
  'delete_forever',
  'sync_now',
  'resolve_sync_conflicts'
] as const
export type ActionTool = (typeof ACTION_TOOLS)[number]

/** Read-only tools of the actions server (ids to act on, the trash, the sync's state): free and never recorded. */
export const ACTION_READ_TOOLS = ['list_relations', 'list_facet_suggestions', 'list_trash', 'sync_status', 'sync_conflicts'] as const
export type ActionReadTool = (typeof ACTION_READ_TOOLS)[number]

/** The tools behind a conversation's «Sincronizar con git» switch; every other one is behind «Acciones». */
export const SYNC_TOOLS: readonly string[] = ['sync_status', 'sync_conflicts', 'sync_now', 'resolve_sync_conflicts']

/** Why an action always asks: it spends money, removes or deletes papers, syncs with git, or uses a file of the computer. */
export const ACTION_RISKS = ['spends', 'removes', 'sync', 'file'] as const
export type ActionRisk = (typeof ACTION_RISKS)[number]

/**
 * Each tool's risk; null: reversible and free, so it runs without asking when the user's latest message asked for it.
 * `add_paper` spends while automatic summaries are on, which is decided when it is called.
 */
export const TOOL_RISK: Record<ActionTool, ActionRisk | null> = {
  add_paper: null,
  write_note: null,
  decide_relation: null,
  review_summary: null,
  edit_summary: null,
  resolve_proposed_value: null,
  decide_facet_suggestion: null,
  restore_papers: null,
  attach_pdf: 'file',
  summarize: 'spends',
  suggest_relations: 'spends',
  suggest_facets: 'spends',
  fill_facets: 'spends',
  trash_papers: 'removes',
  delete_forever: 'removes',
  sync_now: 'sync',
  resolve_sync_conflicts: 'sync'
}

/** How a recorded action ended; the file writes them as «ejecutada», «rechazada» and «fallida». */
export const ACTION_STATES = ['executed', 'denied', 'failed'] as const
export type ActionState = (typeof ACTION_STATES)[number]

/** Why an action did not run; each has a text under `chat.actions.denied.<reason>`. */
export const DENIAL_REASONS = ['user', 'timeout', 'stopped', 'disabled'] as const
export type DenialReason = (typeof DENIAL_REASONS)[number]

/** The tool of an undo's record; its `args.action` names the action it took back. */
export const UNDO_TOOL = 'undo'

/** How long an approval waits for the user before it counts as denied. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000
/** Longest quote of the user's request a call may carry (and a record keeps). */
export const MAX_REQUEST_QUOTE = 500

/** A conversation's switches («Acciones», «Sincronizar con git»). */
export interface ChatTools {
  actions: boolean
  sync: boolean
}

/** What an action that spends money would cost, and the caps that bound it. */
export interface ActionCost {
  /** Calls to Claude it queues (papers, or 1 for a facet suggestion run). */
  count: number
  estimateUsd: number
  /** The most one of those calls may spend (its --max-budget-usd). */
  perOperationUsd: number
  /** The cap of the batch it is queued as; null when it is not a batch. */
  batchCapUsd: number | null
  monthSpentUsd: number
  monthCapUsd: number | null
}

/** What an approval card shows besides the action's own sentence. */
export interface ActionPreview {
  /** The papers it works on, with their titles (the key when the title is unknown). */
  papers: { id: string; title: string }[]
  cost: ActionCost | null
  /** delete_forever: relations deleted with the papers. */
  relations?: number
  /** attach_pdf: the paper already has a PDF, which the new one replaces. */
  replacesPdf?: boolean
  /** resolve_sync_conflicts: each conflicted file or paper and the version that stays. */
  conflicts?: { path: string; choice: ConflictChoice }[]
}

/** An action waiting in the conversation for «Aprobar» or «Rechazar». */
export interface PendingApproval {
  /** Six hex characters. */
  id: string
  tool: ActionTool
  /** The tool's arguments, without the request quote. */
  args: Record<string, unknown>
  preview: ActionPreview
  /** The quote of the user's request, when it was found in their latest message. */
  request: string | null
  /** Why it always asks; null: it would run on its own, but the latest message did not ask for it in those words. */
  risk: ActionRisk | null
  /** attach_pdf: approving opens the file picker. */
  pickPdf: boolean
  /** When it counts as denied. */
  expiresAt: string
}
