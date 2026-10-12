import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import {
  applyUpdate,
  chatTitle,
  citationClass,
  citeIndex,
  composerAction,
  costText,
  excerptFromSelection,
  hidePartialMarker,
  liveFromPartial,
  notePaperOptions,
  paperFilterOptions,
  splitArchived,
  withCitationLinks,
  type LiveAnswer
} from '../../src/renderer/lib/chat'
import type { ChatStreamUpdate, ChatSummary } from '../../src/shared/chat'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction

const summary = (over: Partial<ChatSummary>): ChatSummary => ({
  id: '20261011-120000-a1b2',
  title: 'T',
  scope: 'library',
  paperTitle: null,
  paperState: null,
  archived: false,
  model: 'sonnet',
  updatedAt: '2026-10-11T12:00:00.000Z',
  costUsd: 0,
  messages: 2,
  copyOf: null,
  problem: false,
  ...over
})

const up = (seq: number, e: Record<string, unknown>): ChatStreamUpdate => ({ chatId: 'c', seq, ...e }) as unknown as ChatStreamUpdate

describe('citation links', () => {
  it('turns each marker into a numbered link the message view renders as a chip', () => {
    const md = 'Drain [[he2017drain|p. 1|"parses logs"]] and Loghub [[zhu2020loghub|"datasets"]].'
    expect(withCitationLinks(md)).toBe('Drain [he2017drain, p. 1](#cite-0) and Loghub [zhu2020loghub](#cite-1).')
    expect(citeIndex('#cite-1')).toBe(1)
    for (const href of [undefined, 'https://x.org', '#cite-', '#cite--1', '#cite-1.5']) expect(citeIndex(href)).toBeNull()
  })

  it('hides a marker that is still arriving', () => {
    expect(hidePartialMarker('Drain [[he2017drain|p. 1|"parses')).toBe('Drain ')
    expect(hidePartialMarker('Drain [')).toBe('Drain ')
    expect(hidePartialMarker('Drain [[he2017drain|p. 1|"parses"]] done')).toBe('Drain [[he2017drain|p. 1|"parses"]] done')
  })

  it('styles a chip by its state, pending while the answer streams', () => {
    expect(citationClass(undefined)).toBe('cite-chip cite-pending')
    expect(citationClass({ paper: 'a', page: 1, quote: 'q', state: 'not_found' })).toBe('cite-chip cite-not_found')
  })
})

describe('the answer as it streams', () => {
  it('applies updates in order, starting over on a new turn and ignoring stale ones', () => {
    let live: LiveAnswer | null = null
    for (const u of [up(1, { kind: 'start' }), up(2, { kind: 'delta', text: 'Let me search.' }), up(3, { kind: 'turn' }), up(4, { kind: 'tool', name: 'search_text' }), up(5, { kind: 'delta', text: 'Drain ' }), up(6, { kind: 'delta', text: 'parses.' })]) {
      live = applyUpdate(live, u)
    }
    expect(live).toEqual({ text: 'Drain parses.', tools: 1, seq: 6, status: 'running', error: null })
    expect(applyUpdate(live, up(5, { kind: 'delta', text: 'old' }))).toBe(live)
    expect(applyUpdate(live, up(7, { kind: 'error', error: 'llm_quota' }))).toMatchObject({ status: 'error', error: 'llm_quota', text: 'Drain parses.' })
    expect(applyUpdate(applyUpdate(live, up(7, { kind: 'error', error: 'llm_quota' })), up(8, { kind: 'start' }))).toEqual({ text: '', tools: 0, seq: 8, status: 'running', error: null })
  })

  it('takes a snapshot from opening the conversation only when it is newer than what arrived', () => {
    const arrived: LiveAnswer = { text: 'abc', tools: 0, seq: 9, status: 'running', error: null }
    expect(liveFromPartial({ text: 'ab', tools: 0, seq: 8 }, arrived)).toBe(arrived)
    expect(liveFromPartial({ text: 'abcd', tools: 1, seq: 10 }, arrived)).toEqual({ text: 'abcd', tools: 1, seq: 10, status: 'running', error: null })
    expect(liveFromPartial({ text: 'x', tools: 0, seq: 3 }, null)).toMatchObject({ text: 'x', seq: 3 })
  })
})

describe('composer and selections', () => {
  it('sends on Enter, never with Shift or while composing text', () => {
    expect(composerAction({ key: 'Enter', shiftKey: false, isComposing: false })).toBe('send')
    expect(composerAction({ key: 'Enter', shiftKey: true, isComposing: false })).toBeNull()
    expect(composerAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull()
    expect(composerAction({ key: 'a', shiftKey: false, isComposing: false })).toBeNull()
  })

  it('turns a selection into a quoted excerpt with its page', () => {
    expect(excerptFromSelection('  Drain parses\nlog   messages ', 'he2017drain', 3)).toEqual({ paper: 'he2017drain', page: 3, quote: 'Drain parses log messages' })
    expect(excerptFromSelection(' a ', 'he2017drain', 3)).toBeNull()
    expect(excerptFromSelection('x'.repeat(1500), 'he2017drain', null)!.quote).toHaveLength(1000)
  })
})

describe('lists and labels', () => {
  it('names a sync copy after the machine it came from', () => {
    expect(chatTitle(t, { title: 'Drain', copyOf: null })).toBe('Drain')
    expect(chatTitle(t, { title: 'Drain', copyOf: { machine: 'desktop' } })).toBe('chat.copy_title {"title":"Drain","machine":"desktop"}')
    expect(chatTitle(t, { title: 'Drain', copyOf: { machine: null } })).toBe('chat.copy_title {"title":"Drain","machine":"chat.other_machine"}')
  })

  it('shows small costs with four decimals', () => {
    expect([costText(0), costText(0.004), costText(0.1234), costText(2)]).toEqual(['$0.00', '$0.0040', '$0.12', '$2.00'])
  })

  it('folds archived conversations and lists the papers that have conversations', () => {
    const list = [summary({ id: 'a', archived: true }), summary({ id: 'b', scope: { paper: 'zhu2020loghub' }, paperTitle: 'Loghub' }), summary({ id: 'c', scope: { paper: 'he2017drain' }, paperTitle: null }), summary({ id: 'd', scope: { paper: 'zhu2020loghub' }, paperTitle: 'Loghub' })]
    expect(splitArchived(list)).toEqual({ active: [list[1], list[2], list[3]], archived: [list[0]] })
    expect(paperFilterOptions(list)).toEqual([
      { id: 'he2017drain', title: 'he2017drain' },
      { id: 'zhu2020loghub', title: 'Loghub' }
    ])
  })

  it('offers the paper of the chat and the cited papers first when saving to notes', () => {
    const rows = [
      { id: 'b2020x', title: 'Beta' },
      { id: 'a2020x', title: 'Alpha' },
      { id: 'c2020x', title: 'Gamma' }
    ]
    const cited = [
      { paper: 'c2020x', page: 1, quote: 'q', state: 'found' as const },
      { paper: 'gone2020x', page: 1, quote: 'q', state: 'unknown_paper' as const }
    ]
    expect(notePaperOptions('b2020x', cited, rows)).toEqual([
      { id: 'b2020x', title: 'Beta', suggested: true },
      { id: 'c2020x', title: 'Gamma', suggested: true },
      { id: 'a2020x', title: 'Alpha', suggested: false }
    ])
  })
})
