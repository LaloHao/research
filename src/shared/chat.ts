import { z } from 'zod'
import { citationMarker, parseCitations } from './chatCitations'
import { ACTION_STATES, MAX_REQUEST_QUOTE, UNDO_TOOL, type ActionState, type PendingApproval } from './chatActions'
import { LLM_MODELS, type LlmModel } from './summary'

/** `<UTC yyyymmdd>-<hhmmss>-<4 hex>`, plus `-<6 hex>` for each copy the git sync split off. */
export const CHAT_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}(?:-[0-9a-f]{6}){0,8}$/
export const MAX_CHAT_TITLE = 120
export const MAX_CHAT_MESSAGE = 20_000
/** Longest excerpt quoted from a selection (a citation marker's quote has the same limit). */
export const MAX_EXCERPT = 1000

/** A paper's key (its folder under papers/ and its citation key). */
export const PAPER_KEY = /^[a-z][a-z0-9]*$/
const paperKey = z.string().regex(PAPER_KEY)

/** The whole library, or one paper (its «Chat» tab); Claude may search the whole library in both. */
export const ChatScopeSchema = z.union([z.literal('library'), z.strictObject({ paper: paperKey })])
export type ChatScope = z.infer<typeof ChatScopeSchema>

/**
 * «Preguntar a Claude» from the editor: what Claude says about a passage the user is writing. `opinion` (the default)
 * comments, critiques and asks without rewriting the passage; `rewrite` (only when the user explicitly allows it for a
 * question) may also propose a rewritten version, set apart as Claude's.
 */
export const WRITING_MODES = ['opinion', 'rewrite'] as const
export type WritingMode = (typeof WRITING_MODES)[number]
/** What the editor sent: the region, the paragraph at point, the Org subtree (a section or chapter) or the whole file. */
export const WRITING_SCOPES = ['region', 'paragraph', 'subtree', 'file'] as const
export type WritingScope = (typeof WRITING_SCOPES)[number]
export const MAX_WRITING_PASSAGE = 30_000
export const MAX_WRITING_FILE = 255
export const MAX_WRITING_SECTION = 500

/**
 * The passage of a conversation started from the editor, kept in its frontmatter: every answer of the conversation
 * (from the editor or the app's Chat view) reads it. `mode` is that of the latest question.
 */
export const ChatWritingSchema = z.looseObject({
  /** Where the question came from (only the editor, for now). */
  source: z.literal('emacs'),
  /** The file's name (no folder). */
  file: z.string().max(MAX_WRITING_FILE),
  /** Its heading path, `Chapter › Section`; '' outside any heading. */
  section: z.string().max(MAX_WRITING_SECTION),
  scope: z.enum(WRITING_SCOPES),
  mode: z.enum(WRITING_MODES),
  passage: z.string().min(1).max(MAX_WRITING_PASSAGE)
})
export type ChatWriting = z.infer<typeof ChatWritingSchema>
/** A writing conversation as the list shows it: where its passage is, without the passage. */
export type ChatWritingNote = Pick<ChatWriting, 'source' | 'file' | 'section' | 'scope' | 'mode'>

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
  /** «Acciones»: the actions server is offered to Claude in this conversation (off by default). */
  actions: z.boolean().default(false),
  /** «Sincronizar con git»: the sync tools are offered (off by default, independent of «Acciones»). */
  sync: z.boolean().default(false),
  /** The machine that wrote the file last; names the copy when the sync has to split the conversation. */
  updated_on: z.string().optional(),
  /** Only on a conversation the sync split off: the original's id and the machine this version came from. */
  copy_of: z.object({ id: z.string().regex(CHAT_ID), machine: z.string().nullable() }).optional(),
  /** Only on a conversation started from the editor: the passage it is about. */
  writing: ChatWritingSchema.optional()
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

/** An action's id in its conversation; «Deshacer» and the undo's record name it. */
export const ACTION_ID = /^[0-9a-f]{6}$/
/** A tool name as an action's heading holds it (a later version's tools read back as written). */
export const ACTION_TOOL_NAME = /^[a-z][a-z_]{0,39}$/

/** An action Claude asked for in this conversation: run, denied or failed (stage 4b). */
export interface ActionMessage {
  role: 'action'
  at: string
  id: string
  /** An action tool, or `undo` for the record of a «Deshacer». */
  tool: string
  state: ActionState
  /** `request`: the user's latest message asked for it (quoted in `request`); `user`: approved in the conversation; null: it did not run. */
  approval: 'request' | 'user' | null
  /** The words of the user's message the call quoted, when the app found them there. */
  request: string | null
  /** The tool's arguments, without the quote (and never a file path). */
  args: Record<string, unknown>
  /** What happened: paper keys, counts and outcome codes, `error`, `sync_error`, or the denial's `reason`. */
  result: Record<string, unknown>
}

export type ChatMessage = UserMessage | AssistantMessage | ActionMessage

/**
 * The excerpt as its citation marker reads back (whitespace collapsed, `"]]` and `[[` broken up), or null when the
 * marker would not read back at all (bad key or page, empty or too long a quote). Store excerpts in this form.
 */
export function normalizeExcerpt(e: ChatExcerpt): ChatExcerpt | null {
  const marker = citationMarker(e)
  const cited = parseCitations(marker)
  if (cited.length !== 1 || cited[0].start !== 0 || cited[0].end !== marker.length) return null
  return { paper: cited[0].paper, page: cited[0].page, quote: cited[0].quote }
}

/** A message's time in its heading: an ISO string, which never has whitespace. */
export const MESSAGE_AT = /^\S+$/
/**
 * A model id in an answer's heading: no whitespace (so no ` · `), not a cost (`$…`). The file writer also refuses the
 * heading's stopped mark (`STOPPED_MARK` in `chatFile.ts`) as a model id.
 */
export const MESSAGE_MODEL = /^[^\s$]\S*$/
/** Costs are written with 4 decimals; a billion dollars is far beyond any real answer. */
export const MAX_MESSAGE_COST = 1e9

const ExcerptSchema = z
  .object({ paper: z.string(), page: z.number().nullable(), quote: z.string() })
  .refine((e) => {
    const n = normalizeExcerpt(e)
    return n !== null && n.paper === e.paper && n.page === e.page && n.quote === e.quote
  }, 'The excerpt would not read back the same from its citation marker')

/**
 * A message the conversation file can write and read back unchanged (its text aside, which the format normalizes
 * with `cleanMessageText`). Every message is checked before a write: a bad heading field would merge or split messages.
 */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), at: z.string().regex(MESSAGE_AT), text: z.string(), excerpt: ExcerptSchema.nullable() }),
  z.object({
    role: z.literal('assistant'),
    at: z.string().regex(MESSAGE_AT),
    model: z.string().regex(MESSAGE_MODEL),
    costUsd: z.number().min(0).lt(MAX_MESSAGE_COST),
    stopped: z.boolean(),
    text: z.string()
  }),
  z.object({
    role: z.literal('action'),
    at: z.string().regex(MESSAGE_AT),
    id: z.string().regex(ACTION_ID),
    tool: z.string().regex(ACTION_TOOL_NAME),
    state: z.enum(ACTION_STATES),
    approval: z.enum(['request', 'user']).nullable(),
    request: z.string().max(MAX_REQUEST_QUOTE).nullable(),
    args: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown())
  })
])

export interface ChatFile {
  meta: ChatMeta
  messages: ChatMessage[]
}

/**
 * The question an answer is for: the last user message, when nothing but action records follow it (the actions an
 * answer ran before it failed or was retried). -1 when the last question already has an answer.
 */
export function questionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
    if (messages[i].role === 'assistant') return -1
  }
  return -1
}

/** The ids of the actions a «Deshacer» took back (only an undo that ran counts). */
export function undoneActions(messages: ChatMessage[]): Set<string> {
  return new Set(messages.flatMap((m) => (m.role === 'action' && m.tool === UNDO_TOOL && m.state === 'executed' && typeof m.args.action === 'string' ? [m.args.action] : [])))
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
  /** The conversation's switches. */
  actions: boolean
  sync: boolean
  model: LlmModel
  updatedAt: string
  costUsd: number
  /** Questions and answers (action records are not counted). */
  messages: number
  /** A copy the sync split off, and the machine its version came from («(copia de <equipo>)»). */
  copyOf: { machine: string | null } | null
  /** The file cannot be read (git conflict markers, invalid frontmatter): it can only be deleted or fixed by hand. */
  problem: boolean
  /** A conversation started from the editor: its file and section («desde Emacs: <archivo> › <sección>»). */
  writing?: ChatWritingNote
}

export type AssistantView = AssistantMessage & { citations: ChatCitation[]; unverified: number }
/** An action as the conversation shows it: whether «Deshacer» is offered, and whether it was already undone. */
export type ActionView = ActionMessage & { undoable: boolean; undone: boolean }
export type ChatMessageView = UserMessage | AssistantView | ActionView

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
  /** Actions of the running answer waiting for «Aprobar» or «Rechazar». */
  approvals: PendingApproval[]
  /** A conversation started from the editor: the passage it is about. */
  writing?: ChatWriting
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
  /** The switches of a new conversation (ignored for an existing one, whose switches change with setTools). */
  actions?: boolean
  sync?: boolean
  /** A new conversation from the editor: the passage it is about (library scope only). */
  writing?: ChatWriting
  /** In a conversation from the editor, this question's mode (`opinion` when missing): it becomes the conversation's. */
  mode?: WritingMode
}

export type ChatStreamEvent =
  | { kind: 'start' }
  | { kind: 'delta'; text: string }
  /** A new turn of the model (after a tool call): the visible text starts over. */
  | { kind: 'turn' }
  | { kind: 'tool'; name: string }
  /** The pending approvals of the running answer changed: the window reads them again. */
  | { kind: 'approvals' }
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'error'; error: string }

/** Pushed on CHAT_STREAM_CHANNEL; `seq` grows across every answer of the session. */
export type ChatStreamUpdate = ChatStreamEvent & { chatId: string; seq: number }

/** Defined in ipc.ts, which has no runtime imports, so the sandboxed preload can use it without bundling zod. */
export { CHAT_STREAM_CHANNEL } from './ipc'
