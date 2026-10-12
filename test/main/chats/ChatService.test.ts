import { describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { asWritten } from '../../../src/main/chats/ChatService'
import type { LlmModel } from '../../../src/shared/summary'
import { parseChat, renderChat } from '../../../src/main/project/chatFile'
import { actionMessage, assistantMessage, CHAT_AT, CHAT_ID_A, chatFile, DEVICE, DRAIN_QUOTE, setupChats, userMessage } from '../../helpers/chats'
import { DRAIN_ID, LOGHUB_ID } from '../../helpers/pair'

const OTHER = '20261010-090000-c3d4'
const BROKEN = '20261009-090000-ffff'
const LOGHUB_TRASH_ROW = { id: LOGHUB_ID, title: 'Loghub', authors_label: '', year: 2020, doi: null, openalex_id: null, trashed_at: CHAT_AT, device: null, problem: null }

describe('ChatService conversations', () => {
  it('shows recorded actions, marks the undone ones, and answers again a question whose answer failed after its actions', async () => {
    const { store, chats, provider } = await setupChats()
    const undo = actionMessage({ id: 'b0b1c2', at: '2026-10-11T12:00:04.000Z', tool: 'undo', approval: 'user', request: null, args: { action: 'a0b1c2' }, result: {} })
    await store.writeChat(chatFile([userMessage(), actionMessage(), undo]), null)
    await chats.reindex()
    const c = await chats.open(CHAT_ID_A)
    expect(c.canRetry).toBe(true)
    expect(c.messages.slice(1)).toMatchObject([
      { role: 'action', id: 'a0b1c2', undone: true, undoable: false },
      { role: 'action', tool: 'undo', undone: false, undoable: false }
    ])
    expect(chats.list({ text: 'write_note' })).toEqual([])
    expect(c.summary.messages).toBe(1)
    expect(chats.list({ text: 'Parses online' })).toEqual([])
    await chats.retry(CHAT_ID_A)
    await chats.idle()
    expect((await chats.open(CHAT_ID_A)).messages.map((m) => m.role)).toEqual(['user', 'action', 'action', 'assistant'])
    expect(provider.chatCalls[0].input.endsWith('<question>\nWhat does Drain do?\n</question>')).toBe(true)
    expect(provider.chatCalls[0].input).not.toContain('<conversation>')
    expect((await chats.open(CHAT_ID_A)).canRetry).toBe(false)
  })

  it('lists the conversations in chats/, newest first, by words or by paper, with unreadable files flagged', async () => {
    const { store, chats } = await setupChats()
    await store.writeChat(chatFile(), null)
    await store.writeChat(
      chatFile([userMessage({ text: '¿Qué técnicas usa Loghub?' })], { id: OTHER, title: 'Técnicas de Loghub', scope: { paper: LOGHUB_ID }, updated_at: '2026-10-10T09:00:00.000Z' }),
      null
    )
    await writeFile(store.chatPath(BROKEN), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n')
    await chats.reindex()
    expect(chats.list().map((c) => [c.id, c.problem])).toEqual([
      [CHAT_ID_A, false],
      [OTHER, false],
      [BROKEN, true]
    ])
    expect(chats.list({ text: 'TECNICAS' }).map((c) => c.id)).toEqual([OTHER])
    expect(chats.list({ text: 'log  messages online' }).map((c) => c.id)).toEqual([CHAT_ID_A])
    expect(chats.list({ paper: LOGHUB_ID })).toEqual([
      expect.objectContaining({ id: OTHER, paperTitle: 'Loghub: A Large Collection of System Log Datasets', paperState: 'library', messages: 1, costUsd: 0, copyOf: null })
    ])
    await expect(chats.open(BROKEN)).rejects.toMatchObject({ code: 'chat_invalid' })
  })

  it('opens a conversation with its citations checked, and shows where the paper of a paper chat went', async () => {
    const { store, cache, chats } = await setupChats()
    const answer = `Drain [[${DRAIN_ID}|p. 2|"${DRAIN_QUOTE}"]], invented [[${DRAIN_ID}|p. 1|"no such sentence anywhere here"]], Loghub [[${LOGHUB_ID}|p. 1|"a large collection of system log datasets"]].`
    await store.writeChat(chatFile([userMessage(), assistantMessage({ text: answer }), userMessage({ text: 'And?' })], { scope: { paper: LOGHUB_ID } }), null)
    await store.trashPaper(LOGHUB_ID, DEVICE, new Date(CHAT_AT))
    cache.moveToTrash(LOGHUB_TRASH_ROW)
    await chats.reindex()
    const chat = await chats.open(CHAT_ID_A)
    expect(chat.summary).toMatchObject({ paperState: 'trash', paperTitle: null })
    expect(chat.messages[1]).toMatchObject({
      unverified: 2,
      citations: [
        { paper: DRAIN_ID, page: 1, state: 'found' },
        { paper: DRAIN_ID, page: 1, state: 'not_found' },
        { paper: LOGHUB_ID, state: 'paper_in_trash' }
      ]
    })
    expect(chat).toMatchObject({ partial: null, canRetry: true })
    await expect(chats.open('20261001-000000-0000')).rejects.toMatchObject({ code: 'chat_not_found' })
    await expect(chats.open('../config')).rejects.toMatchObject({ code: 'chat_not_found' })
  })

  it('renames, archives and changes the model, recording this machine, and deletes only when confirmed', async () => {
    const { store, chats, counter } = await setupChats()
    await store.writeChat(chatFile(undefined, { updated_on: 'desktop' }), null)
    await chats.reindex()
    await chats.rename(CHAT_ID_A, '  Drain,   explained ')
    await chats.setArchived(CHAT_ID_A, true)
    await chats.setModel(CHAT_ID_A, 'opus')
    expect(await store.readChat(CHAT_ID_A)).toMatchObject({
      ok: true,
      value: { meta: { title: 'Drain, explained', archived: true, model: 'opus', updated_on: 'laptop', updated_at: CHAT_AT, cost_usd: 0.02 } }
    })
    expect(counter.events).toBe(3)
    await expect(chats.rename(CHAT_ID_A, '   ')).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(chats.rename(CHAT_ID_A, 'x'.repeat(121))).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(chats.setModel(CHAT_ID_A, 'gpt' as LlmModel)).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(chats.remove(CHAT_ID_A, false)).rejects.toMatchObject({ code: 'invalid_edit' })
    expect(await store.listChatIds()).toEqual([CHAT_ID_A])
    await expect(chats.remove('../../papers/he2017drain/paper', true)).rejects.toMatchObject({ code: 'chat_not_found' })
    expect(store.paperExists(DRAIN_ID)).toBe(true)
    await chats.remove(CHAT_ID_A, true)
    expect(await store.listChatIds()).toEqual([])
    expect(chats.list()).toEqual([])
    expect(counter.events).toBe(4)
  })

  it('deletes an unreadable conversation too', async () => {
    const { store, chats } = await setupChats()
    await mkdir(dirname(store.chatPath(BROKEN)), { recursive: true })
    await writeFile(store.chatPath(BROKEN), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n')
    await chats.reindex()
    await chats.remove(BROKEN, true)
    expect(await store.listChatIds()).toEqual([])
  })

  it('picks up files changed outside the app, but not its own writes', async () => {
    const { store, chats } = await setupChats()
    await chats.reindex()
    expect(await chats.reindexIfChanged()).toBe(false)
    await store.writeChat(chatFile(), null)
    expect(await chats.reindexIfChanged()).toBe(true)
    await chats.rename(CHAT_ID_A, 'Mine')
    expect(await chats.reindexIfChanged()).toBe(false)
    await writeFile(store.chatPath(CHAT_ID_A), renderChat(chatFile(undefined, { title: 'Edited by hand' })))
    expect(await chats.reindexIfChanged()).toBe(true)
    expect(chats.list()[0].title).toBe('Edited by hand')
    await writeFile(store.chatPath(CHAT_ID_A), renderChat(chatFile(undefined, { title: 'Edited by hand' })))
    expect(await chats.reindexIfChanged()).toBe(false)
    await rm(store.chatPath(CHAT_ID_A))
    expect(await chats.reindexIfChanged()).toBe(true)
    expect(chats.list()).toEqual([])
  })

  it('reports a conversation that opening found new or changed on disk', async () => {
    const { store, chats, counter } = await setupChats()
    await chats.reindex()
    await store.writeChat(chatFile(), null)
    await chats.open(CHAT_ID_A)
    expect(counter.events).toBe(1)
    expect(chats.list().map((c) => c.id)).toEqual([CHAT_ID_A])
    await chats.open(CHAT_ID_A)
    expect(counter.events).toBe(1)
    expect(await chats.reindexIfChanged()).toBe(false)
  })

  it('never lets a scan that started before its own write put the older version back', async () => {
    const { store, chats } = await setupChats()
    await store.writeChat(chatFile(), null)
    await chats.reindex()
    const readChat = store.readChat.bind(store)
    let release = (): void => {}
    let paused = false
    store.readChat = async (id) => {
      const r = await readChat(id)
      if (!paused) {
        paused = true
        await new Promise<void>((resolve) => (release = resolve))
      }
      return r
    }
    const scan = chats.reindex()
    await new Promise((r) => setTimeout(r, 20))
    await chats.rename(CHAT_ID_A, 'Renamed meanwhile')
    release()
    await scan
    expect(chats.list()[0].title).toBe('Renamed meanwhile')
    store.readChat = readChat
    expect(await chats.reindexIfChanged()).toBe(false)
  })

  it('keeps in the index exactly what it wrote: texts cleaned, costs rounded, excerpts normalized', async () => {
    const raw = chatFile([
      userMessage({ text: '\n\n  Why?  \n\n', excerpt: { paper: DRAIN_ID, page: 1, quote: '  Drain   parses\nlogs ' } }),
      assistantMessage({ text: 'Because.\r\n\r\n', costUsd: 0.123456789 })
    ])
    const written = asWritten(raw)
    expect(written.messages).toEqual([
      userMessage({ text: '  Why?', excerpt: { paper: DRAIN_ID, page: 1, quote: 'Drain parses logs' } }),
      assistantMessage({ text: 'Because.', costUsd: 0.1235 })
    ])
    expect(written.meta.cost_usd).toBe(0.1235)
    const reread = parseChat(renderChat(written))
    expect(reread.ok && reread.value).toEqual(written)
    expect(() => asWritten(chatFile([userMessage({ excerpt: { paper: 'Bad Key', page: 1, quote: 'x' } })]))).toThrow(expect.objectContaining({ code: 'invalid_edit' }))
    expect(() => asWritten(chatFile([userMessage({ excerpt: { paper: DRAIN_ID, page: 0, quote: 'x' } })]))).toThrow(expect.objectContaining({ code: 'invalid_edit' }))
  })

  it('opens, after its own write, the same conversation the file holds', async () => {
    const { store, chats } = await setupChats()
    await mkdir(dirname(store.chatPath(CHAT_ID_A)), { recursive: true })
    await writeFile(store.chatPath(CHAT_ID_A), renderChat(chatFile([userMessage({ text: '\n\nWhat does Drain do?   ' }), assistantMessage()])))
    await chats.reindex()
    await chats.rename(CHAT_ID_A, 'Renamed')
    const inMemory = await chats.open(CHAT_ID_A)
    await chats.reindex()
    expect(await chats.open(CHAT_ID_A)).toEqual(inMemory)
    expect(await chats.reindexIfChanged()).toBe(false)
  })

  it("appends an answer to a paper's notes with its citations as text, and collects their BibTeX", async () => {
    const { store, chats } = await setupChats()
    const answer = `Drain [[${DRAIN_ID}|p. 1|"${DRAIN_QUOTE}"]] and Loghub [[${LOGHUB_ID}|"a large collection"]] and [[gone2020x|"x y"]].`
    await store.writeChat(chatFile([userMessage(), assistantMessage({ text: answer })]), null)
    await store.writeNotes(DRAIN_ID, 'My notes.\n', null)
    await chats.reindex()
    await chats.saveToNotes(CHAT_ID_A, 1, DRAIN_ID)
    expect((await store.readNotes(DRAIN_ID)).text).toBe(
      `My notes.\n\n### Claude — 2026-10-11 — What does Drain do?\n\nDrain "${DRAIN_QUOTE}" [${DRAIN_ID}, p. 1] and Loghub "a large collection" [${LOGHUB_ID}] and "x y" [gone2020x].\n`
    )
    await chats.saveToNotes(CHAT_ID_A, 1, LOGHUB_ID)
    expect((await store.readNotes(LOGHUB_ID)).text.startsWith('### Claude — 2026-10-11')).toBe(true)
    await expect(chats.saveToNotes(CHAT_ID_A, 0, DRAIN_ID)).rejects.toMatchObject({ code: 'invalid_edit' })
    await expect(chats.saveToNotes(CHAT_ID_A, 1, 'gone2020x')).rejects.toMatchObject({ code: 'paper_not_in_library' })
    await expect(chats.saveToNotes(CHAT_ID_A, 1, '../x')).rejects.toMatchObject({ code: 'paper_not_in_library' })
    const bib = await chats.citationsBibtex(CHAT_ID_A, 1)
    expect(bib.startsWith('@inproceedings{he2017drain,')).toBe(true)
    expect(bib).toContain('@misc{zhu2020loghub,')
    expect(bib).not.toContain('gone2020x')
    await expect(chats.saveToNotes(CHAT_ID_A, 1)).rejects.toMatchObject({ code: 'invalid_edit' })
  })

  it('leaves a trashed cited paper out of the notes targets and the BibTeX, also when it goes during the copy', async () => {
    const { store, cache, chats } = await setupChats()
    const answer = `Drain [[${DRAIN_ID}|p. 1|"${DRAIN_QUOTE}"]] and Loghub [[${LOGHUB_ID}|"a large collection"]].`
    await store.writeChat(chatFile([userMessage(), assistantMessage({ text: answer })]), null)
    await chats.reindex()
    const readPaper = store.readPaper.bind(store)
    store.readPaper = async (id) => {
      if (id === DRAIN_ID) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return readPaper(id)
    }
    expect(await chats.citationsBibtex(CHAT_ID_A, 1)).toMatch(/^@misc\{zhu2020loghub,/)
    store.readPaper = readPaper
    await store.trashPaper(LOGHUB_ID, DEVICE, new Date(CHAT_AT))
    cache.moveToTrash(LOGHUB_TRASH_ROW)
    await expect(chats.saveToNotes(CHAT_ID_A, 1, LOGHUB_ID)).rejects.toMatchObject({ code: 'paper_not_in_library' })
    const bib = await chats.citationsBibtex(CHAT_ID_A, 1)
    expect(bib.startsWith('@inproceedings{he2017drain,')).toBe(true)
    expect(bib).not.toContain('zhu2020loghub')
  })

  it("saves to a paper chat's own paper unless the user picked another", async () => {
    const { store, chats } = await setupChats()
    await store.writeChat(chatFile(undefined, { scope: { paper: DRAIN_ID } }), null)
    await chats.reindex()
    await chats.saveToNotes(CHAT_ID_A, 1)
    expect((await store.readNotes(DRAIN_ID)).text.startsWith('### Claude — ')).toBe(true)
    await chats.saveToNotes(CHAT_ID_A, 1, LOGHUB_ID)
    expect((await store.readNotes(LOGHUB_ID)).text.startsWith('### Claude — ')).toBe(true)
  })

  it('never rewrites what the user wrote in the notes, and retries when they change meanwhile', async () => {
    const { store, chats } = await setupChats()
    await store.writeChat(chatFile(), null)
    const mine = '# Mine\n\nNo newline at the end   '
    await store.writeNotes(DRAIN_ID, mine, null)
    await chats.reindex()
    const readNotes = store.readNotes.bind(store)
    let raced = false
    store.readNotes = async (id) => {
      const r = await readNotes(id)
      if (!raced) {
        raced = true
        await store.writeNotes(id, `${mine}\nAdded meanwhile.\n`, r.hash)
      }
      return r
    }
    await chats.saveToNotes(CHAT_ID_A, 1, DRAIN_ID)
    const text = await readFile(store.paperDir(DRAIN_ID) + '/notes.md', 'utf8')
    expect(text.startsWith(`${mine}\nAdded meanwhile.\n\n### Claude — `)).toBe(true)
  })
})
