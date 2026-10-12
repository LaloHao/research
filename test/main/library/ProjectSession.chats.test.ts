import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import type { ActionView, ChatStreamUpdate } from '../../../src/shared/chat'
import { routeFetch } from '../../helpers/fakeFetch'
import { chatAnswer, FakeLlmProvider, type ChatResponse } from '../../helpers/llm'
import { callTools, type ToolOutcome } from '../../helpers/mcp'
import { seedPair } from '../../helpers/pair'
import { tmpDir } from '../../helpers/tmp'

const base = { contactEmail: '', watch: false, citationPauseMs: 0, fetch: routeFetch([]), machineName: 'desk\ntop' }

/** Streams one turn with `Half`, then waits until it is stopped. */
const hanging: ChatResponse = (req, emit) =>
  new Promise((_resolve, reject) => {
    emit({ kind: 'turn' })
    emit({ kind: 'delta', text: 'Half' })
    const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
    if (req.signal!.aborted) abort()
    else req.signal!.addEventListener('abort', abort)
  })

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ProjectSession chats', () => {
  it('forwards an answer as it streams, and closing the project saves it as stopped', async () => {
    const llm = new FakeLlmProvider([], [], [hanging])
    const root = await tmpDir()
    const s = await ProjectSession.create(root, 'Thesis', { ...base, llm })
    const updates: ChatStreamUpdate[] = []
    s.onChatStream((u) => updates.push(u))
    const id = await s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null })
    await until(() => updates.some((u) => u.kind === 'delta'), 'a delta')
    await s.close()
    expect(updates.map((u) => u.kind)).toEqual(['start', 'turn', 'delta', 'stopped'])
    expect(updates.every((u) => u.chatId === id)).toBe(true)
    // Sequence numbers grow, so the window can order them against an open() snapshot.
    expect(updates.map((u) => u.seq)).toEqual([...updates.map((u) => u.seq)].sort((a, b) => a - b))
    const read = await (await ProjectStore.open(root)).readChat(id)
    expect(read).toMatchObject({ ok: true, value: { meta: { updated_on: 'desk top' }, messages: [{ role: 'user' }, { role: 'assistant', stopped: true, text: 'Half' }] } })
  })

  it('tells its listeners when a conversation is written, and a failing stream listener does not lose the answer', async () => {
    const llm = new FakeLlmProvider([], [], [chatAnswer('Hello there.')])
    const root = await tmpDir()
    const s = await ProjectSession.create(root, 'Thesis', { ...base, llm })
    let changed = 0
    s.on('chats', () => changed++)
    const seen: string[] = []
    s.onChatStream(() => {
      throw new Error('window gone')
    })
    const off = s.onChatStream((u) => seen.push(u.kind))
    const id = await s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null })
    await s.chats.idle()
    expect(changed).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe('done')
    off()
    const read = await s.store.readChat(id)
    expect(read).toMatchObject({ ok: true, value: { messages: [{ role: 'user' }, { role: 'assistant', stopped: false, text: 'Hello there.' }] } })
    await s.close()
  })

  it('reserves 0.1 for each answer while it runs (the initial chat estimate)', async () => {
    const llm = new FakeLlmProvider([], [], [hanging])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    const { llm: cfg } = s.store.config
    await s.store.updateConfig({ llm: { ...cfg, budget: { ...cfg.budget, per_month_usd: 0.2 } } })
    const send = () => s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null })
    // 0.1 + 0.1 fits a monthly cap of 0.2; a third answer at once would not (with 0.05 it would, with 0.25 the second would not).
    await send()
    await send()
    await expect(send()).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(llm.chatCalls[0]!.maxUsd).toBe(0.5)
    await s.close()
  })

  it("runs a conversation's actions through the session's own services, and undoes them", async () => {
    const llm = new FakeLlmProvider([], [], [
      async (req) => {
        const actions = req.servers.find((s) => s.name === 'actions')!
        const [trash, note] = await callTools(actions, [
          { name: 'list_trash', arguments: {} },
          { name: 'write_note', arguments: { paper_id: 'he2017drain', text: 'Parses online.', request_quote: 'add a note to Drain' } }
        ])
        expect(trash!.text).toContain('<library_data>')
        expect(trash!.text).toContain('"total":0')
        expect(note!.text).toContain('"status":"done"')
        return chatAnswer('Done.')
      }
    ])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    await seedPair(s.store, s.cache)
    const id = await s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Please add a note to Drain.', excerpt: null, actions: true })
    await s.chats.idle()
    expect(llm.chatCalls[0]!.servers.map((x) => x.name)).toEqual(['library', 'actions'])
    expect((await s.store.readNotes('he2017drain')).text).toContain('Parses online.')
    const opened = await s.chats.open(id)
    const action = opened.messages[1] as ActionView
    expect(action).toMatchObject({ role: 'action', tool: 'write_note', state: 'executed', approval: 'request', undoable: true })
    await s.chats.undo(id, action.id)
    expect((await s.store.readNotes('he2017drain')).text).toBe('')
    await expect(s.chats.undo(id, action.id)).rejects.toMatchObject({ code: 'undo_unavailable' })
    await s.close()
  })

  it('offers no actions server to a conversation whose switches are off', async () => {
    const llm = new FakeLlmProvider([], [], [chatAnswer('Hi.')])
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, llm })
    await s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Hi', excerpt: null })
    await s.chats.idle()
    expect(llm.chatCalls[0]!.servers.map((x) => x.name)).toEqual(['library'])
    await s.close()
  })

  it('closing the project denies a waiting approval and stops cleanly, leaving the papers where they were', async () => {
    let outcome: ToolOutcome | undefined
    const llm = new FakeLlmProvider([], [], [
      async (req) => {
        const actions = req.servers.find((x) => x.name === 'actions')!
        ;[outcome] = await callTools(actions, [{ name: 'trash_papers', arguments: { paper_ids: ['he2017drain'], request_quote: 'move Drain to the trash' } }])
        return chatAnswer('Asked.')
      }
    ])
    const root = await tmpDir()
    const s = await ProjectSession.create(root, 'Thesis', { ...base, llm })
    await seedPair(s.store, s.cache)
    const kinds: string[] = []
    s.onChatStream((u) => kinds.push(u.kind))
    const id = await s.chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Please move Drain to the trash.', excerpt: null, actions: true })
    // Removing always asks: the call waits for the user.
    await until(() => kinds.includes('approvals'), 'the approval')
    expect((await s.chats.open(id)).approvals).toMatchObject([{ tool: 'trash_papers', pickPdf: false }])
    await s.close()
    expect(outcome!.text).toContain('"status":"denied"')
    expect(outcome!.text).toContain('"reason":"stopped"')
    expect(s.store.trashExists('he2017drain')).toBe(false)
    const read = await (await ProjectStore.open(root)).readChat(id)
    expect(read).toMatchObject({ ok: true, value: { messages: [{ role: 'user' }, { role: 'action', tool: 'trash_papers', state: 'denied', approval: null }, { role: 'assistant' }] } })
  })
})
