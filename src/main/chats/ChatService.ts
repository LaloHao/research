import { randomBytes } from 'node:crypto'
import {
  CHAT_ID,
  ChatMetaSchema,
  MAX_CHAT_MESSAGE,
  MAX_CHAT_TITLE,
  MESSAGE_MODEL,
  normalizeExcerpt,
  PAPER_KEY,
  type AssistantMessage,
  type ChatConversation,
  type ChatFile,
  type ChatListQuery,
  type ChatMessage,
  type ChatMessageView,
  type ChatScope,
  type ChatSendRequest,
  type ChatStreamEvent,
  type ChatStreamUpdate,
  type ChatSummary,
  type PaperState,
  type UserMessage
} from '../../shared/chat'
import { citationsToText, citedPapers } from '../../shared/chatCitations'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import { rekeyBibtex } from '../ingest/bibtex'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import type { BudgetGuard, Reservation } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, type ChatResult, type LlmProvider } from '../llm/LlmProvider'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import { foldQuery } from '../mcp/libraryTools'
import { checkMessages, newChatId, parseChat, renderChat, STOPPED_MARK, titleFrom, totalCost } from '../project/chatFile'
import { ConflictError, type ReadResult } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { AGENT_TIMEOUT_MS } from '../relations/RelationSuggester'
import { pagesFromChunks } from '../summary/paperText'
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
  const text = [meta.title, ...messages.map((m) => (m.role === 'assistant' ? citationsToText(m.text) : m.text))].join('\n')
  return { id, hash: read.hash, file: read.value, search: foldQuery(text.slice(0, SEARCH_CHARS)) }
}

const scopePaper = (e: Entry): string | null => (e.file && e.file.meta.scope !== 'library' ? e.file.meta.scope.paper : null)

/** A cost as the file writes it (4 decimals). */
export const roundCost = (usd: number): number => Math.round(usd * 10000) / 10000

/**
 * The conversation exactly as `writeChat` will write it and a read will give it back: excerpts normalized (an excerpt
 * that would not read back is refused as `invalid_edit`), costs rounded to 4 decimals, message texts cleaned, fields
 * outside the file format dropped, `cost_usd` recomputed. The index keeps this, so it matches the file and its hash.
 */
export function asWritten(file: ChatFile): ChatFile {
  const prepared: ChatMessage[] = file.messages.map((m) => {
    if (m.role === 'assistant') return { ...m, costUsd: roundCost(m.costUsd) }
    if (!m.excerpt) return m
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
function appendBlock(text: string, block: string): string {
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

  constructor(private readonly deps: ChatServiceDeps) {}

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
    const messages: ChatMessageView[] = e.file.messages.map((m) => {
      if (m.role === 'user') return m
      const citations = verifyCitations(m.text, sources)
      return { ...m, citations, unverified: unverifiedCount(citations) }
    })
    const run = this.runs.get(id)
    return {
      summary: this.summary(e),
      messages,
      partial: run ? { text: run.text, tools: run.tools, seq: run.seq } : null,
      canRetry: !this.busy(id) && e.file.messages.at(-1)?.role === 'user'
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
    this.runs.get(id)?.controller.abort()
  }

  /** Resolves once no answer is being written. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs.values()].map((r) => r.done))
  }

  /** The project closes: no new answers; sends in progress finish, then running answers stop (saved as stopped). */
  async close(): Promise<void> {
    this.closed = true
    while (this.preparing.size > 0) await Promise.allSettled([...this.preparing])
    for (const run of this.runs.values()) run.controller.abort()
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
      if (e.file.messages.at(-1)?.role !== 'user') throw new UserFacingError('invalid_edit')
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
      return { id: e.id, title: e.id, scope: 'library', paperTitle: null, paperState: null, archived: false, model: 'sonnet', updatedAt: '', costUsd: 0, messages: 0, copyOf: null, problem: true }
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
      model: meta.model,
      updatedAt: meta.updated_at,
      costUsd: meta.cost_usd,
      messages: messages.length,
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
  private async update(id: string, change: (file: ChatFile) => ChatFile): Promise<ChatFile> {
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
        updated_on: this.deps.machine
      },
      messages: [message]
    }
    return (await this.write(file, null)).meta.id
  }

  private start(id: string, reservation: Reservation): void {
    const run: Run = { controller: new AbortController(), text: '', tools: 0, seq: streamSeq, done: Promise.resolve() }
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
      const question = messages.at(-1)
      if (question?.role !== 'user') throw new UserFacingError('invalid_edit')
      model = meta.model
      paperId = meta.scope === 'library' ? '' : meta.scope.paper
      const input = chatInput({
        thesis: store.config.thesis,
        scope: meta.scope,
        paper: await this.paperContext(meta.scope),
        history: messages.slice(0, -1),
        question: question.text,
        excerpt: question.excerpt
      })
      run.controller.signal.throwIfAborted()
      const tools = await this.deps.startTools({ maxToolCalls: CHAT_MAX_TOOL_CALLS, markData: true }).catch((error: unknown) => {
        throw new UserFacingError('agent_tools_unavailable', { cause: error })
      })
      let result: ChatResult
      try {
        run.controller.signal.throwIfAborted()
        result = await provider.chat(
          {
            system: chatSystemPrompt(meta.scope),
            input,
            model: meta.model,
            maxUsd: store.config.llm.budget.per_chat_message_usd,
            servers: [{ name: MCP_SERVER_NAME, url: tools.url, token: tools.token }],
            // The server enforces the tool budget; the spare turns let a refused call still end in an answer.
            maxTurns: CHAT_MAX_TOOL_CALLS + 3,
            signal: run.controller.signal,
            timeoutMs: AGENT_TIMEOUT_MS
          },
          (event) => {
            if (event.kind === 'delta') run.text += event.text
            else if (event.kind === 'turn') run.text = ''
            else run.tools++
            this.push(id, run, event)
          }
        )
      } finally {
        await tools.close().catch(logged)
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
