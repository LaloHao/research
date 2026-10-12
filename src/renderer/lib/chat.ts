import type { TFunction } from 'i18next'
import { MAX_EXCERPT, normalizeExcerpt, type ChatCitation, type ChatExcerpt, type ChatPartial, type ChatStreamUpdate, type ChatSummary } from '../../shared/chat'
import { citationLabel, parseCitations } from '../../shared/chatCitations'

/** Links to a citation chip: `#cite-<index of the marker in the answer>`. */
export const CITE_HREF = '#cite-'

/** Inline code spans (a backtick run closed by a run of the same length) in a stretch of Markdown without fences. */
function inlineCodeRanges(text: string, offset: number): [number, number][] {
  const ranges: [number, number][] = []
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, length: m[0].length }))
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((r, j) => j > i && r.length === runs[i].length)
    if (close < 0) continue
    ranges.push([offset + runs[i].at, offset + runs[close].at + runs[close].length])
    i = close
  }
  return ranges
}

/** Where the Markdown has code (fenced blocks, to the end when unclosed, and inline spans): markers there stay text. */
export function codeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = []
  let fence: { char: string; length: number; start: number } | null = null
  let plainStart = 0
  let at = 0
  for (const line of markdown.split('\n')) {
    const end = at + line.length
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) {
        ranges.push([fence.start, end])
        fence = null
        plainStart = end
      }
    } else if (opener) {
      ranges.push(...inlineCodeRanges(markdown.slice(plainStart, at), plainStart))
      fence = { char: opener[1][0], length: opener[1].length, start: at }
    }
    at = end + 1
  }
  if (fence) ranges.push([fence.start, markdown.length])
  else ranges.push(...inlineCodeRanges(markdown.slice(plainStart), plainStart))
  return ranges
}

/**
 * The answer's Markdown with each marker as a link `[key, p. N](#cite-i)`, which the message view renders as a chip.
 * Markers inside code stay as written but keep their number, so `i` still matches the answer's citations.
 */
export function withCitationLinks(markdown: string): string {
  const code = codeRanges(markdown)
  let out = ''
  let at = 0
  parseCitations(markdown).forEach((m, i) => {
    if (code.some(([start, end]) => m.start >= start && m.start < end)) return
    out += `${markdown.slice(at, m.start)}[${citationLabel(m)}](${CITE_HREF}${i})`
    at = m.end
  })
  return out + markdown.slice(at)
}

export function citeIndex(href: string | undefined): number | null {
  if (!href?.startsWith(CITE_HREF)) return null
  const rest = href.slice(CITE_HREF.length)
  return /^\d+$/.test(rest) ? Number(rest) : null
}

/** While an answer streams, a marker still arriving (`[[key|p. 1|"par`) is hidden instead of shown half-written. */
export function hidePartialMarker(text: string): string {
  const open = text.lastIndexOf('[[')
  const cut = open >= 0 && !text.includes(']]', open) ? text.slice(0, open) : text
  return cut.endsWith('[') ? cut.slice(0, -1) : cut
}

export function citationClass(c: ChatCitation | undefined): string {
  return `cite-chip cite-${c?.state ?? 'pending'}`
}

/** The answer being written, as the conversation shows it. */
export interface LiveAnswer {
  text: string
  tools: number
  seq: number
  status: 'running' | 'done' | 'stopped' | 'error'
  error: string | null
}

const fresh = (seq: number): LiveAnswer => ({ text: '', tools: 0, seq, status: 'running', error: null })

/** The snapshot `open()` returned, unless the stream already brought something newer. */
export function liveFromPartial(partial: ChatPartial, current: LiveAnswer | null): LiveAnswer {
  if (current && current.seq >= partial.seq) return current
  return { text: partial.text, tools: partial.tools, seq: partial.seq, status: 'running', error: null }
}

/** One stream update applied in order; an update older than what is shown is ignored. */
export function applyUpdate(live: LiveAnswer | null, u: ChatStreamUpdate): LiveAnswer | null {
  if (live && u.seq <= live.seq) return live
  const base = u.kind === 'start' || !live ? fresh(u.seq) : live
  switch (u.kind) {
    case 'start':
      return base
    case 'delta':
      return { ...base, seq: u.seq, text: base.text + u.text }
    case 'turn':
      return { ...base, seq: u.seq, text: '' }
    case 'tool':
      return { ...base, seq: u.seq, tools: base.tools + 1 }
    case 'approvals':
      return { ...base, seq: u.seq }
    case 'done':
      return { ...base, seq: u.seq, status: 'done' }
    case 'stopped':
      return { ...base, seq: u.seq, status: 'stopped' }
    case 'error':
      return { ...base, seq: u.seq, status: 'error', error: u.error }
  }
}

/** Enter sends; Shift+Enter (and Enter while an input method composes text) is left to the text area. */
export function composerAction(e: { key: string; shiftKey: boolean; isComposing: boolean }): 'send' | null {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing ? 'send' : null
}

/**
 * «Preguntar a Claude» on a selection: whitespace collapsed, at least 3 characters, in the form its citation marker
 * reads back (`"]]` and `[[` broken up, as the conversation file stores it), cut at MAX_EXCERPT; null when it cannot
 * be quoted.
 */
export function excerptFromSelection(selected: string, paper: string, page: number | null): ChatExcerpt | null {
  const collapsed = selected.replace(/\s+/g, ' ').trim()
  if (collapsed.length < 3) return null
  const quote = collapsed.replace(/"\]\]/g, '" ]]').replace(/\[\[/g, '[ [').slice(0, MAX_EXCERPT).trimEnd()
  return normalizeExcerpt({ paper, page, quote })
}

/** The paper detail's chat state (open conversation and pending excerpt), tagged with the paper it belongs to. */
export interface PaperChatState {
  paper: string
  chatId: string | null
  excerpt: ChatExcerpt | null
}

/** What the paper shown sees of the state: nothing when it belongs to another paper. */
export function paperChatOf(state: PaperChatState | null, shown: string): { chatId: string | null; excerpt: ChatExcerpt | null } {
  return state && state.paper === shown ? { chatId: state.chatId, excerpt: state.excerpt } : { chatId: null, excerpt: null }
}

/**
 * An update made on behalf of `from` while `shown` is displayed: ignored when they differ (a late answer of a paper the
 * user left must not open its conversation, or clear an excerpt, in the next one); otherwise merged into the shown
 * paper's state, which starts empty when the state belonged to another paper.
 */
export function updatePaperChat(
  state: PaperChatState | null,
  from: string,
  shown: string,
  patch: Partial<Pick<PaperChatState, 'chatId' | 'excerpt'>>
): PaperChatState | null {
  if (from !== shown) return state
  return { paper: shown, ...paperChatOf(state, shown), ...patch }
}

/** A conversation's title; a copy the sync split off says which machine it came from. */
export function chatTitle(t: TFunction, s: Pick<ChatSummary, 'title' | 'copyOf'>): string {
  if (!s.copyOf) return s.title
  return t('chat.copy_title', { title: s.title, machine: s.copyOf.machine ?? t('chat.other_machine') })
}

export function costText(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`
}

export function splitArchived(list: ChatSummary[]): { active: ChatSummary[]; archived: ChatSummary[] } {
  return { active: list.filter((c) => !c.archived), archived: list.filter((c) => c.archived) }
}

/** The papers that have conversations, for the list's paper filter (their key when they left the library). */
export function paperFilterOptions(list: ChatSummary[]): { id: string; title: string }[] {
  const byId = new Map<string, string>()
  for (const c of list) {
    if (c.scope === 'library') continue
    const known = byId.get(c.scope.paper)
    if (!known || known === c.scope.paper) byId.set(c.scope.paper, c.paperTitle ?? c.scope.paper)
  }
  return [...byId].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title))
}

/** «Guardar en notas del paper» in the global chat: the chat's paper and the cited library papers first, then the rest. */
export function notePaperOptions(scopePaper: string | null, citations: ChatCitation[], rows: { id: string; title: string }[]): { id: string; title: string; suggested: boolean }[] {
  const titles = new Map(rows.map((r) => [r.id, r.title]))
  const first = [...new Set([...(scopePaper ? [scopePaper] : []), ...citations.map((c) => c.paper)])].filter((id) => titles.has(id))
  const rest = rows.filter((r) => !first.includes(r.id)).sort((a, b) => a.title.localeCompare(b.title))
  return [...first.map((id) => ({ id, title: titles.get(id)!, suggested: true })), ...rest.map((r) => ({ id: r.id, title: r.title, suggested: false }))]
}

/** What a conversation does with a stream update. */
export type StreamAction = 'ignore' | 'buffer' | 'resync' | 'apply'

export interface StreamGate {
  /** The conversation shown; null while it is new. */
  chatId: string | null
  /** A new conversation's first message is being sent: its id is not known yet. */
  awaitingNew: boolean
  /** The newest sequence number seen (updates and `open()` snapshots). */
  seenSeq: number
  /** An answer is shown as running. */
  running: boolean
}

/**
 * Only this conversation's updates, in order (sequence numbers rise across every answer of the session). The middle
 * of an answer with nothing running asks for a snapshot instead of building text from a missing prefix; a new
 * conversation keeps every update until its id is known, so a quick failure of its first answer is not lost.
 */
export function streamAction(g: StreamGate, u: ChatStreamUpdate): StreamAction {
  if (g.chatId === null) return g.awaitingNew ? 'buffer' : 'ignore'
  if (u.chatId !== g.chatId || u.seq <= g.seenSeq) return 'ignore'
  if (!g.running && (u.kind === 'delta' || u.kind === 'turn' || u.kind === 'tool' || u.kind === 'approvals')) return 'resync'
  return 'apply'
}

/** The buffered updates of the conversation just created, in order. */
export function takeBuffered(buffered: ChatStreamUpdate[], chatId: string): ChatStreamUpdate[] {
  return buffered.filter((u) => u.chatId === chatId).sort((a, b) => a.seq - b.seq)
}

/** The reader is at the bottom of the messages (within a few lines): new text scrolls into view. */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
