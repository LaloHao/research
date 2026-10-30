import { z } from 'zod'
import {
  CHAT_ID,
  MAX_CHAT_MESSAGE,
  MAX_WRITING_FILE,
  MAX_WRITING_PASSAGE,
  MAX_WRITING_SECTION,
  WRITING_MODES,
  WRITING_SCOPES,
  type AssistantView,
  type ChatConversation,
  type ChatSummary,
  type WritingMode
} from '../../shared/chat'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import { answerToOrg } from '../../shared/writing/answerOrg'
import { UserFacingError } from '../library/UserFacingError'
import { ApiError, costlyTool, freeTool, type ApiContext, type ApiTool } from './registry'

const conversationId = z.string().regex(CHAT_ID).describe('The id ask answered')
/** Counted in characters (code points), as the editor counts them. */
const passage = z
  .string()
  .refine((s) => [...s].length <= MAX_WRITING_PASSAGE, `At most ${MAX_WRITING_PASSAGE} characters`)
  .describe(`The passage: the region, paragraph, section or file (at most ${MAX_WRITING_PASSAGE} characters)`)

const ASK_INPUT = {
  question: z.string().trim().min(1).max(MAX_CHAT_MESSAGE),
  text: passage.optional().describe('The passage the question is about; required to start a conversation, not given in a follow-up'),
  file: z.string().max(4096).optional().describe("The file's name (its folder is dropped)"),
  section: z.string().max(MAX_WRITING_SECTION).optional().describe('The heading path, e.g. "Chapter 2 › Related work"'),
  scope: z.enum(WRITING_SCOPES).optional().describe('What the passage is: region (default), paragraph, subtree or file'),
  mode: z
    .enum(WRITING_MODES)
    .optional()
    .describe('opinion (default): comments, critique, suggestions and questions, never a rewrite; rewrite: only when the user explicitly allowed a proposed rewrite for this question'),
  conversation_id: conversationId.optional().describe('A follow-up question in that conversation'),
  model: z.enum(LLM_MODELS).optional().describe("sonnet, haiku or opus for a new conversation; the project's model when missing")
}
type AskArgs = z.infer<z.ZodObject<typeof ASK_INPUT>>

const fileName = (path: string | undefined): string => (path ?? '').split(/[\\/]/).pop()!.trim().slice(0, MAX_WRITING_FILE)

/** The conversation a follow-up continues: it exists and was started from the editor. */
function followed(ctx: ApiContext, id: string): ChatSummary {
  const summary = ctx.chats.list().find((c) => c.id === id)
  if (!summary || summary.problem) throw new ApiError('not_found', `No conversation ${id}.`)
  if (!summary.writing) throw new ApiError('invalid', `The conversation ${id} was not started with ask: continue it in the app.`)
  return summary
}

/** The arguments checked before anything is spent: a passage to start, none in a follow-up. */
function checked(ctx: ApiContext, args: AskArgs): { summary: ChatSummary | null } {
  if (args.conversation_id) {
    if (args.text !== undefined) throw new ApiError('invalid', 'A follow-up keeps the passage its conversation started with: do not send text.')
    return { summary: followed(ctx, args.conversation_id) }
  }
  if (!args.text?.trim()) throw new ApiError('invalid', 'Send the passage (text) the question is about.')
  return { summary: null }
}

const modelOf = (ctx: ApiContext, args: AskArgs): LlmModel => {
  const summary = args.conversation_id ? ctx.chats.list().find((c) => c.id === args.conversation_id) : undefined
  return summary?.model ?? args.model ?? ctx.store.config.llm.model
}

/** A chat error as the API's codes. */
function chatError(error: unknown): never {
  if (error instanceof UserFacingError) {
    if (error.code === 'chat_busy') throw new ApiError('busy', 'Claude is still answering in this conversation: follow it with ask_status or stop it with ask_stop.')
    if (error.code === 'chat_not_found') throw new ApiError('not_found', 'No such conversation.')
    if (error.code === 'invalid_edit' || error.code === 'chat_invalid') throw new ApiError('invalid', 'The conversation cannot take this question.')
  }
  throw error
}

/** The last answer of a conversation (Claude's, not an action record), and how it checked. */
const lastAnswer = (chat: ChatConversation): AssistantView | null => {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]
    if (m.role === 'assistant') return m as AssistantView
    if (m.role === 'user') return null
  }
  return null
}

/**
 * «Preguntar a Claude» from the editor: Claude's opinion on a passage the user is writing, as a conversation of the
 * app's Chat view (chats/, synced like any other). Like a draft it answers once admitted; the answer is followed with
 * the free `ask_status` and stopped with `ask_stop`.
 */
export const ASK_API_TOOLS: ApiTool[] = [
  costlyTool({
    name: 'ask',
    description:
      "«Preguntar a Claude»: Claude's opinion on a passage the user is writing (its file and heading path given), with the library's read-only tools and the thesis context; every claim about a paper is cited with a quote and page the app checks. By default (mode opinion) Claude comments, critiques, suggests and asks, and does not rewrite the passage; mode rewrite (only when the user explicitly allowed it for this question) may add a proposed version set apart as Claude's. Starts a conversation in the app's Chat view (or, with conversation_id, asks a follow-up in it) and answers at once with its conversation_id: follow the answer with ask_status (free), stop it with ask_stop. Costs Claude quota (one chat answer, under the per-message cap): without confirmed it answers the plan.",
    input: ASK_INPUT,
    cost: {
      kind: 'chat',
      model: modelOf,
      // ChatService admits and charges the answer as a chat answer, under the per-message cap.
      selfCapped: true,
      plan: async (ctx, args) => {
        const { summary } = checked(ctx, args)
        return {
          conversation_id: summary?.id ?? null,
          answering: summary ? ctx.chats.answering(summary.id) : false,
          mode: args.mode ?? 'opinion',
          chars: summary ? null : [...(args.text ?? '')].length,
          file: summary?.writing?.file ?? fileName(args.file),
          section: summary?.writing?.section ?? args.section?.trim() ?? ''
        }
      }
    },
    async run(ctx, args) {
      const { summary } = checked(ctx, args)
      const mode: WritingMode = args.mode ?? 'opinion'
      const model = modelOf(ctx, args)
      const id = await ctx.chats
        .send({
          chatId: summary?.id ?? null,
          scope: 'library',
          model,
          text: args.question,
          excerpt: null,
          mode,
          ...(summary
            ? {}
            : {
                writing: {
                  source: 'emacs' as const,
                  file: fileName(args.file),
                  section: (args.section ?? '').replace(/\s+/g, ' ').trim(),
                  scope: args.scope ?? 'region',
                  mode,
                  passage: args.text!
                }
              })
        })
        .catch(chatError)
      // Charged by ChatService when the answer ends; nothing is spent by this answer.
      return { conversation_id: id, status: 'running', costUsd: 0, model }
    }
  }),
  freeTool({
    name: 'ask_status',
    description:
      "A conversation's latest answer: running (with its text so far, as Org), done or stopped (the answer as plain Org text, each citation as [key, p. N] with its offsets in characters, the key, page, quote and whether the app found the quote in the paper; the answer's cost), or error with its code. Free.",
    input: { conversation_id: conversationId },
    async run(ctx, args) {
      const id = args.conversation_id
      const partial = ctx.chats.progress(id)
      if (partial || ctx.chats.answering(id)) {
        const org = answerToOrg(partial?.text ?? '')
        return { conversation_id: id, status: 'running', text: org.text, tools: partial?.tools ?? 0 }
      }
      const chat = await ctx.chats.open(id).catch(chatError)
      const outcome = ctx.chats.outcome(id)
      if (outcome?.kind === 'error') return { conversation_id: id, status: 'error', error: outcome.error }
      const answer = lastAnswer(chat)
      // A question left without an answer and nothing running: the app closed (or restarted) while it answered.
      if (!answer) return { conversation_id: id, status: 'error', error: 'interrupted' }
      const org = answerToOrg(answer.text, answer.citations)
      return {
        conversation_id: id,
        status: answer.stopped ? 'stopped' : 'done',
        title: chat.summary.title,
        file: chat.writing?.file ?? null,
        section: chat.writing?.section ?? null,
        mode: chat.writing?.mode ?? null,
        text: org.text,
        citations: org.citations.map((c) => ({ ...c, verified: c.state === 'found' })),
        unverified: answer.unverified,
        costUsd: answer.costUsd,
        conversation_cost_usd: chat.summary.costUsd,
        model: answer.model
      }
    }
  }),
  freeTool({
    name: 'ask_stop',
    description: 'Stops the answer being written in a conversation; what arrived is kept as a stopped answer (ask_status then says stopped). Free.',
    input: { conversation_id: conversationId },
    async run(ctx, args) {
      const running = ctx.chats.progress(args.conversation_id) !== null
      if (running) ctx.chats.stop(args.conversation_id)
      return { conversation_id: args.conversation_id, stopping: running }
    }
  }),
  freeTool({
    name: 'open_chat_in_app',
    description: "Brings the app's window to the front and opens a conversation in its Chat view.",
    input: { conversation_id: conversationId },
    async run(ctx, args) {
      const summary = ctx.chats.list().find((c) => c.id === args.conversation_id)
      if (!summary) throw new ApiError('not_found', `No conversation ${args.conversation_id}.`)
      ctx.openChatInApp(args.conversation_id)
      return { opened: true }
    }
  })
]
