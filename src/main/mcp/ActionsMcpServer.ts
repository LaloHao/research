import { z } from 'zod'
import { ACTION_DESCRIPTIONS, ACTION_INPUTS } from './actionTools'
import type { AgentToolLog } from '../log/agentLog'
import { startMcpServer, type LibraryMcpHandle } from './LibraryMcpServer'

export const ACTIONS_SERVER_NAME = 'actions'
/** Calls of the actions server per answer, reads included; fixed, not a setting. */
export const ACTION_MAX_TOOL_CALLS = 20

export interface ActionsMcpOptions {
  /** The tools the conversation's switches allow; the others are not offered at all. */
  tools: readonly string[]
  maxToolCalls: number
  /**
   * Runs one call with its validated arguments. What it returns is the tool's answer (as JSON, marked as library data);
   * a ToolError's message becomes the model's error, anything else an opaque one.
   */
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  /** The answer's live log (tool names and argument summaries only). */
  log?: AgentToolLog
}

/** The chat's actions server for one answer: the same transport, token and budget as the library server. */
export function startActionsMcpServer(opts: ActionsMcpOptions): Promise<LibraryMcpHandle> {
  const enabled = new Set(opts.tools)
  return startMcpServer(
    ACTIONS_SERVER_NAME,
    (server, run) => {
      for (const [name, input] of Object.entries(ACTION_INPUTS)) {
        if (!enabled.has(name)) continue
        const description = ACTION_DESCRIPTIONS[name as keyof typeof ACTION_DESCRIPTIONS]
        server.registerTool(name, { description, inputSchema: input as z.ZodRawShape }, (args) => run(name, () => opts.call(name, args as Record<string, unknown>), args))
      }
    },
    { maxToolCalls: opts.maxToolCalls, markData: true, ...(opts.log ? { log: opts.log } : {}) }
  )
}
