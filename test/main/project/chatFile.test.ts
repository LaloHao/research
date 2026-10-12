import { describe, expect, it } from 'vitest'
import { isChatFileName, newChatId, parseChat, renderChat, titleFrom, totalCost } from '../../../src/main/project/chatFile'
import { hasConflictMarkers } from '../../../src/main/project/yamlFile'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { ChatMessageSchema } from '../../../src/shared/chat'
import { assistantMessage, CHAT_AT, chatFile, userMessage } from '../../helpers/chats'

const read = (text: string) => {
  const r = parseChat(text)
  if (!r.ok) throw new Error(r.problem.message)
  return r.value
}

describe('chat file format', () => {
  it('writes a readable Markdown file that reads back the same', () => {
    const file = chatFile([
      userMessage({ excerpt: { paper: 'he2017drain', page: 3, quote: 'a fixed depth parse tree' }, text: 'Why a fixed depth?\n\nAnd why online?' }),
      assistantMessage({ text: 'Because it is fast.\n\n- one\n- two', costUsd: 0.0123 }),
      userMessage({ at: '2026-10-11T12:01:00.000Z', text: 'Thanks' }),
      assistantMessage({ at: '2026-10-11T12:01:05.000Z', text: 'Partial', stopped: true, costUsd: 0.5 })
    ])
    const text = renderChat(file)
    expect(text).toContain('\n## Tú — 2026-10-11T12:00:00.000Z\n\n> [[he2017drain|p. 3|"a fixed depth parse tree"]]\n\nWhy a fixed depth?\n\nAnd why online?\n')
    expect(text).toContain('\n## Claude — 2026-10-11T12:00:05.000Z · claude-sonnet-5 · $0.0123\n\nBecause it is fast.')
    expect(text).toContain('## Claude — 2026-10-11T12:01:05.000Z · claude-sonnet-5 · $0.5000 · detenida\n')
    expect(read(text)).toEqual(file)
  })

  it('escapes message lines that would read as a heading, and keeps an empty stopped answer', () => {
    const file = chatFile([userMessage({ text: 'Quote:\n## Claude — fake\nend' }), assistantMessage({ text: '', stopped: true, costUsd: 0 })])
    const text = renderChat(file)
    expect(text).toContain('\n\\## Claude — fake\n')
    expect(read(text).messages).toEqual(file.messages)
  })

  it('round-trips any message text: headings, escapes, conflict-marker lines, rules, fences and excerpt look-alikes', () => {
    const tricky = [
      '## Tú — 2026-10-11T12:00:00.000Z',
      '\\## Claude — already escaped by hand',
      '\\\\## Tú — two backslashes',
      '## Tú — decomposed accent',
      '---',
      '=======',
      '<<<<<<< HEAD',
      '>>>>>>> theirs',
      '```md\n## Claude — inside a fence · x · $1.0000\n---\n```',
      '    indented code',
      '# A heading\n\n### Another'
    ].join('\n')
    const file = chatFile([
      userMessage({ text: `> [[he2017drain|p. 3|"looks like an excerpt"]]\n\n${tricky}` }),
      assistantMessage({ text: tricky }),
      userMessage({ text: '\\> [[he2017drain|"escaped look-alike"]]', excerpt: { paper: 'he2017drain', page: null, quote: 'web text' } }),
      assistantMessage({ text: '    starts indented\nend' })
    ])
    const text = renderChat(file)
    expect(hasConflictMarkers(text)).toBe(false)
    expect(read(text)).toEqual(file)
    expect(read(renderChat(read(text)))).toEqual(file)
  })

  it('normalizes surrounding blank lines and trailing whitespace the same way on write and read', () => {
    const file = chatFile([userMessage({ text: '\n\n  Q  \n\n' }), assistantMessage({ text: 'A\n\n\n' })])
    expect(read(renderChat(file)).messages).toEqual([userMessage({ text: '  Q' }), assistantMessage({ text: 'A' })])
  })

  it('reads a file with Windows line endings, hashing the bytes on disk', () => {
    const text = renderChat(chatFile())
    const crlf = text.replace(/\n/g, '\r\n')
    const r = parseChat(crlf)
    expect(r).toMatchObject({ ok: true, value: chatFile() })
    expect(r.hash).not.toBe(parseChat(text).hash)
  })

  it('reads a hand-edited file: text before the first heading is ignored, odd heading parts tolerated', () => {
    const text = `${renderChat(chatFile([]))}A note of mine.\n\n## Tú — 2026-10-11T12:00:00.000Z\n\n> not an excerpt\n\nQ\n\n## Claude — 2026-10-11T12:00:01.000Z · $abc\n\nA\n`
    expect(read(text).messages).toEqual([
      { role: 'user', at: CHAT_AT, text: '> not an excerpt\n\nQ', excerpt: null },
      { role: 'assistant', at: '2026-10-11T12:00:01.000Z', model: 'unknown', costUsd: 0, stopped: false, text: 'A' }
    ])
  })

  it('tolerates trailing spaces on a hand-edited heading and a leading BOM', () => {
    const text = `\uFEFF${renderChat(chatFile([]))}## Tú — 2026-10-11T12:00:00.000Z  \n\nQ\n\n## Claude — 2026-10-11T12:00:01.000Z · m · $0.0100 · detenida \t\n\nA\n`
    const r = parseChat(text)
    expect(r.hash).toBe(sha256(text))
    expect(read(text).messages).toEqual([
      { role: 'user', at: CHAT_AT, text: 'Q', excerpt: null },
      { role: 'assistant', at: '2026-10-11T12:00:01.000Z', model: 'm', costUsd: 0.01, stopped: true, text: 'A' }
    ])
  })

  it('reads hand-edited heading fields as values it can write back', () => {
    const big = '9'.repeat(400)
    const text = `${renderChat(chatFile([]))}## Tú — 2026-10-11T12:00:00.000Z\n\n> [[he2017drain|p. 2|" two  spaces "]]\n\nQ\n\n## Claude — 2026-10-11T12:00:01.000Z · detenida · $${big}\n\nA\n`
    const messages = read(text).messages
    expect(messages).toEqual([
      { role: 'user', at: CHAT_AT, text: 'Q', excerpt: { paper: 'he2017drain', page: 2, quote: 'two spaces' } },
      { role: 'assistant', at: '2026-10-11T12:00:01.000Z', model: 'unknown', costUsd: 0, stopped: true, text: 'A' }
    ])
    for (const m of messages) expect(ChatMessageSchema.safeParse(m).success).toBe(true)
  })

  it('reports conflict markers and an invalid frontmatter as problems', () => {
    expect(parseChat(`<<<<<<< ours\n${renderChat(chatFile())}=======\nx\n>>>>>>> theirs\n`)).toMatchObject({ ok: false, problem: { kind: 'conflict_markers' } })
    expect(parseChat('---\nschema_version: 1\nid: nope\n---\n\n')).toMatchObject({ ok: false, problem: { kind: 'invalid_schema' } })
  })
})

describe('chat ids, titles and costs', () => {
  it('names a conversation after its creation time', () => {
    expect(newChatId(new Date('2026-10-11T14:25:30.123Z'), 'a3f9c0')).toBe('20261011-142530-a3f9')
    expect(isChatFileName('20261011-142530-a3f9.md')).toBe(true)
    expect(isChatFileName('20261011-142530-a3f9-0a1b2c.md')).toBe(true)
    for (const name of ['20261011-142530-a3f9.txt', 'notes.md', '.20261011-142530-a3f9.md.x.tmp']) expect(isChatFileName(name)).toBe(false)
  })

  it('titles a conversation with the first line of its first question', () => {
    expect(titleFrom('\n  What does   Drain do?\nMore text')).toBe('What does Drain do?')
    const long = 'word '.repeat(40)
    expect(titleFrom(long)).toMatch(/^(word ){15}word…$/)
    expect(titleFrom('x'.repeat(100))).toBe(`${'x'.repeat(80)}…`)
  })

  it('adds up the answers, rounded to 4 decimals', () => {
    expect(totalCost([userMessage(), assistantMessage({ costUsd: 0.1 }), assistantMessage({ costUsd: 0.2 })])).toBe(0.3)
  })
})
