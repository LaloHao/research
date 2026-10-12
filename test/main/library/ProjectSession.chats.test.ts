import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import type { ChatStreamUpdate } from '../../../src/shared/chat'
import { routeFetch } from '../../helpers/fakeFetch'
import { chatAnswer, FakeLlmProvider, type ChatResponse } from '../../helpers/llm'
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
})
