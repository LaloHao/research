import { CHAT_ID, ChatMessageSchema, ChatMetaSchema, MAX_MESSAGE_COST, MESSAGE_MODEL, normalizeExcerpt, type AssistantMessage, type ChatFile, type ChatMessage, type UserMessage } from '../../shared/chat'
import { citationMarker, parseCitations } from '../../shared/chatCitations'
import { sha256 } from './atomicWrite'
import type { ReadResult } from './errors'
import { parseFrontmatterFile, toFrontmatter } from './yamlFile'

export const CHATS_DIR = 'chats'
/** The message headings are part of the file format the user reads and edits by hand, so they are in the UI's language. */
export const USER_HEADING = 'Tú'
export const ASSISTANT_HEADING = 'Claude'
/** Marks an answer the user stopped. */
export const STOPPED_MARK = 'detenida'
export const TITLE_CHARS = 80

const HEADING = /^## (Tú|Claude) — (\S+)(?: · (.*?))?\s*$/
/**
 * Message lines written with one more leading backslash, and read back with one less, so that any text round-trips:
 * lines that would read as a message heading (with any number of backslashes already in front), and lines that would
 * read as git conflict markers (a file with them is never overwritten, so a message must not look like one).
 */
const NEEDS_ESCAPE = /^\\*(?:## (?:Tú|Claude) — |<{7} |={7}$|>{7} )/
const ESCAPED = /^\\(\\*(?:## (?:Tú|Claude) — |<{7} |={7}$|>{7} ))/
/** A user message's first line that would read as the excerpt line; escaped the same way. */
const NEEDS_EXCERPT_ESCAPE = /^\\*> \[\[/
const ESCAPED_EXCERPT = /^\\(\\*> \[\[)/
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/
/** A user message that quotes an excerpt starts with the quoted marker alone, then a blank line. */
const EXCERPT_LINE = /^> (\[\[[^\n]*\]\])[ \t]*(?:\n\n|$)/

export const chatFileName = (id: string): string => `${id}.md`
export const isChatFileName = (name: string): boolean => name.endsWith('.md') && CHAT_ID.test(name.slice(0, -3))

/** `<UTC yyyymmdd>-<hhmmss>-<4 hex>`: sorts by creation, and two machines practically never pick the same one. */
export function newChatId(now: Date, randomHex: string): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomHex.slice(0, 4)}`
}

/** The first non-empty line of the first question, whitespace collapsed, cut at a word near TITLE_CHARS (no call to Claude). */
export function titleFrom(text: string): string {
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= TITLE_CHARS) return line || '…'
  const cut = line.slice(0, TITLE_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** What a conversation cost: the sum of its answers (the frontmatter's `cost_usd`). */
export function totalCost(messages: ChatMessage[]): number {
  return Math.round(messages.reduce((sum, m) => sum + (m.role === 'assistant' ? m.costUsd : 0), 0) * 10000) / 10000
}

/**
 * Throws when a message cannot be written and read back (a programming error, not a conflict): a time or model id with
 * whitespace would merge or split messages, a bad cost or excerpt would read back different. Returns the messages
 * stripped to their file fields.
 */
export function checkMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) => {
    const valid = ChatMessageSchema.parse(m)
    if (valid.role === 'assistant' && valid.model === STOPPED_MARK) throw new Error(`Message ${i}: the model id cannot be "${STOPPED_MARK}"`)
    return valid
  })
}

/**
 * A message's text as the file keeps it: leading blank lines and trailing whitespace dropped (the blank lines around a
 * message belong to the format). Leading spaces of the first line are kept: they may start an indented code block.
 */
export function cleanMessageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

/** Headings are matched in NFC, so a hand-edited file with a decomposed «ú» still reads (and is escaped) the same. */
const nfc = (line: string): string => line.normalize('NFC')

function escapeBody(text: string, user: boolean): string {
  return text
    .split('\n')
    .map((l, i) => (NEEDS_ESCAPE.test(nfc(l)) || (user && i === 0 && NEEDS_EXCERPT_ESCAPE.test(l)) ? `\\${l}` : l))
    .join('\n')
}

function unescapeBody(text: string, user: boolean): string {
  return text
    .split('\n')
    .map((l, i) => (ESCAPED.test(nfc(l)) ? l.slice(1) : user && i === 0 && ESCAPED_EXCERPT.test(l) ? l.slice(1) : l))
    .join('\n')
}

function renderMessage(m: ChatMessage): string {
  if (m.role === 'user') {
    const excerpt = m.excerpt ? `> ${citationMarker(m.excerpt)}\n\n` : ''
    return `## ${USER_HEADING} — ${m.at}\n\n${excerpt}${escapeBody(cleanMessageText(m.text), true)}`.trimEnd()
  }
  const parts = [m.at, m.model, `$${m.costUsd.toFixed(4)}`, ...(m.stopped ? [STOPPED_MARK] : [])]
  return `## ${ASSISTANT_HEADING} — ${parts.join(' · ')}\n\n${escapeBody(cleanMessageText(m.text), false)}`.trimEnd()
}

/** chats/<id>.md: the frontmatter, then one `## Tú — …` / `## Claude — …` section per message. */
export function renderChat(file: ChatFile): string {
  return toFrontmatter(file.meta, file.messages.map(renderMessage).join('\n\n'))
}

function readUserMessage(at: string, raw: string): UserMessage {
  const m = EXCERPT_LINE.exec(raw)
  const cited = m ? parseCitations(m[1]) : []
  const excerpt = m && cited.length === 1 && cited[0].start === 0 && cited[0].end === m[1].length ? normalizeExcerpt(cited[0]) : null
  if (m && excerpt) return { role: 'user', at, text: unescapeBody(cleanMessageText(raw.slice(m[0].length)), true), excerpt }
  return { role: 'user', at, text: unescapeBody(raw, true), excerpt: null }
}

function readAssistantMessage(at: string, rest: string, raw: string): AssistantMessage {
  const parts = rest
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean)
  const costMatch = parts.map((p) => /^\$(\d+(?:\.\d+)?)$/.exec(p)).find((m) => m !== null)
  const cost = costMatch ? Number(costMatch[1]) : 0
  // A hand-edited heading reads as values that can be written back: an odd model is 'unknown', an odd cost 0.
  const model = parts[0] && MESSAGE_MODEL.test(parts[0]) && parts[0] !== STOPPED_MARK ? parts[0] : 'unknown'
  const costUsd = Number.isFinite(cost) && cost < MAX_MESSAGE_COST ? cost : 0
  return { role: 'assistant', at, model, costUsd, stopped: parts.includes(STOPPED_MARK), text: unescapeBody(raw, false) }
}

function parseMessages(body: string): ChatMessage[] {
  const out: ChatMessage[] = []
  let head: RegExpExecArray | null = null
  let lines: string[] = []
  const flush = (): void => {
    if (!head) return
    const raw = cleanMessageText(lines.join('\n'))
    out.push(head[1] === USER_HEADING ? readUserMessage(head[2], raw) : readAssistantMessage(head[2], head[3] ?? '', raw))
  }
  for (const line of body.split('\n')) {
    const m = HEADING.exec(nfc(line))
    if (m) {
      flush()
      head = m
      lines = []
    } else {
      lines.push(line)
    }
  }
  flush()
  return out
}

/**
 * Reads chats/<id>.md. Text before the first heading (a hand-written note) is ignored, so it does not survive the next
 * write by the app (the spec allows it; the user docs should say so). Windows line endings and a leading BOM are read
 * as if absent; the hash is always that of the text on disk.
 */
export function parseChat(text: string): ReadResult<ChatFile> {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const hash = sha256(text)
  const meta = parseFrontmatterFile(normalized, ChatMetaSchema)
  if (!meta.ok) return { ...meta, hash }
  return { ok: true, hash, value: { meta: meta.value, messages: parseMessages(normalized.replace(FRONTMATTER, '')) } }
}
