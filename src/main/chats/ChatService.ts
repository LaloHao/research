import { randomBytes } from 'node:crypto'
import {
  CHAT_ID,
  ChatMetaSchema,
  MAX_CHAT_MESSAGE,
  MAX_CHAT_TITLE,
  MESSAGE_MODEL,
  normalizeExcerpt,
  PAPER_KEY,
  questionIndex,
  undoneActions,
  type ActionMessage,
  type AssistantMessage,
  type ChatConversation,
  type ChatFile,
  type ChatListQuery,
  type ChatMessage,
  type ChatMeta,
  type ChatMessageView,
  type ChatScope,
  type ChatSendRequest,
  type ChatStreamEvent,
  type ChatStreamUpdate,
  type ChatSummary,
  type PaperState,
  type UserMessage
} from '../../shared/chat'
import { APPROVAL_TIMEOUT_MS, UNDO_TOOL, type ActionTool, type ChatTools, type DenialReason, type PendingApproval } from '../../shared/chatActions'
import { citationsToText, citedPapers } from '../../shared/chatCitations'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import { rekeyBibtex } from '../ingest/bibtex'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import type { BudgetGuard, Reservation } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, type ChatResult, type LlmProvider } from '../llm/LlmProvider'
import { RunClock } from '../llm/RunClock'
import { ACTION_MAX_TOOL_CALLS, ACTIONS_SERVER_NAME, type ActionsMcpOptions } from '../mcp/ActionsMcpServer'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import { foldQuery, ToolError } from '../mcp/libraryTools'
import { checkMessages, newChatId, parseChat, renderChat, STOPPED_MARK, titleFrom, totalCost } from '../project/chatFile'
import { ConflictError, type ReadResult } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { AGENT_TIMEOUT_MS } from '../relations/RelationSuggester'
import { InvalidEdit } from '../summary/merge'
import { pagesFromChunks } from '../summary/paperText'
import { enabledTools, gateAction, isReadTool, latestUserText, toolEnabled } from './actionPolicy'
import type { ActionExecutor, ExecutedAction } from './actionTypes'
import { ApprovalGate, type ApprovalAnswer } from './ApprovalGate'
import { CHAT_MAX_TOOL_CALLS, chatInput, chatSystemPrompt, type PaperContext } from './chatPrompt'
import { unverifiedCount, verifyCitations } from './citations'

export interface ChatServiceDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  /** Starts the read-only MCP server for one answer (closed when the answer ends). */
  startTools: (opts: LibraryMcpOptions) => Promise<LibraryMcpHandle>
  /** Names this machine in the files it writes (`updated_on`), so the sync can name a copy. */
  machine: string
  /** The conversations changed (the session's 'chats' event). */
  emit: () => void
  /** An answer's progress, for the window. */
  stream: (update: ChatStreamUpdate) => void
  now?: () => Date
  /** Random hex for new ids; tests pass their own. */
  randomHex?: () => string
  /** The actions a conversation can run when its switches are on; without it (and startActions) no actions server is started. */
  actions?: ActionExecutor
  /** Starts the actions MCP server for one answer (closed when the answer ends). */
  startActions?: (opts: ActionsMcpOptions) => Promise<LibraryMcpHandle>
  /** How long an approval waits for the user (5 minutes); tests pass less. */
  approvalTimeoutMs?: number
}

/** One conversation as the index keeps it; `file` is null when the file cannot be read. */
interface Entry {
  id: string
  hash: string
  file: ChatFile | null
  /** Title and messages (citations as text), folded for search. */
  search: string
}

/** An answer being written. */
interface Run {
  controller: AbortController
  /** The text of the current turn so far. */
  text: string
  tools: number
  /** The last stream update sent for it. */
  seq: number
  done: Promise<void>
  /** The answer's time limit, held while an action waits for the user. */
  clock: RunClock
  /**
   * Aborted when the answer's calls to the actions server may no longer act: «Detener», the project closing, or the
   * answer ending (a call still being prepared then is recorded as denied and never asks).
   */
  calls: AbortController
  /** Calls to the actions server still running: their records are written before the answer. */
  actionCalls: Set<Promise<unknown>>
  /** The own text of the question being answered (the latest user message): the only text a request is quoted from. */
  latest: string | null
  /**
   * Actions run without asking for this question, earlier attempts included. Counted in memory and raised in the same
   * synchronous step as the gate's decision, so parallel calls (or a record that fails to write) never pass the cap.
   * Until the answer has read its question it is not a whole number, which the gate takes as the cap reached.
   */
  unconfirmed: number
}

const SEARCH_CHARS = 200_000
const MAX_WRITE_ATTEMPTS = 3
/** The summary fields a paper chat shows Claude. */
const PAPER_SUMMARY_FIELDS = ['tldr', 'problem', 'contribution', 'method', 'evaluation', 'results'] as const
const logged = (error: unknown): void => console.error('chat', error)

/**
 * The model id an answer's heading can hold: whitespace becomes `-`, a leading `$` is dropped; anything still unusable
 * (empty, the stopped mark) is `unknown`. The CLI reports ids like `claude-sonnet-5`; this only guards odd output.
 */
export function answerModel(id: string): string {
  const m = id.trim().replace(/\s+/g, '-').replace(/^\$+/, '')
  return m && m !== STOPPED_MARK && MESSAGE_MODEL.test(m) ? m : 'unknown'
}

function toEntry(id: string, read: ReadResult<ChatFile>): Entry {
  if (!read.ok) return { id, hash: read.hash, file: null, search: '' }
  const { meta, messages } = read.value
  // Action records are not searched: their arguments are the model's, and their words are the app's.
  const text = [meta.title, ...messages.flatMap((m) => (m.role === 'action' ? [] : [m.role === 'assistant' ? citationsToText(m.text) : m.text]))].join('\n')
  return { id, hash: read.hash, file: read.value, search: foldQuery(text.slice(0, SEARCH_CHARS)) }
}

const scopePaper = (e: Entry): string | null => (e.file && e.file.meta.scope !== 'library' ? e.file.meta.scope.paper : null)

/** A cost as the file writes it (4 decimals). */
export const roundCost = (usd: number): number => Math.round(usd * 10000) / 10000

/** How long the CLI waits for one call to the actions server: an approval waits up to 5 minutes and a job up to 1. */
export const ACTION_TOOL_TIMEOUT_MS = 10 * 60_000
const undoKey = (chatId: string, actionId: string): string => `${chatId}:${actionId}`
/** A record keeps plain JSON (no undefined, no class instances), as the file's YAML reads it back. */
const plain = (v: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>
const DENIED_NOTE = 'The user did not approve this action. Do not try it again unless the user asks.'

/**
 * The conversation exactly as `writeChat` will write it and a read will give it back: excerpts normalized (an excerpt
 * that would not read back is refused as `invalid_edit`), costs rounded to 4 decimals, message texts cleaned, fields
 * outside the file format dropped, `cost_usd` recomputed. The index keeps this, so it matches the file and its hash.
 */
export function asWritten(file: ChatFile): ChatFile {
  const prepared: ChatMessage[] = file.messages.map((m) => {
    if (m.role === 'assistant') return { ...m, costUsd: roundCost(m.costUsd) }
    if (m.role === 'action' || !m.excerpt) return m
    const excerpt = normalizeExcerpt(m.excerpt)
    if (!excerpt) throw new UserFacingError('invalid_edit')
    return { ...m, excerpt }
  })
  const messages = checkMessages(prepared)
  const meta = ChatMetaSchema.parse({ ...file.meta, cost_usd: totalCost(messages) })
  const read = parseChat(renderChat({ meta, messages }))
  if (!read.ok) throw new Error(`A conversation would not read back: ${read.problem.message}`)
  return read.value
}

/** What «Guardar en notas del paper» appends to notes.md. */
export function notesBlock(title: string, m: AssistantMessage): string {
  return `### Claude — ${m.at.slice(0, 10)} — ${title}\n\n${citationsToText(m.text).trim()}\n`
}

/** `text` with `block` after it, separated by a blank line; `text` itself is kept byte for byte. */
export function appendBlock(text: string, block: string): string {
  if (!text) return block
  const gap = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${block}`
}

/** The conversations of one project: chats/, their index, edits, notes, BibTeX, and (Task 8) the answers. */
/** Orders stream updates across every session of the app run, so a reopened project's first updates are never taken for stale ones. */
let streamSeq = 0

export class ChatService {
  private readonly entries = new Map<string, Entry>()
  private readonly runs = new Map<string, Run>()
  /** Conversations a send or retry is preparing (admission, the user's message), before their run starts. */
  private readonly sending = new Set<string>()
  /** Sends and retries in progress (admission and the user's message), so close() can wait for them. */
  private readonly preparing = new Set<Promise<unknown>>()
  private closed = false
  /** Counts the app's own writes and deletions; `changedAt` holds the count at each conversation's last one. */
  private writes = 0
  private readonly changedAt = new Map<string, number>()
  private readonly approvals: ApprovalGate
  /** «Deshacer» of each executed action that has one, by `<chat id>:<action id>`; in memory only (gone after a restart). */
  private readonly undos = new Map<string, () => Promise<void>>()
  /** The last write queued for each conversation (see update). */
  private readonly writing = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: ChatServiceDeps) {
    this.approvals = new ApprovalGate({ timeoutMs: deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS, changed: (id) => this.approvalsChanged(id), now: deps.now })
  }

  async reindex(): Promise<void> {
    const start = this.writes
    const next = new Map<string, Entry>()
    for (const id of await this.deps.store.listChatIds()) {
      const read = await this.deps.store.readChat(id)
      if (read) next.set(id, toEntry(id, read))
    }
    this.replaceEntries(next, start)
  }

  /** For the watcher: true when some file differs from the index (the app's own writes are already in it). */
  async reindexIfChanged(): Promise<boolean> {
    const start = this.writes
    const ids = await this.deps.store.listChatIds()
    let changed = ids.length !== this.entries.size
    const next = new Map<string, Entry>()
    for (const id of ids) {
      const read = await this.deps.store.readChat(id)
      if (!read) {
        changed = true
        continue
      }
      const known = this.entries.get(id)
      if (known && known.hash === read.hash) next.set(id, known)
      else {
        changed = true
        next.set(id, toEntry(id, read))
      }
    }
    if (changed) this.replaceEntries(next, start)
    return changed
  }

  /** Newest first; `text` matches the title and the messages (case, accents and whitespace ignored). */
  list(q: ChatListQuery = {}): ChatSummary[] {
    const text = q.text ? foldQuery(q.text) : ''
    return [...this.entries.values()]
      .filter((e) => (!q.paper || scopePaper(e) === q.paper) && (!text || e.search.includes(text)))
      .map((e) => this.summary(e))
      .sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? 1 : -1))
  }

  /** The conversation as it is on disk now, with every citation checked against the cited paper's text. */
  async open(id: string): Promise<ChatConversation> {
    const e = await this.fresh(id)
    if (!e.file) throw new UserFacingError('chat_invalid')
    const sources = { paperState: (p: string) => this.paperState(p), pages: (p: string) => pagesFromChunks(this.deps.cache.chunksFor(p)) }
    const undone = undoneActions(e.file.messages)
    const messages: ChatMessageView[] = e.file.messages.map((m) => {
      if (m.role === 'user') return m
      if (m.role === 'action') return { ...m, undone: undone.has(m.id), undoable: m.state === 'executed' && !undone.has(m.id) && this.undos.has(undoKey(id, m.id)) }
      const citations = verifyCitations(m.text, sources)
      return { ...m, citations, unverified: unverifiedCount(citations) }
    })
    const run = this.runs.get(id)
    return {
      summary: this.summary(e),
      messages,
      partial: run ? { text: run.text, tools: run.tools, seq: run.seq } : null,
      canRetry: !this.busy(id) && questionIndex(e.file.messages) >= 0,
      approvals: this.approvals.pending(id)
    }
  }

  async rename(id: string, title: string): Promise<void> {
    const clean = title.replace(/\s+/g, ' ').trim()
    if (!clean || clean.length > MAX_CHAT_TITLE) throw new UserFacingError('invalid_edit')
    await this.update(id, (f) => ({ ...f, meta: { ...f.meta, title: clean } }))
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.update(id, (f) => ({ ...f, meta: { ...f.meta, archived } }))
  }

  /** The model for the next answers. */
  async setModel(id: string, model: LlmModel): Promise<void> {
    if (!(LLM_MODELS as readonly string[]).includes(model)) throw new UserFacingError('invalid_edit')
    await this.update(id, (f) => ({ ...f, meta: { ...f.meta, model } }))
  }

  /** The conversation's switches; turning one off denies the waiting approvals of the tools it no longer offers. */
  async setTools(id: string, patch: Partial<ChatTools>): Promise<void> {
    for (const v of [patch.actions, patch.sync]) if (v !== undefined && typeof v !== 'boolean') throw new UserFacingError('invalid_edit')
    const file = await this.update(id, (f) => ({
      ...f,
      meta: { ...f.meta, ...(patch.actions === undefined ? {} : { actions: patch.actions }), ...(patch.sync === undefined ? {} : { sync: patch.sync }) }
    }))
    const tools: ChatTools = { actions: file.meta.actions, sync: file.meta.sync }
    this.approvals.denyWhere(id, (a) => !toolEnabled(a.tool, tools), 'disabled')
  }

  /** A pending approval of the conversation (the window opens the file picker before approving attach_pdf). */
  approval(chatId: string, approvalId: string): PendingApproval | null {
    return this.approvals.get(chatId, approvalId)
  }

  /** «Aprobar» / «Rechazar» on an approval card; only the window calls it, never a tool. */
  decide(chatId: string, approvalId: string, answer: ApprovalAnswer): void {
    const pending = this.approvals.get(chatId, approvalId)
    if (!pending) throw new UserFacingError('approval_gone')
    // attach_pdf runs only with the file the user picked in the app's own dialog.
    if (answer.approve && pending.pickPdf && !answer.pdfPath) throw new UserFacingError('invalid_edit')
    if (!this.approvals.decide(chatId, approvalId, answer)) throw new UserFacingError('approval_gone')
  }

  /** «Deshacer» of an executed action: once, recorded in the conversation; refused once its target changed since. */
  async undo(chatId: string, actionId: string): Promise<void> {
    const key = undoKey(chatId, actionId)
    const undo = this.undos.get(key)
    if (!undo) throw new UserFacingError('undo_unavailable')
    // Taken before it runs, so a second click never undoes twice; a transient failure puts it back.
    this.undos.delete(key)
    try {
      await undo()
    } catch (error) {
      if (error instanceof InvalidEdit) throw new UserFacingError('undo_unavailable', { cause: error })
      this.undos.set(key, undo)
      throw error
    }
    // The undo ran: its record is written, tried twice; if both fail the window shows the error.
    const record = (): Promise<string> => this.record(chatId, { tool: UNDO_TOOL, state: 'executed', approval: 'user', request: null, args: { action: actionId }, result: {} })
    await record().catch((error: unknown) => {
      logged(error)
      return record()
    })
  }

  /**
   * «Borrar»: only with `confirmed` (the user said yes to the UI's question), never while it answers, and only the
   * version on disk now (`chats/<id>.md`, a valid id; a concurrent change is a conflict). Unreadable files too.
   */
  async remove(id: string, confirmed: boolean): Promise<void> {
    if (confirmed !== true) throw new UserFacingError('invalid_edit')
    if (!CHAT_ID.test(id)) throw new UserFacingError('chat_not_found')
    if (this.busy(id)) throw new UserFacingError('chat_busy')
    const read = await this.deps.store.readChat(id)
    if (read) await this.deps.store.deleteChat(id, read.hash)
    this.entries.delete(id)
    for (const key of [...this.undos.keys()]) if (key.startsWith(`${id}:`)) this.undos.delete(key)
    this.changedAt.set(id, ++this.writes)
    this.deps.emit()
  }

  /**
   * «Guardar en notas del paper»: the answer and its citations, as text, appended to a paper's notes.md: the paper the
   * user picked, or in a paper chat its own paper by default (a global chat needs a pick). The notes are hash-checked
   * and re-read on a concurrent change; what is there is never rewritten.
   */
  async saveToNotes(id: string, index: number, picked?: string | null): Promise<void> {
    const { file, answer } = await this.answerAt(id, index)
    if (!answer.text.trim()) throw new UserFacingError('invalid_edit')
    const paperId = picked ?? (file.meta.scope === 'library' ? null : file.meta.scope.paper)
    if (!paperId) throw new UserFacingError('invalid_edit')
    const block = notesBlock(file.meta.title, answer)
    for (let attempt = 1; ; attempt++) {
      if (!PAPER_KEY.test(paperId) || !this.deps.store.paperExists(paperId)) throw new UserFacingError('paper_not_in_library')
      const notes = await this.deps.store.readNotes(paperId)
      try {
        await this.deps.store.writeNotes(paperId, appendBlock(notes.text, block), notes.hash)
        return
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= MAX_WRITE_ATTEMPTS) throw error
      }
    }
  }

  /** «Copiar BibTeX de las citas»: the cited library papers' entries, in order of first citation. */
  async citationsBibtex(id: string, index: number): Promise<string> {
    const { answer } = await this.answerAt(id, index)
    const entries: string[] = []
    for (const key of citedPapers(answer.text)) {
      if (!PAPER_KEY.test(key) || !this.deps.store.paperExists(key)) continue
      try {
        const read = await this.deps.store.readPaper(key)
        if (read.ok) entries.push(rekeyBibtex(read.value.bibtex, key))
      } catch {
        // A paper trashed meanwhile, or an invalid BibTeX entry (left out as in exports/library.bib), is skipped.
      }
    }
    return entries.join('\n\n')
  }

  /** Where a paper is, as the index knows it. */
  paperState(id: string): PaperState {
    if (this.deps.cache.getPaper(id)) return 'library'
    return this.deps.cache.isTrashed(id) ? 'trash' : 'missing'
  }

  /**
   * Sends a message (the conversation is created with its first one) and starts the answer; resolves with the
   * conversation id once the message is written. Over a cap nothing is written (the composer keeps the text).
   */
  send(req: ChatSendRequest): Promise<string> {
    return this.track(this.sendNow(req))
  }

  /** «Reintentar»: answers the last message again when it is an unanswered question. */
  retry(id: string): Promise<void> {
    return this.track(this.retryNow(id))
  }

  /** «Detener»: what arrived is saved as a stopped answer. */
  stop(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    run.calls.abort()
    run.controller.abort()
    // The abort already denies them; said again so nothing of this conversation keeps waiting.
    this.approvals.denyWhere(id, () => true, 'stopped')
  }

  /** Resolves once no answer is being written. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs.values()].map((r) => r.done))
  }

  /** The project closes: no new answers; sends in progress finish, then running answers stop (saved as stopped). */
  async close(): Promise<void> {
    this.closed = true
    while (this.preparing.size > 0) await Promise.allSettled([...this.preparing])
    for (const run of this.runs.values()) {
      run.calls.abort()
      run.controller.abort()
    }
    this.approvals.denyAll('stopped')
    await this.idle()
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.preparing.add(work)
    const forget = (): void => {
      this.preparing.delete(work)
    }
    work.then(forget, forget)
    return work
  }

  private async sendNow(req: ChatSendRequest): Promise<string> {
    if (this.closed) throw new UserFacingError('chat_busy')
    const text = req.text.trim()
    if (!text || text.length > MAX_CHAT_MESSAGE) throw new UserFacingError('invalid_edit')
    if (req.chatId && !CHAT_ID.test(req.chatId)) throw new UserFacingError('chat_not_found')
    if (req.chatId && this.busy(req.chatId)) throw new UserFacingError('chat_busy')
    if (!req.chatId && req.scope !== 'library' && this.paperState(req.scope.paper) !== 'library') throw new UserFacingError('paper_not_in_library')
    if (req.chatId) this.sending.add(req.chatId)
    try {
      const reservation = await this.deps.budget.admit(undefined, 'chat')
      let id: string
      try {
        const message: UserMessage = { role: 'user', at: this.now().toISOString(), text, excerpt: req.excerpt }
        id = req.chatId ? (await this.update(req.chatId, (f) => ({ ...f, messages: [...f.messages, message] }))).meta.id : await this.create(req, message)
      } catch (error) {
        reservation.release()
        throw error
      }
      this.start(id, reservation)
      return id
    } finally {
      if (req.chatId) this.sending.delete(req.chatId)
    }
  }

  private async retryNow(id: string): Promise<void> {
    if (this.closed) throw new UserFacingError('chat_busy')
    if (this.busy(id)) throw new UserFacingError('chat_busy')
    this.sending.add(id)
    try {
      const e = await this.fresh(id)
      if (!e.file) throw new UserFacingError('chat_invalid')
      if (questionIndex(e.file.messages) < 0) throw new UserFacingError('invalid_edit')
      this.start(id, await this.deps.budget.admit(undefined, 'chat'))
    } finally {
      this.sending.delete(id)
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private busy(id: string): boolean {
    return this.runs.has(id) || this.sending.has(id)
  }

  /**
   * Installs a scan that started when the write count was `start`; a conversation the app wrote or deleted since keeps
   * its current entry (or absence), so a scan never puts back a version older than the app's own write.
   */
  private replaceEntries(next: Map<string, Entry>, start: number): void {
    const newer = new Map<string, Entry | undefined>()
    for (const [id, at] of this.changedAt) if (at > start) newer.set(id, this.entries.get(id))
    this.entries.clear()
    for (const [id, e] of next) this.entries.set(id, e)
    for (const [id, e] of newer) {
      if (e) this.entries.set(id, e)
      else this.entries.delete(id)
    }
  }

  private summary(e: Entry): ChatSummary {
    if (!e.file) {
      return { id: e.id, title: e.id, scope: 'library', paperTitle: null, paperState: null, archived: false, actions: false, sync: false, model: 'sonnet', updatedAt: '', costUsd: 0, messages: 0, copyOf: null, problem: true }
    }
    const { meta, messages } = e.file
    const paper = scopePaper(e)
    const state = paper ? this.paperState(paper) : null
    return {
      id: e.id,
      title: meta.title,
      scope: meta.scope,
      paperTitle: paper && state === 'library' ? (this.deps.cache.getPaper(paper)?.title ?? null) : null,
      paperState: state,
      archived: meta.archived,
      actions: meta.actions,
      sync: meta.sync,
      model: meta.model,
      updatedAt: meta.updated_at,
      costUsd: meta.cost_usd,
      // The messages the user reads as the conversation: action records are not counted.
      messages: messages.filter((m) => m.role !== 'action').length,
      copyOf: meta.copy_of ? { machine: meta.copy_of.machine } : null,
      problem: false
    }
  }

  /** The file as it is on disk now (the watcher may not have reported a change yet), kept in the index. */
  private async fresh(id: string): Promise<Entry> {
    if (!CHAT_ID.test(id)) throw new UserFacingError('chat_not_found')
    const read = await this.deps.store.readChat(id)
    if (!read) {
      if (this.entries.delete(id)) this.deps.emit()
      throw new UserFacingError('chat_not_found')
    }
    const known = this.entries.get(id)
    if (known && known.hash === read.hash) return known
    const e = toEntry(id, read)
    this.entries.set(id, e)
    this.deps.emit()
    return e
  }

  private async answerAt(id: string, index: number): Promise<{ file: ChatFile; answer: AssistantMessage }> {
    const e = await this.fresh(id)
    if (!e.file) throw new UserFacingError('chat_invalid')
    const m = Number.isInteger(index) ? e.file.messages[index] : undefined
    if (!m || m.role !== 'assistant') throw new UserFacingError('invalid_edit')
    return { file: e.file, answer: m }
  }

  /**
   * Writes a conversation (`expectedHash` null creates it) stamped with this machine and the time, and keeps in the
   * index exactly what the file now holds.
   */
  private async write(file: ChatFile, expectedHash: string | null): Promise<ChatFile> {
    const written = asWritten({ ...file, meta: { ...file.meta, updated_at: this.now().toISOString(), updated_on: this.deps.machine } })
    const hash = await this.deps.store.writeChat(written, expectedHash)
    this.entries.set(written.meta.id, toEntry(written.meta.id, { ok: true, hash, value: written }))
    this.changedAt.set(written.meta.id, ++this.writes)
    this.deps.emit()
    return written
  }

  /** Read, change and write one conversation; read again and redo the change on a concurrent write (at most 3 times). */
  private update(id: string, change: (file: ChatFile) => ChatFile): Promise<ChatFile> {
    // One write at a time per conversation: parallel action records (and an undo's) would otherwise race on its hash.
    const prior = this.writing.get(id) ?? Promise.resolve()
    const work = prior.then(
      () => this.updateNow(id, change),
      () => this.updateNow(id, change)
    )
    const tail = work.catch(() => undefined)
    this.writing.set(id, tail)
    void tail.then(() => {
      if (this.writing.get(id) === tail) this.writing.delete(id)
    })
    return work
  }

  private async updateNow(id: string, change: (file: ChatFile) => ChatFile): Promise<ChatFile> {
    for (let attempt = 1; ; attempt++) {
      const e = await this.fresh(id)
      if (!e.file) throw new UserFacingError('chat_invalid')
      try {
        return await this.write(change(e.file), e.hash)
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= MAX_WRITE_ATTEMPTS) throw error
      }
    }
  }

  /** A new conversation with its first message; a taken id (practically impossible) is a ConflictError, never an overwrite. */
  private async create(req: ChatSendRequest, message: UserMessage): Promise<string> {
    const id = newChatId(this.now(), this.deps.randomHex?.() ?? randomBytes(2).toString('hex'))
    const file: ChatFile = {
      meta: {
        schema_version: 1,
        id,
        title: titleFrom(message.text),
        scope: req.scope,
        model: req.model,
        created_at: message.at,
        updated_at: message.at,
        archived: false,
        cost_usd: 0,
        actions: req.actions === true,
        sync: req.sync === true,
        updated_on: this.deps.machine
      },
      messages: [message]
    }
    return (await this.write(file, null)).meta.id
  }

  private start(id: string, reservation: Reservation): void {
    const run: Run = {
      controller: new AbortController(),
      text: '',
      tools: 0,
      seq: streamSeq,
      done: Promise.resolve(),
      clock: new RunClock(),
      calls: new AbortController(),
      actionCalls: new Set(),
      latest: null,
      unconfirmed: Number.NaN
    }
    this.runs.set(id, run)
    run.done = this.answer(id, run, reservation).finally(() => this.runs.delete(id))
  }

  private push(id: string, run: Run, event: ChatStreamEvent): void {
    run.seq = ++streamSeq
    // The window may be gone; the answer goes on and is written either way.
    try {
      this.deps.stream({ ...event, chatId: id, seq: run.seq })
    } catch (error) {
      logged(error)
    }
  }

  /** The switches an answer honours: none when the session gives no actions. */
  private toolsOf(meta: ChatMeta): ChatTools {
    const able = this.deps.actions !== undefined && this.deps.startActions !== undefined
    return { actions: able && meta.actions, sync: able && meta.sync }
  }

  private approvalsChanged(id: string): void {
    const run = this.runs.get(id)
    if (run) this.push(id, run, { kind: 'approvals' })
  }

  /** One call to the actions server, tracked so the answer is written after every record of its actions. */
  private callAction(id: string, run: Run, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const work = this.runAction(id, run, tool, args)
    run.actionCalls.add(work)
    const forget = (): void => void run.actionCalls.delete(work)
    work.then(forget, forget)
    return work
  }

  /**
   * The app's rule for one call: the switch is checked again; reads run; anything else is prepared (a ToolError when it
   * cannot be done), then runs on its own only when gateAction allows it, or after the user approves it in the
   * conversation. Executed, denied and failed actions are recorded; Claude gets what happened.
   */
  private async runAction(id: string, run: Run, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const actions = this.deps.actions
    if (!actions) throw new ToolError('Actions are not available.')
    const file = (await this.fresh(id)).file
    if (!file || !toolEnabled(tool, this.toolsOf(file.meta))) {
      throw new ToolError('That tool is turned off in this conversation; the user can turn it on in the conversation header.')
    }
    if (run.controller.signal.aborted || run.calls.signal.aborted) throw new ToolError('The answer was stopped.')
    if (isReadTool(tool)) return actions.read(tool, args)
    const prepared = await actions.prepare(tool as ActionTool, args).catch((error: unknown) => {
      throw error instanceof ToolError ? error : new ToolError(`That cannot be done: ${toUserFacing(error).code}.`)
    })
    // What runs must be the tool that was called (and whose switch was checked).
    if (prepared.tool !== tool) throw new Error(`Prepared ${prepared.tool} for a call of ${tool}`)
    const quote = typeof args.request_quote === 'string' ? args.request_quote : undefined
    // Checked again in the same synchronous step as the gate: a stop, a switch turned off or the answer ending while
    // the call was being prepared means it never runs nor asks.
    const cancelled = this.cancelled(id, run, tool)
    const gate = gateAction({ tool: prepared.tool, risk: prepared.risk, quote, latest: run.latest, unconfirmed: run.unconfirmed, args: prepared.args })
    // Counted in the same step as the decision: no other call can see the count before this one raised it.
    if (!cancelled && !gate.ask) run.unconfirmed++
    const base = { tool: prepared.tool, request: gate.request, args: prepared.args }
    const deny = async (reason: DenialReason): Promise<unknown> => {
      await this.record(id, { ...base, state: 'denied', approval: null, result: { reason } }).catch(logged)
      return { status: 'denied', reason, note: DENIED_NOTE }
    }
    if (cancelled) return deny(cancelled)
    let approval: 'request' | 'user' = 'request'
    let pdfPath: string | undefined
    if (gate.ask) {
      const answer = await this.approvals.ask(
        id,
        { tool: prepared.tool, args: prepared.args, preview: prepared.preview, request: gate.request, risk: prepared.risk, pickPdf: prepared.pickPdf, reason: gate.reason },
        run.calls.signal,
        run.clock
      )
      if (answer.kind === 'denied') return deny(answer.reason)
      approval = 'user'
      pdfPath = answer.pdfPath
      // The switch may have been turned off where no approval is denied (a sync merge): read the file again.
      const meta = await this.fresh(id).then(
        (e) => e.file?.meta ?? null,
        () => null
      )
      const after = !meta || !toolEnabled(tool, this.toolsOf(meta)) ? 'disabled' : this.cancelled(id, run, tool)
      if (after) return deny(after)
    }
    let done: ExecutedAction
    try {
      done = await prepared.execute({ pdfPath })
    } catch (error) {
      const code = toUserFacing(error).code
      await this.record(id, { ...base, state: 'failed', approval, result: { error: code } }).catch(logged)
      return { status: 'failed', error: code }
    }
    const actionId = await this.record(id, { ...base, state: done.failed ? 'failed' : 'executed', approval, result: done.result }).catch((error: unknown) => {
      logged(error)
      return null
    })
    if (actionId && done.undo && !done.failed) this.undos.set(undoKey(id, actionId), done.undo)
    return { status: done.failed ? 'failed' : 'done', ...done.result }
  }

  /**
   * Why a call of this answer may no longer act, checked synchronously: the switch is off as the index holds it now
   * (setTools updates it before it returns), or the answer's calls were cancelled; null when it may.
   */
  private cancelled(id: string, run: Run, tool: string): DenialReason | null {
    const meta = this.entries.get(id)?.file?.meta
    if (!meta || !toolEnabled(tool, this.toolsOf(meta))) return 'disabled'
    return run.calls.signal.aborted || run.controller.signal.aborted ? 'stopped' : null
  }

  /** Appends an action's record to the conversation and returns its id (unique in the conversation). */
  private async record(id: string, a: Omit<ActionMessage, 'role' | 'at' | 'id'>): Promise<string> {
    const at = this.now().toISOString()
    const args = plain(a.args)
    const result = plain(a.result)
    let actionId = ''
    await this.update(id, (f) => {
      const taken = new Set(f.messages.flatMap((m) => (m.role === 'action' ? [m.id] : [])))
      do actionId = randomBytes(3).toString('hex')
      while (taken.has(actionId))
      const m: ActionMessage = { ...a, role: 'action', at, id: actionId, args, result }
      return { ...f, messages: [...f.messages, m] }
    })
    return actionId
  }

  /**
   * One answer: the question and its context, a fresh read-only MCP server, the provider's stream forwarded, the
   * answer written once at the end. A failure leaves the question for «Reintentar»; a stop saves what arrived.
   */
  private async answer(id: string, run: Run, reservation: Reservation): Promise<void> {
    const { store, provider, ledger } = this.deps
    let spent = 0
    let charged = false
    let estimated = false
    let model = 'unknown'
    let paperId = ''
    try {
      this.push(id, run, { kind: 'start' })
      const e = await this.fresh(id)
      if (!e.file) throw new UserFacingError('chat_invalid')
      const { meta, messages } = e.file
      // The question may be followed by the actions an earlier attempt ran (a retry): they stay where they are.
      const asked = questionIndex(messages)
      const question = messages[asked]
      if (asked < 0 || question?.role !== 'user') throw new UserFacingError('invalid_edit')
      model = meta.model
      paperId = meta.scope === 'library' ? '' : meta.scope.paper
      const input = chatInput({
        thesis: store.config.thesis,
        scope: meta.scope,
        paper: await this.paperContext(meta.scope),
        history: messages.slice(0, asked),
        question: question.text,
        excerpt: question.excerpt,
        // Only what follows the question: the history above stops before it, so no record is shown twice.
        actionsDone: messages.slice(asked + 1).filter((m): m is ActionMessage => m.role === 'action')
      })
      run.latest = latestUserText(messages)
      // Earlier attempts at this same question (a retry) count against the cap too.
      run.unconfirmed = messages.slice(asked + 1).filter((m) => m.role === 'action' && m.approval === 'request').length
      run.controller.signal.throwIfAborted()
      const tools = await this.deps.startTools({ maxToolCalls: CHAT_MAX_TOOL_CALLS, markData: true }).catch((error: unknown) => {
        throw new UserFacingError('agent_tools_unavailable', { cause: error })
      })
      const on = this.toolsOf(meta)
      let actions: LibraryMcpHandle | null = null
      let result: ChatResult
      try {
        if (on.actions || on.sync) {
          actions = await this.deps.startActions!({ tools: enabledTools(on), maxToolCalls: ACTION_MAX_TOOL_CALLS, call: (tool, args) => this.callAction(id, run, tool, args) }).catch(
            (error: unknown) => {
              throw new UserFacingError('agent_tools_unavailable', { cause: error })
            }
          )
        }
        run.controller.signal.throwIfAborted()
        result = await provider.chat(
          {
            system: chatSystemPrompt(meta.scope, on),
            input,
            model: meta.model,
            maxUsd: store.config.llm.budget.per_chat_message_usd,
            servers: [
              { name: MCP_SERVER_NAME, url: tools.url, token: tools.token },
              ...(actions ? [{ name: ACTIONS_SERVER_NAME, url: actions.url, token: actions.token }] : [])
            ],
            // The servers enforce the tool budgets; the spare turns let a refused call still end in an answer.
            maxTurns: CHAT_MAX_TOOL_CALLS + (actions ? ACTION_MAX_TOOL_CALLS : 0) + 3,
            signal: run.controller.signal,
            timeoutMs: AGENT_TIMEOUT_MS,
            clock: run.clock,
            ...(actions ? { toolTimeoutMs: ACTION_TOOL_TIMEOUT_MS } : {})
          },
          (event) => {
            if (event.kind === 'delta') run.text += event.text
            else if (event.kind === 'turn') run.text = ''
            else run.tools++
            this.push(id, run, event)
          }
        )
      } finally {
        // First: no call of this answer may act or ask any more, whatever it is waiting on.
        run.calls.abort()
        await tools.close().catch(logged)
        await actions?.close().catch(logged)
        // An approval still waiting when the answer ended (the CLI gave up on the call) has nobody to tell: denied.
        this.approvals.denyWhere(id, () => true, 'stopped')
        // An action still running (its approval was just denied by «Detener», its record being written) ends first,
        // so its record comes before the answer in the file.
        await Promise.allSettled([...run.actionCalls])
      }
      spent = result.costUsd
      charged = true
      model = answerModel(result.model)
      await ledger.append({ paperId, model, costUsd: result.costUsd, operation: 'chat' }).catch(logged)
      const answer: AssistantMessage = {
        role: 'assistant',
        at: this.now().toISOString(),
        model,
        costUsd: result.costUsd,
        stopped: false,
        text: result.text.trim() || run.text.trim()
      }
      await this.update(id, (f) => ({ ...f, messages: [...f.messages, answer] }))
      this.push(id, run, { kind: 'done' })
    } catch (error) {
      // A cut-off or stopped call is charged at its cap (estimated), so the monthly cap counts it; never twice.
      const charge = failedCallCost(error)
      if (!charged && charge.costUsd > 0) {
        charged = true
        spent = charge.costUsd
        estimated = charge.estimated
        await ledger.append({ paperId, model, costUsd: charge.costUsd, operation: 'chat', estimated: charge.estimated }).catch(logged)
      }
      if (run.controller.signal.aborted) {
        const stopped: AssistantMessage = { role: 'assistant', at: this.now().toISOString(), model, costUsd: spent, stopped: true, text: run.text.trim() }
        await this.update(id, (f) => ({ ...f, messages: [...f.messages, stopped] })).catch(logged)
        this.push(id, run, { kind: 'stopped' })
      } else {
        const code = toUserFacing(error).code
        // The CLI's cap here is the per-message one, which has its own setting.
        this.push(id, run, { kind: 'error', error: code === 'operation_budget' ? 'chat_message_budget' : code })
      }
    } finally {
      reservation.settle(spent, { estimated })
    }
  }

  /** The paper of a paper chat, while it is in the library: metadata and its summary's main fields. */
  private async paperContext(scope: ChatScope): Promise<PaperContext | null> {
    if (scope === 'library' || !this.deps.store.paperExists(scope.paper)) return null
    // Trashed meanwhile or unreadable: the answer goes on without it.
    const read = await this.deps.store.readPaper(scope.paper).catch(() => null)
    if (!read?.ok) return null
    const p = read.value
    const summary = await this.deps.store.readSummary(p.id).catch(() => null)
    return {
      id: p.id,
      title: p.title,
      authors: p.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).join(', '),
      year: p.year ?? null,
      venue: p.venue ?? null,
      abstract: p.abstract ?? null,
      summary: summary?.ok ? Object.fromEntries(PAPER_SUMMARY_FIELDS.map((k) => [k, String(summary.value.fields[k].value ?? '')])) : null
    }
  }
}
