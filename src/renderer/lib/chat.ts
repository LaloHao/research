import type { TFunction } from 'i18next'
import { MAX_EXCERPT, type ChatCitation, type ChatExcerpt, type ChatPartial, type ChatStreamUpdate, type ChatSummary } from '../../shared/chat'
import { citationLabel, parseCitations } from '../../shared/chatCitations'

/** Links to a citation chip: `#cite-<index of the marker in the answer>`. */
export const CITE_HREF = '#cite-'

/** The answer's Markdown with each marker as a link `[key, p. N](#cite-i)`, which the message view renders as a chip. */
export function withCitationLinks(markdown: string): string {
  let out = ''
  let at = 0
  parseCitations(markdown).forEach((m, i) => {
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

/** «Preguntar a Claude» on a selection: whitespace collapsed, at least 3 characters, cut at MAX_EXCERPT. */
export function excerptFromSelection(selected: string, paper: string, page: number | null): ChatExcerpt | null {
  const quote = selected.replace(/\s+/g, ' ').trim()
  if (quote.length < 3) return null
  return { paper, page, quote: quote.slice(0, MAX_EXCERPT).trimEnd() }
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
