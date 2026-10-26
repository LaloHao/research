import { CHAT_ID, PAPER_KEY } from '../../shared/chat'
import { SUGGESTION_ID } from '../../shared/facetSuggestions'
import { MAPPING_ID, RECORD_ID } from '../../shared/mapping'
import { FACET_KEY_PATTERN, SUMMARY_FIELD_KEYS } from '../../shared/summary'
import { RELATION_ID } from '../../shared/typedRelations'
import { appLog, type LogFields } from './appLog'

/**
 * Live progress of the Claude agent runs (relation, facet and screening suggestions, chat answers and their actions)
 * in the app log, so `pnpm dev` shows what a run is doing. Each entry carries the run's context (`relations <paper>`,
 * `chat <id>`), and a tool call only its name and a bounded summary of its arguments: ids, enum values, numbers and the
 * length of any text. Never a prompt, an answer, a query, a quote, a note or any paper text.
 */

export type AgentKind = 'relations' | 'facets' | 'screening' | 'chat' | 'draft' | 'cite_check' | 'outline' | 'style' | 'tutor' | 'alternatives' | 'reverse_outline' | 'rq_coverage'

export interface AgentStart {
  kind: AgentKind
  /** What the run is about: a paper key, a chat id, a mapping and record. */
  subject?: string | null
  model: string
  /** The run's own spending cap (--max-budget-usd). */
  capUsd: number
  maxTurns?: number
  /** More ids or counts worth seeing (a batch, a number of candidates). */
  ids?: Record<string, string | number | null | undefined>
}

export interface AgentEnd {
  costUsd: number
  /** The CLI's turns, when it reported them. */
  turns?: number | null
  estimated?: boolean
  /** Counts worth seeing (suggestions kept, dropped). */
  extra?: Record<string, number | string | null | undefined>
}

/** What the MCP servers tell about each call they receive. */
export interface AgentToolLog {
  tool(server: string, name: string, args: unknown, opts?: { refused?: string }): void
  toolDone?(name: string, ok: boolean, ms: number): void
}

/** A facet or field key as the forms use it, short enough to be a name and not a sentence in snake_case. */
const MAX_FACET_KEY = 32
const MAX_FACET_KEY_WORDS = 4
const SUMMARY_KEYS = new Set<string>(SUMMARY_FIELD_KEYS)
const facetKey = (v: string): boolean => SUMMARY_KEYS.has(v) || (FACET_KEY_PATTERN.test(v) && v.length <= MAX_FACET_KEY && v.split('_').length <= MAX_FACET_KEY_WORDS)
const short = (pattern: RegExp, max: number) => (v: string): boolean => v.length <= max && pattern.test(v)
/** An enum value of a tool (decision, status, section, type…). */
const enumValue = short(/^[a-z][a-z_]*$/, 24)

/**
 * Arguments whose values may be shown, each with the exact pattern its ids follow in the app; any other value (or one
 * that does not match) is shown only by its length.
 */
const ID_ARGS: Record<string, (v: string) => boolean> = {
  paper_id: short(PAPER_KEY, 40),
  paper_ids: short(PAPER_KEY, 40),
  relation_id: short(RELATION_ID, 120),
  suggestion_id: (v) => v.length <= 120 && SUGGESTION_ID.test(v) && v.split('__').slice(1).every(facetKey),
  record_id: short(RECORD_ID, 13),
  record_ids: short(RECORD_ID, 13),
  mapping_id: short(MAPPING_ID, 20),
  chat_id: short(CHAT_ID, 80),
  key: facetKey,
  facet: facetKey,
  decision: enumValue,
  type: enumValue,
  section: enumValue,
  status: enumValue,
  direction: enumValue,
  choice: enumValue
}
const ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/
const MAX_ARGS = 12
const MAX_LISTED = 5

/**
 * A tool call's arguments as the log may show them: numbers and booleans as they are; an id or enum value (by its key
 * and its exact id pattern) as it is; lists of ids by their first few; any other string by its length (`queryChars`), any other list
 * or object by its size. Bounded whatever the model sends.
 */
export function toolArgsSummary(args: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out
  let skipped = 0
  let kept = 0
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (!ARG_KEY.test(key) || kept >= MAX_ARGS) {
      skipped++
      continue
    }
    kept++
    const isId = Object.hasOwn(ID_ARGS, key) ? ID_ARGS[key]! : null
    if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : String(value)
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string') {
      if (isId?.(value)) out[key] = value
      else out[`${key}Chars`] = value.length
    } else if (Array.isArray(value)) {
      if (isId && value.length > 0 && value.every((v) => typeof v === 'string' && isId(v))) {
        const shown = value.slice(0, MAX_LISTED).join(',')
        out[key] = value.length > MAX_LISTED ? `${shown} +${value.length - MAX_LISTED}` : shown
      } else out[`${key}Count`] = value.length
    } else if (typeof value === 'object') out[`${key}Keys`] = Object.keys(value).length
  }
  if (skipped > 0) out.otherArgs = skipped
  return out
}

/** A failure as the log shows it: `stopped`, or the error's code (LlmError, UserFacingError), or `error`. */
function outcomeOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, code } = error as { name?: unknown; code?: unknown }
    if (name === 'AbortError') return 'stopped'
    if (typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)) return code
  }
  return 'error'
}

const defined = (fields: Record<string, unknown> | undefined): LogFields =>
  Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined && v !== null))

/** One run's entries; created when the run starts, ended once (later ends are ignored). */
export class AgentRunLog implements AgentToolLog {
  readonly ctx: string
  private readonly started: number
  private toolCalls = 0
  private ended = false

  constructor(
    start: AgentStart,
    private readonly now: () => number = () => Date.now()
  ) {
    this.ctx = start.subject ? `${start.kind} ${start.subject}` : start.kind
    this.started = this.now()
    appLog.info('agent_start', { ctx: this.ctx, kind: start.kind, model: start.model, capUsd: start.capUsd, ...defined({ maxTurns: start.maxTurns }), ...defined(start.ids) })
  }

  tool(server: string, name: string, args: unknown, opts: { refused?: string } = {}): void {
    this.toolCalls++
    appLog.info('agent_tool', { ctx: this.ctx, server, tool: name, args: toolArgsSummary(args), ...defined(opts) })
  }

  toolDone(name: string, ok: boolean, ms: number): void {
    appLog.debug('agent_tool_done', { ctx: this.ctx, tool: name, ok, ms })
  }

  /** A chat action's approval: asked, then approved or denied (with its reason); `not_asked` when it ran on its own. */
  approval(tool: string, risk: string | null, decision: string): void {
    appLog.info('agent_approval', { ctx: this.ctx, tool, risk: risk ?? 'free', decision })
  }

  end(result: AgentEnd): void {
    this.finish('ok', result)
  }

  fail(error: unknown, spent: { costUsd?: number; estimated?: boolean } = {}): void {
    this.finish(outcomeOf(error), { costUsd: spent.costUsd ?? 0, estimated: spent.estimated })
  }

  private finish(outcome: string, r: AgentEnd): void {
    if (this.ended) return
    this.ended = true
    const fields: LogFields = {
      ctx: this.ctx,
      outcome,
      ...defined({ turns: r.turns }),
      toolCalls: this.toolCalls,
      costUsd: r.costUsd,
      ...(r.estimated ? { estimated: true } : {}),
      ms: this.now() - this.started,
      ...defined(r.extra)
    }
    if (outcome === 'ok' || outcome === 'stopped') appLog.info('agent_end', fields)
    else appLog.warn('agent_end', fields)
  }
}

export function startAgentRun(start: AgentStart): AgentRunLog {
  return new AgentRunLog(start)
}
