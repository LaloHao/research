import type { ChatMessage } from '../../shared/chat'
import { ACTION_READ_TOOLS, ACTION_TOOLS, MAX_REQUEST_QUOTE, SYNC_TOOLS, TOOL_RISK, type ActionReadTool, type ActionRisk, type ActionTool, type ChatTools } from '../../shared/chatActions'
import { clusterEnd } from '../../shared/textMatch'
import { foldQuery, foldWithMap } from '../mcp/libraryTools'

/** Fewer folded letters and digits than this is too little to tell a request apart (a «sí» asks instead). */
export const MIN_REQUEST_QUOTE = 8

/**
 * At most this many actions run without asking for one user message; the next ones ask. The quote only proves that
 * the words are in the message, not that the message asked for this call, so text the model read (a paper, a tool
 * answer) could otherwise steer it into any number of free actions.
 */
export const MAX_UNCONFIRMED_PER_MESSAGE = 3

/**
 * The own text of the conversation's last user message: the only text a request may be quoted from. Never its excerpt
 * (paper text), an earlier message, an answer or a tool result.
 */
export function latestUserText(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') return typeof m.text === 'string' ? m.text : null
  }
  return null
}

/** Format characters (zero-width spaces and joiners, bidi controls, soft hyphens, tag characters): never seen, never matched. */
const INVISIBLE = /\p{Cf}/gu
/** Quotes, spaces and final dots a model may wrap a quote in. */
const WRAPPING = /^[\s«»"“”„'‘’‚`]+|[\s«»"“”„'‘’‚`.…]+$/gu
const WORD = /[\p{L}\p{N}]/u
const WORD_G = /[\p{L}\p{N}]/gu
/** A lone half of a surrogate pair: a span that holds one was cut in the middle of a character. */
const BROKEN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Folded like the library's literal search (case, accents, typographic quotes and dashes, whitespace), after NFKC and without format characters. */
const fold = (s: string): string => foldQuery(s.normalize('NFKC').replace(INVISIBLE, ''))

/**
 * Where the latest user message holds the quote: the user's own words (format characters removed), or null. The quote
 * must be a string of at most MAX_REQUEST_QUOTE characters with at least MIN_REQUEST_QUOTE folded letters and digits,
 * and must match whole words of the message once both are folded the same way. What comes back is always the user's
 * text, never the model's quote, so nothing the model wrote reaches the card or the record as the user's request.
 */
export function quotedRequest(quote: unknown, latest: string | null): string | null {
  if (typeof quote !== 'string' || typeof latest !== 'string') return null
  if (quote.length > MAX_REQUEST_QUOTE) return null
  const q = fold(quote.replace(INVISIBLE, '').replace(WRAPPING, ''))
  if ((q.match(WORD_G)?.length ?? 0) < MIN_REQUEST_QUOTE) return null
  const own = latest.replace(INVISIBLE, '')
  const folded = foldWithMap(own)
  for (let at = folded.text.indexOf(q); at >= 0; at = folded.text.indexOf(q, at + 1)) {
    const end = at + q.length
    // Whole words: a quote that starts or ends with a letter or digit may not cut a word of the message.
    // Whole words: the match may not start right after, nor end right before, a letter or digit of the message,
    // whatever the quote's own first and last characters are.
    if (at > 0 && WORD.test(folded.text[at - 1])) continue
    if (end < folded.text.length && WORD.test(folded.text[end])) continue
    const start = folded.map[at]
    const last = folded.map[end - 1]
    if (start === undefined || last === undefined) return null
    // The span ends after the last character's whole code point and the combining marks that belong to it.
    const span = own.slice(start, clusterEnd(own, last))
    return span.trim() !== '' && !BROKEN.test(span) ? span : null
  }
  return null
}

/**
 * Why a call asks: its tool has a risk (or is unknown), the latest message did not ask for it in those words, or that
 * message already ran MAX_UNCONFIRMED_PER_MESSAGE actions without asking.
 */
export type GateReason = 'risk' | 'not_requested' | 'limit'
export type GateDecision = { ask: false; request: string } | { ask: true; request: string | null; reason: GateReason }

/**
 * The app's confirmation rule: a reversible free action runs on its own only when the latest user message asked for it
 * in the quoted words, and only while that message has run fewer than MAX_UNCONFIRMED_PER_MESSAGE actions without
 * asking (`unconfirmed`: how many it has; anything but a whole number from 0 counts as the limit reached). Everything
 * else asks the user in the conversation. A tool whose catalogue risk is not null (spends, removes, syncs, picks a
 * file, rewrites reviewed data) or that is not in the catalogue always asks, whatever risk it is given.
 */
export function gateAction(a: { tool: ActionTool; risk: ActionRisk | null; quote?: unknown; latest: string | null; unconfirmed: number }): GateDecision {
  const request = quotedRequest(a.quote, a.latest)
  const known = typeof a.tool === 'string' && Object.hasOwn(TOOL_RISK, a.tool)
  if (!known || TOOL_RISK[a.tool] !== null || a.risk !== null) return { ask: true, request, reason: 'risk' }
  if (request === null || request === '') return { ask: true, request: null, reason: 'not_requested' }
  const n = a.unconfirmed
  if (!Number.isInteger(n) || n < 0 || n >= MAX_UNCONFIRMED_PER_MESSAGE) return { ask: true, request, reason: 'limit' }
  return { ask: false, request }
}

const ALL: readonly string[] = [...ACTION_TOOLS, ...ACTION_READ_TOOLS]

/** Whether the conversation's switches offer this tool: the sync group with «Sincronizar con git», the rest with «Acciones». */
export function toolEnabled(tool: string, tools: ChatTools): boolean {
  if (!ALL.includes(tool)) return false
  return SYNC_TOOLS.includes(tool) ? tools.sync === true : tools.actions === true
}

export function enabledTools(tools: ChatTools): string[] {
  return ALL.filter((t) => toolEnabled(t, tools))
}

export const isReadTool = (tool: string): tool is ActionReadTool => (ACTION_READ_TOOLS as readonly string[]).includes(tool)
