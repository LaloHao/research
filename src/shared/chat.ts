import { z } from 'zod'
import { LLM_MODELS, type LlmModel } from './summary'

/** `<UTC yyyymmdd>-<hhmmss>-<4 hex>`, plus `-<6 hex>` for each copy the git sync split off. */
export const CHAT_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}(?:-[0-9a-f]{6}){0,8}$/
export const MAX_CHAT_TITLE = 120
export const MAX_CHAT_MESSAGE = 20_000
/** Longest excerpt quoted from a selection (a citation marker's quote has the same limit). */
export const MAX_EXCERPT = 1000

const paperKey = z.string().regex(/^[a-z][a-z0-9]*$/)

/** The whole library, or one paper (its «Chat» tab); Claude may search the whole library in both. */
export const ChatScopeSchema = z.union([z.literal('library'), z.strictObject({ paper: paperKey })])
export type ChatScope = z.infer<typeof ChatScopeSchema>

/** Frontmatter of chats/<id>.md. Loose: keys added by a later version survive a round trip and the sync's merge. */
export const ChatMetaSchema = z.looseObject({
  schema_version: z.literal(1),
  id: z.string().regex(CHAT_ID),
  title: z.string().min(1).max(MAX_CHAT_TITLE),
  scope: ChatScopeSchema,
  /** The model for the next answers; each answer's heading records the model that actually answered. */
  model: z.enum(LLM_MODELS),
  created_at: z.string(),
  updated_at: z.string(),
  archived: z.boolean().default(false),
  /** Sum of the answers' costs (recomputed on every write). */
  cost_usd: z.number().min(0).default(0),
  /** The machine that wrote the file last; names the copy when the sync has to split the conversation. */
  updated_on: z.string().optional(),
  /** Only on a conversation the sync split off: the original's id and the machine this version came from. */
  copy_of: z.object({ id: z.string().regex(CHAT_ID), machine: z.string().nullable() }).optional()
})
export type ChatMeta = z.infer<typeof ChatMetaSchema>

/** A selection quoted with its paper and page («Preguntar a Claude»). */
export interface ChatExcerpt {
  paper: string
  /** 1-based page; null for text without pages (web content). */
  page: number | null
  quote: string
}

export interface UserMessage {
  role: 'user'
  at: string
  text: string
  excerpt: ChatExcerpt | null
}

export interface AssistantMessage {
  role: 'assistant'
  at: string
  /** The model id that answered (from the CLI's usage), not the alias. */
  model: string
  costUsd: number
  /** «Detener»: the text is what had arrived when the user stopped it. */
  stopped: boolean
  /** Markdown with citation markers. */
  text: string
}

export type ChatMessage = UserMessage | AssistantMessage

export interface ChatFile {
  meta: ChatMeta
  messages: ChatMessage[]
}

/** How a citation checked against the cited paper's text; each has a text under `chat.citation.<state>`. */
export const CITATION_STATES = ['found', 'not_found', 'paper_in_trash', 'unknown_paper'] as const
export type CitationState = (typeof CITATION_STATES)[number]

export interface ChatCitation {
  paper: string
  /** Corrected to where the quote was found, when it was found on another page. */
  page: number | null
  quote: string
  state: CitationState
}

export const PAPER_STATES = ['library', 'trash', 'missing'] as const
export type PaperState = (typeof PAPER_STATES)[number]

export interface ChatSummary {
  id: string
  title: string
  scope: ChatScope
  /** The scope paper's title while it is in the library. */
  paperTitle: string | null
  /** Where the scope paper is; null for a library chat. */
  paperState: PaperState | null
  archived: boolean
  model: LlmModel
  updatedAt: string
  costUsd: number
  messages: number
  /** A copy the sync split off, and the machine its version came from («(copia de <equipo>)»). */
  copyOf: { machine: string | null } | null
  /** The file cannot be read (git conflict markers, invalid frontmatter): it can only be deleted or fixed by hand. */
  problem: boolean
}

export type AssistantView = AssistantMessage & { citations: ChatCitation[]; unverified: number }
export type ChatMessageView = UserMessage | AssistantView

/** The answer being written right now; `seq` orders it against the stream updates. */
export interface ChatPartial {
  text: string
  tools: number
  seq: number
}

export interface ChatConversation {
  summary: ChatSummary
  messages: ChatMessageView[]
  partial: ChatPartial | null
  /** The last message is an unanswered question (a failed or interrupted answer) and nothing is running. */
  canRetry: boolean
}

export interface ChatListQuery {
  /** Words in the title or the messages (case, accents and whitespace ignored). */
  text?: string
  /** Only the conversations of this paper. */
  paper?: string
}

/** A message to send; `chatId: null` creates the conversation with it. */
export interface ChatSendRequest {
  chatId: string | null
  scope: ChatScope
  model: LlmModel
  text: string
  excerpt: ChatExcerpt | null
}

export type ChatStreamEvent =
  | { kind: 'start' }
  | { kind: 'delta'; text: string }
  /** A new turn of the model (after a tool call): the visible text starts over. */
  | { kind: 'turn' }
  | { kind: 'tool'; name: string }
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'error'; error: string }

/** Pushed on CHAT_STREAM_CHANNEL; `seq` grows across every answer of the session. */
export type ChatStreamUpdate = ChatStreamEvent & { chatId: string; seq: number }

export const CHAT_STREAM_CHANNEL = 'chat:stream'
