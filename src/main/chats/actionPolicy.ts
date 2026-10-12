import type { ChatMessage } from '../../shared/chat'
import { ACTION_READ_TOOLS, ACTION_TOOLS, MAX_REQUEST_QUOTE, SYNC_TOOLS, TOOL_RISK, type ActionReadTool, type ActionRisk, type ActionTool, type ApprovalReason, type ChatTools } from '../../shared/chatActions'
import { clusterEnd } from '../../shared/textMatch'
import { parseInput } from '../ingest/identifiers'
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

/** Characters that continue an identifier: one found right before or after a match makes it a different identifier. */
const ID_CHAR_BEFORE = /[\p{L}\p{N}._~%+-]/u
/** What may follow an identifier the user typed: closing punctuation and trailing slashes, up to a space or the end. */
const ID_TAIL = /^[/.,;:!?)\]}>»"'’”…]*(?:\s|$)/u
/** Hosts whose URLs name an id the app resolves itself, never fetching that URL. */
const ID_HOSTS = /(^|\.)(doi\.org|arxiv\.org|openalex\.org)$/i

const bare = (s: string): string => s.normalize('NFKC').replace(INVISIBLE, '').trim().replace(/\/+$/, '')

/** Where `id` occurs in `text` as a whole identifier (not as part of a longer one), or -1. */
function occursWhole(id: string, text: string): number {
  for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
    if (at > 0 && ID_CHAR_BEFORE.test(text[at - 1])) continue
    if (ID_TAIL.test(text.slice(at + id.length))) return at
  }
  return -1
}

/**
 * The identifier as the user typed it in the latest message (NFKC, without format characters), or null when the user
 * did not type it: the model's identifier as given (trailing slashes and spaces aside), or the DOI, arXiv or OpenAlex id
 * it names. DOIs and arXiv ids are compared without case; a URL is compared as typed, and only a doi.org, arxiv.org or
 * openalex.org URL may match by the id it names, since any other URL is fetched as it is. What comes back is always the
 * user's text, so what an unasked add_paper fetches carries nothing the model added (invisible characters included).
 */
export function typedIdentifier(identifier: unknown, latest: string | null): string | null {
  if (typeof identifier !== 'string' || typeof latest !== 'string') return null
  const raw = bare(identifier)
  if (raw === '') return null
  const text = latest.normalize('NFKC').replace(INVISIBLE, '')
  const parsed = parseInput(raw)
  if (parsed.kind === 'invalid') return null
  const span = (at: number, length: number): string | null => (at < 0 ? null : text.slice(at, at + length))
  if (parsed.kind === 'url') return span(occursWhole(raw, text), raw.length)
  const lower = text.toLowerCase()
  // Positions in the lowercased text are positions in the text only when lowercasing kept every length.
  if (lower.length !== text.length) return null
  const exact = occursWhole(raw.toLowerCase(), lower)
  if (exact >= 0) return span(exact, raw.length)
  if (/^https?:\/\//i.test(raw)) {
    let host = ''
    try {
      host = new URL(raw).hostname
    } catch {
      return null
    }
    if (!ID_HOSTS.test(host)) return null
  }
  const id = parsed.kind === 'doi' ? parsed.doi : parsed.kind === 'arxiv' ? parsed.arxiv : parsed.openalex
  return id === '' ? null : span(occursWhole(id.toLowerCase(), lower), id.length)
}

/** Whether the user typed this identifier in the latest message (see typedIdentifier). */
export const identifierRequested = (identifier: unknown, latest: string | null): boolean => typedIdentifier(identifier, latest) !== null

/**
 * Why a call asks: its tool has a risk (or is unknown), the latest message did not ask for it in those words, or that
 * message already ran MAX_UNCONFIRMED_PER_MESSAGE actions without asking.
 */
export type GateReason = ApprovalReason
export type GateDecision =
  /** `identifier`: for add_paper, the identifier as the user typed it, which is what runs. */
  | { ask: false; request: string; identifier?: string }
  | { ask: true; request: string | null; reason: GateReason }

/**
 * The app's confirmation rule: a reversible free action runs on its own only when the latest user message holds the
 * quoted words (and, for add_paper, the identifier), and only while that message has run fewer than
 * MAX_UNCONFIRMED_PER_MESSAGE actions without asking (`unconfirmed`: how many it has; anything but a whole number from
 * 0 counts as the limit reached). Everything
 * else asks the user in the conversation. A tool whose catalogue risk is not null (spends, removes, syncs, picks a
 * file, rewrites reviewed data) or that is not in the catalogue always asks, whatever risk it is given.
 */
export function gateAction(a: {
  tool: ActionTool
  risk: ActionRisk | null
  quote?: unknown
  latest: string | null
  unconfirmed: number
  /** The call's validated arguments: add_paper's identifier must be in the latest message too. */
  args?: Readonly<Record<string, unknown>>
}): GateDecision {
  const request = quotedRequest(a.quote, a.latest)
  const known = typeof a.tool === 'string' && Object.hasOwn(TOOL_RISK, a.tool)
  if (!known || TOOL_RISK[a.tool] !== null || a.risk !== null) return { ask: true, request, reason: 'risk' }
  if (request === null || request === '') return { ask: true, request: null, reason: 'not_requested' }
  // Adding a paper fetches what the identifier names: a URL or id the model picked (from a paper's text, say) could
  // carry the library's data to any host, so it runs unasked only when the user typed that identifier.
  const identifier = a.tool === 'add_paper' ? typedIdentifier(a.args?.identifier, a.latest) : undefined
  if (identifier === null) return { ask: true, request, reason: 'not_requested' }
  const n = a.unconfirmed
  if (!Number.isInteger(n) || n < 0 || n >= MAX_UNCONFIRMED_PER_MESSAGE) return { ask: true, request, reason: 'limit' }
  return identifier === undefined ? { ask: false, request } : { ask: false, request, identifier }
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
