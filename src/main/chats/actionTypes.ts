import type { ActionPreview, ActionReadTool, ActionRisk, ActionTool } from '../../shared/chatActions'

/** What an action did. */
export interface ExecutedAction {
  /** Kept in the conversation's record and told to Claude: paper keys, counts, outcome codes. */
  result: Record<string, unknown>
  /** It ran but did not do what was asked (a sync that stopped on an error): recorded as failed. */
  failed?: boolean
  /** «Deshacer»; null when the action cannot be undone. */
  undo: (() => Promise<void>) | null
}

/** An action checked and described, ready to run once the rule (or the user) allows it. */
export interface PreparedAction {
  tool: ActionTool
  /** The validated arguments, without the request quote, as the record keeps them. */
  args: Record<string, unknown>
  preview: ActionPreview
  /** Why it must be approved in the conversation whatever the user's message said; null for a reversible free action. */
  risk: ActionRisk | null
  /** Approving opens the file picker (attach_pdf). */
  pickPdf: boolean
  execute(opts: { pdfPath?: string }): Promise<ExecutedAction>
}

/** The library's side of the actions: reads, and preparing a call (a ToolError when it cannot be done). */
export interface ActionExecutor {
  read(tool: ActionReadTool, args: Record<string, unknown>): Promise<unknown>
  prepare(tool: ActionTool, args: Record<string, unknown>): Promise<PreparedAction>
}
