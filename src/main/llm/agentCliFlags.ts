/**
 * How the installed `claude` CLI runs an agent restricted to one MCP server, as proven by a real run
 * (stage 3b verification). Regenerate with the verification script; do not edit by hand.
 */
export interface AgentCliFlags {
  /** 'glob': --allowedTools mcp__<server>__*; 'server': --allowedTools mcp__<server>. */
  allowedTools: 'glob' | 'server'
  /** Flags that keep a print-mode run from waiting on permission prompts. */
  permissionArgs: readonly string[]
  /** Whether the CLI accepts --max-turns (it is not listed in --help). */
  maxTurns: boolean
}

export const AGENT_CLI_FLAGS: AgentCliFlags = {
  allowedTools: 'glob',
  permissionArgs: [
    '--permission-mode',
    'dontAsk'
  ],
  maxTurns: true
}
