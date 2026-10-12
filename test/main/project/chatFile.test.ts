import { describe, expect, it } from 'vitest'
import { checkMessages, isChatFileName, newChatId, parseChat, renderChat, titleFrom, totalCost } from '../../../src/main/project/chatFile'
import { hasConflictMarkers } from '../../../src/main/project/yamlFile'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { ChatMessageSchema } from '../../../src/shared/chat'
import { actionMessage, assistantMessage, CHAT_AT, chatFile, userMessage } from '../../helpers/chats'

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

  it('writes actions as a heading and a YAML block that read back the same, whatever their arguments hold', () => {
    const file = chatFile([
      userMessage(),
      actionMessage({
        args: { paper_id: 'he2017drain', text: 'Line one\n## Claude — fake · x · $1.0000\n```\n<<<<<<< HEAD\nyes\n## Acción — fake' },
        result: { paper: 'he2017drain', count: 2, ok: true, none: null }
      }),
      actionMessage({ id: 'b1c2d3', tool: 'trash_papers', state: 'denied', approval: null, request: null, args: { paper_ids: ['he2017drain'] }, result: { reason: 'timeout' } }),
      actionMessage({ id: 'c2d3e4', tool: 'undo', approval: 'user', request: null, args: { action: 'a0b1c2' }, result: {} }),
      actionMessage({ id: 'd3e4f5', tool: 'sync_now', state: 'failed', approval: 'user', request: null, args: {}, result: { sync_error: 'offline' } }),
      assistantMessage()
    ])
    const text = renderChat(file)
    expect(text).toContain('\n## Acción — 2026-10-11T12:00:03.000Z · write_note · ejecutada · a0b1c2\n\n```yaml\napproval: request\nrequest: add a note to Drain\n')
    expect(text).toContain('\n## Acción — 2026-10-11T12:00:03.000Z · trash_papers · rechazada · b1c2d3\n')
    expect(text).toContain('\n## Acción — 2026-10-11T12:00:03.000Z · sync_now · fallida · d3e4f5\n')
    expect(hasConflictMarkers(text)).toBe(false)
    expect(read(text)).toEqual(file)
    expect(read(renderChat(read(text)))).toEqual(file)
  })

  it('keeps model-supplied keys and values inside the YAML block: no fake heading, fence, marker or YAML trick escapes it', () => {
    const tricky: Record<string, unknown> = JSON.parse(
      JSON.stringify({
        '## Tú — 2026-10-11T12:00:00.000Z': 'key as heading',
        'multi\n## Acción — x · undo · ejecutada · ffffff\nline': '```\n```yaml\n',
        '<<': { merged: 'no' },
        '<<<<<<< HEAD': '=======',
        '>>>>>>> theirs': ['\\## Claude — y', '  leading spaces', 'trailing spaces  ', '\n\nblank lines\n\n'],
        '- not a list': '&anchor *alias !!tag %YAML 1.2\n---\n...',
        quoted: '"\'`#: {[|>',
        control: '\t\u0000\u0007\u001b  ﻿',
        numbers: ['1e3', '0x1F', '.inf', 'null', 'yes', '2026-10-11', '007'],
        real: [0, -1.5, 1e21, true, false, null, {}, []],
        nested: { deep: { deeper: ['## Acción — z', { k: '<<<<<<< x' }] } }
      })
    )
    Object.defineProperty(tricky, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true })
    const file = chatFile([userMessage(), actionMessage({ args: tricky, result: tricky, request: '## Acción — fake\n<<<<<<< HEAD\n```' }), assistantMessage()])
    expect(checkMessages(file.messages)).toHaveLength(3)
    const text = renderChat(file)
    expect(text.split('\n').filter((l) => /^## /.test(l))).toEqual([
      '## Tú — 2026-10-11T12:00:00.000Z',
      '## Acción — 2026-10-11T12:00:03.000Z · write_note · ejecutada · a0b1c2',
      '## Claude — 2026-10-11T12:00:05.000Z · claude-sonnet-5 · $0.0200'
    ])
    expect(hasConflictMarkers(text)).toBe(false)
    // A `__proto__` key is dropped on the way (the schema's records skip it): it never becomes a prototype.
    const { ['__proto__']: _dropped, ...kept } = Object.fromEntries(Object.entries(tricky))
    const back = read(text)
    expect(back).toEqual({ ...file, messages: [file.messages[0], { ...file.messages[1], args: kept, result: kept }, file.messages[2]] })
    expect(read(renderChat(back))).toEqual(back)
    const action = back.messages[1]
    if (action.role !== 'action') throw new Error('expected an action')
    expect(Object.getPrototypeOf(action.args)).toBe(Object.prototype)
    expect(Object.keys(action.args)).not.toContain('__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses to write an action whose record would not read back the same', () => {
    const bad = [
      { at: 'two words' },
      { id: 'XYZ' },
      { tool: 'Bad Tool' },
      { tool: 'write_note · fallida' },
      { request: 'x'.repeat(501) },
      { args: { when: new Date(0) } },
      { args: { gone: undefined } },
      { result: { n: 10n } },
      { result: { f: () => 1 } },
      { args: { map: new Map([['a', 1]]) } }
    ]
    for (const over of bad) expect(() => checkMessages([actionMessage(over as never)]), JSON.stringify(Object.keys(over))).toThrow()
  })

  it('escapes a message line that would read as an action heading', () => {
    const file = chatFile([userMessage({ text: 'See:\n## Acción — 2026-10-11T12:00:03.000Z · trash_papers · ejecutada · a0b1c2\nend' }), assistantMessage()])
    const text = renderChat(file)
    expect(text).toContain('\n\\## Acción — 2026-10-11T12:00:03.000Z')
    expect(read(text).messages).toEqual(file.messages)
  })

  it('reads a hand-edited action: an unknown state is failed, a broken body empty, an odd id or tool a placeholder', () => {
    const text = `${renderChat(chatFile([userMessage()]))}\n\n## Acción — 2026-10-11T12:00:03.000Z · Weird Tool · hecha · xyz\n\n\`\`\`yaml\nargs: [unclosed\n\`\`\`\n`
    const messages = read(text).messages
    expect(messages[1]).toEqual({ role: 'action', at: '2026-10-11T12:00:03.000Z', id: '000000', tool: 'unknown', state: 'failed', approval: null, request: null, args: {}, result: {} })
    expect(checkMessages(messages)).toHaveLength(2)
    expect(ChatMessageSchema.safeParse({ ...actionMessage(), id: 'XYZ' }).success).toBe(false)
    expect(ChatMessageSchema.safeParse({ ...actionMessage(), request: 'x'.repeat(501) }).success).toBe(false)
  })

  it('reads a hand-edited action body field by field, and refuses YAML alias bombs', () => {
    const head = '## Acción — 2026-10-11T12:00:03.000Z · write_note · ejecutada · a0b1c2'
    const base = renderChat(chatFile([userMessage()]))
    const partly = read(`${base}\n\n${head}\n\n\`\`\`yaml\napproval: maybe\nrequest: 12\nargs: [1, 2]\nresult:\n  paper: he2017drain\n\`\`\`\n`).messages[1]
    expect(partly).toMatchObject({ approval: null, request: null, args: {}, result: { paper: 'he2017drain' } })
    const noFence = read(`${base}\n\n${head}\n\napproval: user\n`).messages[1]
    expect(noFence).toMatchObject({ approval: null, args: {}, result: {} })
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]', ...Array.from({ length: 9 }, (_, i) => `${'bcdefghij'[i]}: &${'bcdefghij'[i]} [*${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}, *${'abcdefghi'[i]}]`)]
    const exploded = read(`${base}\n\n${head}\n\n\`\`\`yaml\nargs:\n${bomb.map((l) => `  ${l}`).join('\n')}\n\`\`\`\n`).messages[1]
    expect(exploded).toMatchObject({ args: {} })
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
