import { describe, expect, it } from 'vitest'
import { checkMessages, parseChat, renderChat } from '../../../src/main/project/chatFile'
import { CHAT_PATH, mergeChatText } from '../../../src/main/sync/chatMerge'
import type { ChatFile } from '../../../src/shared/chat'
import { assistantMessage, CHAT_ID_A, chatFile, userMessage } from '../../helpers/chats'

const text = (f: ChatFile): string => renderChat(f)
const read = (t: string): ChatFile => {
  const r = parseChat(t)
  if (!r.ok) throw new Error(r.problem.message)
  return r.value
}
const Q2 = userMessage({ at: '2026-10-11T13:00:00.000Z', text: 'And Loghub?' })
const A2 = assistantMessage({ at: '2026-10-11T13:00:05.000Z', text: 'A dataset collection.', costUsd: 0.03 })
const Q3 = userMessage({ at: '2026-10-11T14:00:00.000Z', text: 'Something else' })
const BASE = chatFile()

describe('mergeChatText', () => {
  it('merges a conversation one machine only continued', () => {
    const ours = chatFile([...BASE.messages, Q2, A2], { updated_at: '2026-10-11T13:00:05.000Z' })
    const theirs = chatFile(BASE.messages, { title: 'Drain, explained', updated_at: '2026-10-11T12:30:00.000Z', updated_on: 'desktop' })
    const merged = mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!
    expect(merged.copy).toBeNull()
    expect(read(merged.text)).toEqual({
      meta: { ...ours.meta, title: 'Drain, explained', cost_usd: 0.05 },
      messages: [...BASE.messages, Q2, A2]
    })
  })

  it('takes the longer side when it is theirs, and keeps unknown keys of both sides', () => {
    const ours = { ...chatFile(BASE.messages), meta: { ...chatFile(BASE.messages).meta, from_ours: 1 } }
    const theirs = { ...chatFile([...BASE.messages, Q2, A2]), meta: { ...chatFile([...BASE.messages, Q2, A2]).meta, from_theirs: 'x' } }
    const merged = read(mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!.text)
    expect(merged.messages).toEqual([...BASE.messages, Q2, A2])
    expect(merged.meta).toMatchObject({ from_ours: 1, from_theirs: 'x', cost_usd: 0.05 })
  })

  it('takes a field changed on both machines from the newest change', () => {
    const ours = chatFile(BASE.messages, { archived: true, updated_at: '2026-10-11T15:00:00.000Z' })
    const theirs = chatFile(BASE.messages, { archived: false, title: 'Renamed', updated_at: '2026-10-11T16:00:00.000Z', updated_on: 'desktop' })
    const base = chatFile(BASE.messages, { archived: true, title: 'Old' })
    expect(read(mergeChatText({ base: text(base), ours: text(ours), theirs: text(theirs) })!.text).meta).toMatchObject({
      archived: false,
      title: 'Renamed',
      updated_at: '2026-10-11T16:00:00.000Z',
      updated_on: 'desktop'
    })
  })

  it('recomputes cost_usd from the answers, whatever the sides wrote', () => {
    const ours = chatFile([...BASE.messages, Q2, A2], { cost_usd: 7 })
    const theirs = chatFile(BASE.messages, { cost_usd: 3 })
    expect(read(mergeChatText({ base: null, ours: text(ours), theirs: text(theirs) })!.text).meta.cost_usd).toBe(0.05)
  })

  it('keeps both versions when both machines added different messages', () => {
    const ours = chatFile([...BASE.messages, Q2, A2])
    const theirs = chatFile([...BASE.messages, Q3], { updated_on: 'desktop' })
    const merged = mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!
    expect(merged.text).toBe(text(ours))
    expect(merged.copy!.relPath).toMatch(new RegExp(`^chats/${CHAT_ID_A}-[0-9a-f]{6}\\.md$`))
    expect(CHAT_PATH.test(merged.copy!.relPath)).toBe(true)
    const copy = read(merged.copy!.text)
    expect(copy.meta).toMatchObject({ id: merged.copy!.relPath.slice(6, -3), copy_of: { id: CHAT_ID_A, machine: 'desktop' }, title: theirs.meta.title })
    expect(copy.messages).toEqual(theirs.messages)
    expect(() => checkMessages(copy.messages)).not.toThrow()
    expect(mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!.copy!.relPath).toBe(merged.copy!.relPath)
  })

  it('keeps both versions when one machine edited a message the other kept', () => {
    const ours = chatFile([userMessage(), assistantMessage({ text: 'Edited by hand.' })])
    const theirs = chatFile([...BASE.messages, Q2])
    const merged = mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!
    expect(read(merged.text).messages).toEqual(ours.messages)
    expect(read(merged.copy!.text).messages).toEqual(theirs.messages)
  })

  it('names a copy without a known machine as such', () => {
    const theirs = chatFile([...BASE.messages, Q3], { updated_on: undefined })
    delete (theirs.meta as Record<string, unknown>).updated_on
    const merged = mergeChatText({ base: text(BASE), ours: text(chatFile([...BASE.messages, Q2])), theirs: text(theirs) })!
    expect(read(merged.copy!.text).meta.copy_of).toEqual({ id: CHAT_ID_A, machine: null })
  })

  it('round-trips messages whose text needs escaping', () => {
    const tricky = userMessage({ at: '2026-10-11T13:00:00.000Z', text: '## Tú — 2026\n<<<<<<< ours\n=======\n>>>>>>> theirs' })
    const ours = chatFile([...BASE.messages, tricky])
    const merged = mergeChatText({ base: text(BASE), ours: text(ours), theirs: text(BASE) })!
    expect(read(merged.text).messages).toEqual(ours.messages)
  })

  it('leaves a side it cannot read to the user', () => {
    expect(mergeChatText({ base: text(BASE), ours: 'garbage', theirs: text(BASE) })).toBeNull()
    expect(mergeChatText({ base: text(BASE), ours: text(BASE), theirs: `${text(BASE)}\n<<<<<<< ours\n` })).toBeNull()
  })

  it('leaves a side whose id is not the file name to the user', () => {
    const other = chatFile(BASE.messages, { id: '20261011-110000-c3d4' })
    expect(mergeChatText({ base: text(BASE), ours: text(BASE), theirs: text(other) }, CHAT_ID_A)).toBeNull()
    expect(mergeChatText({ base: text(BASE), ours: text(BASE), theirs: text(BASE) }, CHAT_ID_A)).not.toBeNull()
  })

  it('leaves the split to the user when the copy would have too long an id', () => {
    const deep = `${CHAT_ID_A}${'-abcdef'.repeat(8)}`
    const ours = chatFile([...BASE.messages, Q2], { id: deep })
    const theirs = chatFile([...BASE.messages, Q3], { id: deep })
    expect(mergeChatText({ base: null, ours: text(ours), theirs: text(theirs) })).toBeNull()
  })
})

describe('CHAT_PATH', () => {
  it('matches conversation files only', () => {
    expect(CHAT_PATH.test(`chats/${CHAT_ID_A}.md`)).toBe(true)
    expect(CHAT_PATH.test(`chats/${CHAT_ID_A}-abcdef.md`)).toBe(true)
    expect(CHAT_PATH.test('chats/notes.md')).toBe(false)
    expect(CHAT_PATH.test(`chats/sub/${CHAT_ID_A}.md`)).toBe(false)
    expect(CHAT_PATH.test(`papers/k/${CHAT_ID_A}.md`)).toBe(false)
  })
})
