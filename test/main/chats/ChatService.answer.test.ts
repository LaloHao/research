import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { CHAT_AT, CHAT_ID_A, DEVICE, DRAIN_ANSWER, setupChats, userMessage, waitFor } from '../../helpers/chats'
import { chatAnswer } from '../../helpers/llm'
import { callTools } from '../../helpers/mcp'
import { DRAIN_ID } from '../../helpers/pair'
import { answerModel } from '../../../src/main/chats/ChatService'

const ask = (text: string, chatId: string | null = null) => ({ chatId, scope: 'library' as const, model: 'sonnet' as const, text, excerpt: null })

describe('ChatService answers', () => {
  it('creates the conversation with the question, streams the answer through the read-only tools and writes it with its cost', async () => {
    const { store, chats, provider, updates } = await setupChats({
      responses: [
        async (req, emit) => {
          const [hit] = await callTools(req.servers[0], [{ name: 'find_in_paper', arguments: { paper_id: DRAIN_ID, text: 'log messages' } }])
          expect(hit.text.startsWith('<library_data>')).toBe(true)
          emit({ kind: 'turn' })
          emit({ kind: 'tool', name: 'find_in_paper' })
          emit({ kind: 'turn' })
          emit({ kind: 'delta', text: 'Drain parses ' })
          emit({ kind: 'delta', text: 'logs.' })
          return chatAnswer(DRAIN_ANSWER, 0.03)
        }
      ]
    })
    const id = await chats.send({ ...ask('What does Drain do?'), model: 'haiku' })
    expect(id).toBe(CHAT_ID_A)
    await chats.idle()
    expect(updates.map((u) => u.kind)).toEqual(['start', 'turn', 'tool', 'turn', 'delta', 'delta', 'done'])
    expect(updates.map((u) => u.seq - updates[0].seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(updates.every((u) => u.chatId === CHAT_ID_A)).toBe(true)
    expect(await store.readChat(CHAT_ID_A)).toMatchObject({
      ok: true,
      value: {
        meta: { title: 'What does Drain do?', scope: 'library', model: 'haiku', cost_usd: 0.03, updated_on: 'laptop' },
        messages: [
          { role: 'user', text: 'What does Drain do?', excerpt: null },
          { role: 'assistant', model: 'claude-sonnet-5', costUsd: 0.03, stopped: false, text: DRAIN_ANSWER }
        ]
      }
    })
    expect(provider.chatCalls[0]).toMatchObject({ model: 'haiku', maxUsd: 0.5, maxTurns: 15, timeoutMs: 600000, servers: [{ name: 'library' }] })
    expect(provider.chatCalls[0].input.endsWith('<question>\nWhat does Drain do?\n</question>')).toBe(true)
    expect(await store.readCosts()).toEqual([expect.objectContaining({ paper_id: '', operation: 'chat', cost_usd: 0.03, model: 'claude-sonnet-5' })])
    expect((await chats.open(id)).messages[1]).toMatchObject({ unverified: 0 })
  })

  it('sends the paper, the earlier messages and the excerpt in a paper chat, and charges that paper', async () => {
    const { store, chats, provider } = await setupChats()
    const id = await chats.send({ ...ask('Summarize it'), scope: { paper: DRAIN_ID } })
    await chats.idle()
    await chats.send({ ...ask('Why a tree?', id), scope: { paper: DRAIN_ID }, excerpt: { paper: DRAIN_ID, page: 1, quote: 'fixed depth parse tree' } })
    await chats.idle()
    const req = provider.chatCalls[1]
    expect(req.system).toContain('the paper he2017drain')
    expect(req.input).toContain('<paper>\nkey: he2017drain\ntitle: Drain: An Online Log Parsing Approach with Fixed Depth Tree\nauthors: Pinjia He, Jieming Zhu')
    expect(req.input).toContain('<conversation>\n<turn role="user">\nSummarize it\n</turn>\n<turn role="assistant">\n')
    expect(req.input).toContain('<excerpt paper="he2017drain" page="1">\nfixed depth parse tree\n</excerpt>')
    expect(await store.readChat(id)).toMatchObject({
      ok: true,
      value: { messages: [{}, {}, { role: 'user', excerpt: { paper: DRAIN_ID, page: 1, quote: 'fixed depth parse tree' } }, { role: 'assistant' }] }
    })
    expect((await store.readCosts()).map((c) => c.paper_id)).toEqual([DRAIN_ID, DRAIN_ID])
    await expect(chats.send({ ...ask('Q'), scope: { paper: 'gone2020x' } })).rejects.toMatchObject({ code: 'paper_not_in_library' })
  })

  it("a conversation from the editor reads its passage in every answer; a question from the Chat view is an opinion", async () => {
    const { store, chats, provider } = await setupChats({ responses: [chatAnswer('Comments.'), chatAnswer('More.')] })
    const writing = { source: 'emacs' as const, file: 'ch2.org', section: '', scope: 'file' as const, mode: 'rewrite' as const, passage: 'My </passage> text.' }
    const id = await chats.send({ ...ask('Rewrite it'), writing, mode: 'rewrite' })
    await chats.idle()
    expect(provider.chatCalls[0].system).toContain('```proposal')
    expect(provider.chatCalls[0].input).toContain('section: none')
    expect(provider.chatCalls[0].input).toContain('My \\u003c/passage> text.')
    // The window sends no mode: the question is an opinion, and the conversation says so.
    await chats.send(ask('And now?', id))
    await chats.idle()
    expect(provider.chatCalls[1].system).toContain('Do NOT rewrite the passage')
    expect(provider.chatCalls[1].input).toContain('<passage>')
    expect(await chats.open(id)).toMatchObject({ summary: { writing: { mode: 'opinion', file: 'ch2.org' } }, writing: { passage: 'My </passage> text.' } })
    expect(chats.outcome(id)).toEqual({ kind: 'done' })
    // A passage only starts a library conversation.
    await expect(chats.send({ ...ask('Q', id), writing })).rejects.toMatchObject({ code: 'invalid_edit' })
    expect((await store.readChat(id))?.ok).toBe(true)
  })

  it('keeps a writing conversation\'s background in memory for its answers; never for a plain chat', async () => {
    const { chats, provider } = await setupChats({ responses: [chatAnswer('A.'), chatAnswer('B.')] })
    const writing = { source: 'emacs' as const, file: 'ch2.org', section: '', scope: 'paragraph' as const, mode: 'opinion' as const, passage: 'My text.' }
    const id = await chats.send({ ...ask('Q'), writing, context: { chapter: 'The chapter.', chapterCut: false, outline: '* Heading' } })
    await chats.idle()
    expect(provider.chatCalls[0].input).toContain('</passage>\n<chapter>\nThe chapter.\n</chapter>\n<outline>\n* Heading\n</outline>')
    // A question from the Chat view sends none: the kept background still goes.
    await chats.send(ask('Again?', id))
    await chats.idle()
    expect(provider.chatCalls[1].input).toContain('<chapter>\nThe chapter.\n</chapter>')
    await expect(chats.send({ ...ask('Plain'), context: { outline: '* H' } })).rejects.toMatchObject({ code: 'invalid_edit' })
  })

  it('refuses over the monthly cap before writing anything', async () => {
    const { store, chats, provider } = await setupChats()
    await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_month_usd: 1 } } })
    await store.appendCost(DEVICE, { at: CHAT_AT, paper_id: 'x', batch_id: null, model: 'm', cost_usd: 1, operation: 'summarize' })
    await expect(chats.send(ask('Q'))).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(await store.listChatIds()).toEqual([])
    expect(provider.chatCalls).toHaveLength(0)
  })

  it('answers one message at a time per conversation, and never deletes one that is answering', async () => {
    let release!: () => void
    const { chats, provider } = await setupChats({ responses: [() => new Promise((resolve) => (release = () => resolve(chatAnswer('ok'))))] })
    const id = await chats.send(ask('Q'))
    await expect(chats.send(ask('Again', id))).rejects.toMatchObject({ code: 'chat_busy' })
    await expect(chats.remove(id, true)).rejects.toMatchObject({ code: 'chat_busy' })
    await expect(chats.retry(id)).rejects.toMatchObject({ code: 'chat_busy' })
    await waitFor(() => provider.chatCalls.length > 0)
    release()
    await chats.idle()
    expect((await chats.open(id)).messages).toHaveLength(2)
  })

  it('leaves the question unanswered on an error, charges what it cost, and answers it on «Reintentar»', async () => {
    const { store, chats, updates } = await setupChats({ responses: [new LlmError('llm_timeout', 0.5, { estimated: true }), chatAnswer('Second try.')] })
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect(updates.at(-1)).toMatchObject({ kind: 'error', error: 'llm_timeout' })
    expect(await chats.open(id)).toMatchObject({ canRetry: true, messages: [{ role: 'user' }] })
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'chat', cost_usd: 0.5, estimated: true })])
    await chats.retry(id)
    await chats.idle()
    expect(await chats.open(id)).toMatchObject({ canRetry: false, messages: [{ role: 'user' }, { role: 'assistant', text: 'Second try.' }] })
    await expect(chats.retry(id)).rejects.toMatchObject({ code: 'invalid_edit' })
  })

  it('an answer stopped at its per-message cap says so, naming the chat cap rather than the per-paper one', async () => {
    const { store, chats, updates } = await setupChats({ responses: [new LlmError('operation_budget', 0.5)] })
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect(updates.at(-1)).toMatchObject({ kind: 'error', error: 'chat_message_budget' })
    expect(await chats.open(id)).toMatchObject({ canRetry: true, messages: [{ role: 'user' }] })
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'chat', cost_usd: 0.5 })])
  })

  it('«Detener» keeps what arrived as a stopped answer, charged at its cap as an estimate', async () => {
    const { store, chats, updates } = await setupChats({
      responses: [
        (req, emit) =>
          new Promise((_resolve, reject) => {
            emit({ kind: 'turn' })
            emit({ kind: 'delta', text: 'Partial answer' })
            req.signal!.addEventListener('abort', () => reject(Object.assign(new DOMException('aborted', 'AbortError'), { costUsd: req.maxUsd, estimated: true })))
          })
      ]
    })
    const id = await chats.send(ask('Q'))
    await waitFor(() => updates.some((u) => u.kind === 'delta'))
    expect((await chats.open(id)).partial).toMatchObject({ text: 'Partial answer', tools: 0, seq: updates.at(-1)?.seq })
    chats.stop(id)
    await chats.idle()
    expect(updates.at(-1)).toMatchObject({ kind: 'stopped' })
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', stopped: true, text: 'Partial answer', costUsd: 0.5 })
    expect(await store.readCosts()).toEqual([expect.objectContaining({ cost_usd: 0.5, estimated: true })])
  })

  it('stops running answers when the project closes, saving them as stopped', async () => {
    const { chats } = await setupChats({
      responses: [
        (req) =>
          new Promise((_resolve, reject) => {
            const stop = (): void => reject(new DOMException('aborted', 'AbortError'))
            if (req.signal!.aborted) stop()
            else req.signal!.addEventListener('abort', stop)
          })
      ]
    })
    const id = await chats.send(ask('Q'))
    await chats.close()
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', stopped: true, text: '', costUsd: 0 })
  })

  it('writes a model id the heading can hold, whatever the CLI reports', async () => {
    expect(answerModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(answerModel(' claude sonnet 5 ')).toBe('claude-sonnet-5')
    expect(answerModel('$x')).toBe('x')
    expect(answerModel('')).toBe('unknown')
    expect(answerModel('detenida')).toBe('unknown')
    const { chats, store } = await setupChats({ responses: [chatAnswer('ok', 0.01, 'odd model')] })
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect((await chats.open(id)).messages[1]).toMatchObject({ model: 'odd-model' })
    expect(await store.readCosts()).toEqual([expect.objectContaining({ model: 'odd-model' })])
  })

  it('a refused follow-up writes nothing to the conversation', async () => {
    const { store, chats } = await setupChats()
    const id = await chats.send(ask('Q'))
    await chats.idle()
    await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_month_usd: 0.02 } } })
    await expect(chats.send(ask('Again', id))).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect((await chats.open(id)).messages).toHaveLength(2)
  })

  it('waits for a send in progress when closing, stops its answer, and starts nothing after', async () => {
    // The answer hangs until it is aborted, wherever the close catches it.
    const hang = (req: { signal?: AbortSignal }): Promise<never> =>
      new Promise((_resolve, reject) => {
        const stop = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (req.signal!.aborted) stop()
        else req.signal!.addEventListener('abort', stop)
      })
    const { chats, provider } = await setupChats({ responses: [hang] })
    const sending = chats.send(ask('Q'))
    await chats.close()
    const id = await sending
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', stopped: true })
    await expect(chats.send(ask('Again', id))).rejects.toMatchObject({ code: 'chat_busy' })
    expect(provider.chatCalls.length).toBeLessThanOrEqual(1)
  })

  it('writes the answer even when the cost ledger cannot be written', async () => {
    const { chats, ledger, updates } = await setupChats()
    const append = vi.spyOn(ledger, 'append').mockRejectedValue(new Error('disk full'))
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect(append).toHaveBeenCalledOnce()
    expect(updates.at(-1)).toMatchObject({ kind: 'done' })
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', text: DRAIN_ANSWER })
  })

  it('appends the answer after a message written by someone else while it was running', async () => {
    const { store, chats } = await setupChats({
      responses: [
        async () => {
          const read = await store.readChat(CHAT_ID_A)
          if (!read?.ok) throw new Error('unreadable')
          await store.writeChat({ ...read.value, messages: [...read.value.messages, userMessage({ text: 'Meanwhile' })] }, read.hash)
          return chatAnswer('Answer.')
        }
      ]
    })
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect((await chats.open(id)).messages.map((m) => [m.role, m.role === 'action' ? '' : m.text])).toEqual([
      ['user', 'Q'],
      ['user', 'Meanwhile'],
      ['assistant', 'Answer.']
    ])
  })

  it('a failing stream sink never fails the answer', async () => {
    const { chats } = await setupChats({
      stream: () => {
        throw new Error('window gone')
      }
    })
    // A rejected answer would surface as an unhandled rejection and fail the run.
    const id = await chats.send(ask('Q'))
    await chats.idle()
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', text: DRAIN_ANSWER })
  })

  it('answers without the paper when reading it fails', async () => {
    const { store, chats, provider } = await setupChats()
    vi.spyOn(store, 'readPaper').mockRejectedValue(new Error('invalid paper.yaml'))
    const id = await chats.send({ ...ask('Q'), scope: { paper: DRAIN_ID } })
    await chats.idle()
    expect(provider.chatCalls[0].input).toContain('its text is not available')
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'assistant', text: DRAIN_ANSWER })
  })

  it('a new conversation keeps the switches of its first message; both are off by default', async () => {
    const { chats } = await setupChats()
    const off = await chats.send(ask('Q'))
    await chats.idle()
    const on = await chats.send({ ...ask('Q2'), actions: true, sync: true })
    await chats.idle()
    expect((await chats.open(off)).summary).toMatchObject({ actions: false, sync: false })
    expect(await chats.open(on)).toMatchObject({ summary: { actions: true, sync: true }, approvals: [] })
    // Only the first message sets them; later ones go through setTools.
    await chats.send({ ...ask('Q3', off), actions: true })
    await chats.idle()
    expect((await chats.open(off)).summary.actions).toBe(false)
  })
})
