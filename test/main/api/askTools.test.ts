import { afterEach, describe, expect, it } from 'vitest'
import { startLocalApiServer, type LocalApiServerHandle } from '../../../src/main/api/LocalApiServer'
import type { ApiContext } from '../../../src/main/api/registry'
import { limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { MapService } from '../../../src/main/map/MapService'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { WritingService } from '../../../src/main/writing/WritingService'
import { CHAT_ID_A, DRAIN_ANSWER, setupChats, waitFor } from '../../helpers/chats'
import { chatAnswer, type ChatResponse } from '../../helpers/llm'
import { sampleThesis } from '../../helpers/summaries'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
const PASSAGE = 'Drain parses logs online [cite:@he2017drain]. It is therefore the best parser.'

async function project(responses: ChatResponse[]) {
  const setup = await setupChats({ responses })
  const { store, cache, chats, ledger, budget } = setup
  await store.updateConfig({ thesis: sampleThesis })
  const limits = () => limitsFromConfig(store.config.llm)
  const openedChats: string[] = []
  const ctx: ApiContext = {
    store,
    cache,
    library: libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }),
    writing: new WritingService({ store, cache, includedPapers: () => [] }),
    drafts: {} as ApiContext['drafts'],
    capped: { budget, ledger, limits },
    chats,
    openInApp: () => undefined,
    openChatInApp: (id) => void openedChats.push(id)
  }
  return { ...setup, ctx, openedChats }
}

const servers: LocalApiServerHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(ctx: ApiContext): Promise<LocalApiServerHandle> {
  const server = await startLocalApiServer({ port: 0, token: () => TOKEN, context: () => ctx, allowCostly: () => true })
  servers.push(server)
  return server
}

async function call(server: LocalApiServerHandle, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { isError: json.result.isError === true, text: json.result.content.map((c) => c.text).join('') }
}
const ok = async (server: LocalApiServerHandle, name: string, args: Record<string, unknown>): Promise<any> => {
  const out = await call(server, name, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

const START = { question: '¿Se sostiene el argumento?', text: PASSAGE, file: '/home/me/thesis/chapter2.org', section: 'Estado del arte › Parsers', scope: 'paragraph' }

describe('local API: ask (Claude’s opinion on a passage)', () => {
  it('answers the plan, starts a chat conversation with the passage, and ask_status gives the answer as Org with checked citations', async () => {
    const { store, provider, chats, ctx } = await project([chatAnswer(`Good claim, but «the best» needs support. ${DRAIN_ANSWER}`, 0.04)])
    const server = await serve(ctx)
    const plan = await ok(server, 'ask', START)
    expect(plan).toMatchObject({
      confirmation_required: true,
      operation: 'chat',
      model: 'sonnet',
      cap_usd: 0.5,
      conversation_id: null,
      mode: 'opinion',
      chars: [...PASSAGE].length,
      file: 'chapter2.org',
      section: 'Estado del arte › Parsers'
    })
    expect(provider.chatCalls).toHaveLength(0)

    const started = await ok(server, 'ask', { ...START, confirmed: true })
    expect(started).toEqual({ conversation_id: CHAT_ID_A, status: 'running', costUsd: 0, model: 'sonnet' })
    await chats.idle()

    const req = provider.chatCalls[0]
    expect(req.system).toContain('you do not write it for them')
    expect(req.system).toContain('Do NOT rewrite the passage')
    expect(req.system).not.toContain('```proposal')
    expect(req.input).toContain('<location>\nfile: chapter2.org\nsection: Estado del arte › Parsers\nscope: paragraph\n</location>\n<passage>\n' + PASSAGE + '\n</passage>')
    expect(req.input).toContain('Research questions:')
    expect(req.input.endsWith('<question>\n¿Se sostiene el argumento?\n</question>')).toBe(true)

    const status = await ok(server, 'ask_status', { conversation_id: CHAT_ID_A })
    expect(status).toMatchObject({
      status: 'done',
      title: '¿Se sostiene el argumento?',
      file: 'chapter2.org',
      section: 'Estado del arte › Parsers',
      mode: 'opinion',
      text: 'Good claim, but «the best» needs support. Drain parses logs online [he2017drain, p. 1].',
      unverified: 0,
      costUsd: 0.04,
      model: 'claude-sonnet-5'
    })
    expect(status.citations).toEqual([
      { start: 67, end: 86, key: 'he2017drain', page: 1, quote: 'Drain parses log messages online', state: 'found', verified: true }
    ])
    // A normal conversation of the Chat view, the passage in its frontmatter.
    expect(chats.list()[0]).toMatchObject({ id: CHAT_ID_A, title: '¿Se sostiene el argumento?', writing: { source: 'emacs', file: 'chapter2.org', mode: 'opinion' } })
    expect(await store.readChat(CHAT_ID_A)).toMatchObject({ ok: true, value: { meta: { writing: { passage: PASSAGE, scope: 'paragraph' } } } })
    expect((await store.readCosts()).map((c) => [c.operation, c.cost_usd])).toEqual([['chat', 0.04]])
  })

  it('a follow-up continues the conversation; a rewrite only when that question allows it', async () => {
    const { provider, chats, ctx } = await project([chatAnswer('First.'), chatAnswer('Second.'), chatAnswer('Third.')])
    const server = await serve(ctx)
    const { conversation_id: id } = await ok(server, 'ask', { ...START, confirmed: true })
    await chats.idle()
    const plan = await ok(server, 'ask', { question: 'Propón una versión', conversation_id: id, mode: 'rewrite' })
    expect(plan).toMatchObject({ conversation_id: id, answering: false, mode: 'rewrite', chars: null, file: 'chapter2.org' })
    await ok(server, 'ask', { question: 'Propón una versión', conversation_id: id, mode: 'rewrite', confirmed: true })
    await chats.idle()
    expect(provider.chatCalls[1].system).toContain('```proposal')
    expect(provider.chatCalls[1].input).toContain('<passage>')
    expect(provider.chatCalls[1].input).toContain('<turn role="assistant">\nFirst.\n</turn>')
    // The next question, without mode, is an opinion again.
    await ok(server, 'ask', { question: '¿Y la transición?', conversation_id: id, confirmed: true })
    await chats.idle()
    expect(provider.chatCalls[2].system).toContain('Do NOT rewrite the passage')
    expect(await ok(server, 'ask_status', { conversation_id: id })).toMatchObject({ status: 'done', text: 'Third.', mode: 'opinion' })
    expect((await chats.open(id)).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('refuses before spending: no passage, a passage in a follow-up, an unknown or non-editor conversation, a passage too long', async () => {
    const { provider, chats, ctx } = await project([chatAnswer('ok'), chatAnswer('ok')])
    const server = await serve(ctx)
    expect((await call(server, 'ask', { question: 'Q' })).text).toMatch(/^invalid: /)
    expect((await call(server, 'ask', { question: 'Q', conversation_id: '20200101-000000-ffff' })).text).toMatch(/^not_found: /)
    const library = await chats.send({ chatId: null, scope: 'library', model: 'sonnet', text: 'Plain chat', excerpt: null })
    await chats.idle()
    expect((await call(server, 'ask', { question: 'Q', conversation_id: library, confirmed: true })).text).toMatch(/^invalid: .*not started with ask/)
    expect((await call(server, 'ask', { question: 'Q', conversation_id: library, text: 'x' })).text).toMatch(/^invalid: /)
    expect((await call(server, 'ask', { question: 'Q', text: 'é'.repeat(30_001) })).isError).toBe(true)
    // 30 000 characters outside the BMP are 60 000 UTF-16 units: still accepted and written.
    await ok(server, 'ask', { question: 'Q', text: '😀'.repeat(30_000), confirmed: true })
    await chats.idle()
    expect(chats.list().find((c) => c.writing)?.writing).toMatchObject({ scope: 'region', file: '' })
    expect(provider.chatCalls).toHaveLength(2)
  })

  it('ask_status follows a running answer; ask_stop keeps what arrived as stopped; a second question meanwhile is busy', async () => {
    const slow: ChatResponse = (req, emit) =>
      new Promise((_resolve, reject) => {
        emit({ kind: 'turn' })
        emit({ kind: 'delta', text: '**Bien**: la idea [[he2017drain|p. 1|"Drain parses log messages online"]]' })
        req.signal!.addEventListener('abort', () => reject(Object.assign(new DOMException('aborted', 'AbortError'), { costUsd: 0.01 })))
      })
    const { chats, ctx } = await project([slow])
    const server = await serve(ctx)
    const { conversation_id: id } = await ok(server, 'ask', { ...START, confirmed: true })
    await waitFor(() => (chats.progress(id)?.text ?? '').length > 0)
    expect(await ok(server, 'ask_status', { conversation_id: id })).toEqual({
      conversation_id: id,
      status: 'running',
      text: '*Bien*: la idea [he2017drain, p. 1]',
      tools: 0
    })
    expect((await call(server, 'ask', { question: 'Otra', conversation_id: id, confirmed: true })).text).toMatch(/^busy: /)
    expect(await ok(server, 'ask', { question: 'Otra', conversation_id: id })).toMatchObject({ answering: true })
    expect(await ok(server, 'ask_stop', { conversation_id: id })).toEqual({ conversation_id: id, stopping: true })
    await chats.idle()
    const stopped = await ok(server, 'ask_status', { conversation_id: id })
    expect(stopped).toMatchObject({ status: 'stopped', text: '*Bien*: la idea [he2017drain, p. 1]', unverified: 0 })
    expect(await ok(server, 'ask_stop', { conversation_id: id })).toEqual({ conversation_id: id, stopping: false })
  })

  it('ask_status reports a failed answer by its code; open_chat_in_app opens a known conversation', async () => {
    const { chats, ctx, openedChats } = await project([new LlmError('llm_quota', 0)])
    const server = await serve(ctx)
    const { conversation_id: id } = await ok(server, 'ask', { ...START, confirmed: true })
    await chats.idle()
    expect(await ok(server, 'ask_status', { conversation_id: id })).toEqual({ conversation_id: id, status: 'error', error: 'llm_quota' })
    expect(await ok(server, 'open_chat_in_app', { conversation_id: id })).toEqual({ opened: true })
    expect(openedChats).toEqual([id])
    expect((await call(server, 'open_chat_in_app', { conversation_id: '20200101-000000-ffff' })).text).toMatch(/^not_found: /)
    expect((await call(server, 'ask_status', { conversation_id: '20200101-000000-ffff' })).text).toMatch(/^not_found: /)
  })
})
