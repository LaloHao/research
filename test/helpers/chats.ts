import type { AssistantMessage, ChatFile, ChatMessage, ChatMeta, UserMessage } from '../../src/shared/chat'

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
