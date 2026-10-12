import { join } from 'node:path'
import { IndexCache } from '../../src/main/cache/IndexCache'
import { ChatService } from '../../src/main/chats/ChatService'
import { BudgetGuard, limitsFromConfig } from '../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../src/main/llm/CostLedger'
import { MapService } from '../../src/main/map/MapService'
import { startLibraryMcpServer } from '../../src/main/mcp/LibraryMcpServer'
import { libraryTools } from '../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../src/main/project/ProjectStore'
import type { AssistantMessage, ChatFile, ChatMessage, ChatMeta, ChatStreamUpdate, UserMessage } from '../../src/shared/chat'
import { chatAnswer, FakeLlmProvider, type ChatResponse } from './llm'
import { seedPair } from './pair'
import { tmpDir } from './tmp'

export const CHAT_AT = '2026-10-11T12:00:00.000Z'
export const CHAT_ID_A = '20261011-120000-a1b2'
export const DRAIN_QUOTE = 'Drain parses log messages online'
export const DRAIN_ANSWER = `Drain parses logs online [[he2017drain|p. 1|"${DRAIN_QUOTE}"]].`

export function chatMeta(over: Partial<ChatMeta> = {}): ChatMeta {
  return {
    schema_version: 1,
    id: CHAT_ID_A,
    title: 'What does Drain do?',
    scope: 'library',
    model: 'sonnet',
    created_at: CHAT_AT,
    updated_at: CHAT_AT,
    archived: false,
    cost_usd: 0,
    actions: false,
    sync: false,
    updated_on: 'laptop',
    ...over
  }
}

export function userMessage(over: Partial<UserMessage> = {}): UserMessage {
  return { role: 'user', at: CHAT_AT, text: 'What does Drain do?', excerpt: null, ...over }
}

export function assistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: 'assistant', at: '2026-10-11T12:00:05.000Z', model: 'claude-sonnet-5', costUsd: 0.02, stopped: false, text: DRAIN_ANSWER, ...over }
}

/** A conversation whose `cost_usd` adds up its answers, as the app writes it. */
export function chatFile(messages: ChatMessage[] = [userMessage(), assistantMessage()], over: Partial<ChatMeta> = {}): ChatFile {
  const cost = Math.round(messages.reduce((sum, m) => sum + (m.role === 'assistant' ? m.costUsd : 0), 0) * 10000) / 10000
  return { meta: chatMeta({ cost_usd: cost, ...over }), messages }
}

export const DEVICE = '11111111-1111-1111-1111-111111111111'

export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Drain and Loghub in the library, a chat service with a fixed clock, and the fake provider answering DRAIN_ANSWER. */
export async function setupChats(opts: { responses?: ChatResponse[]; stream?: (u: ChatStreamUpdate) => void } = {}) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const provider = new FakeLlmProvider([], [], opts.responses ?? [chatAnswer(DRAIN_ANSWER)])
  const ledger = new CostLedger(store, DEVICE, () => new Date(CHAT_AT))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal(), 0.05, { chat: 0.1 })
  const updates: ChatStreamUpdate[] = []
  const counter = { events: 0 }
  const hex = ['a1b2', 'c3d4', 'e5f6', '0a0b']
  let n = 0
  const chats = new ChatService({
    store,
    cache,
    provider,
    budget,
    ledger,
    machine: 'laptop',
    startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }), o),
    emit: () => counter.events++,
    stream: (u) => {
      updates.push(u)
      opts.stream?.(u)
    },
    now: () => new Date(CHAT_AT),
    randomHex: () => hex[n++ % hex.length]
  })
  return { store, cache, provider, ledger, budget, chats, updates, counter }
}
