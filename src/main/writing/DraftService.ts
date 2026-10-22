import { randomBytes } from 'node:crypto'
import { PAPER_KEY } from '../../shared/chat'
import { LLM_MODELS, thesisLanguage } from '../../shared/summary'
import {
  DRAFT_ID,
  DRAFT_LENGTHS,
  draftCheck,
  MAX_DRAFT_PAPERS,
  MAX_DRAFT_PURPOSE,
  MAX_DRAFT_TEXT,
  MAX_DRAFT_TITLE,
  type DraftCheck,
  type DraftFile,
  type DraftInput,
  type DraftListQuery,
  type DraftStreamEvent,
  type DraftStreamUpdate,
  type DraftSummary,
  type DraftView
} from '../../shared/writing/draft'
import type { IndexCache } from '../cache/IndexCache'
import { answerModel } from '../chats/ChatService'
import type { PaperContext } from '../chats/chatPrompt'
import { indexSources, verifyCitations } from '../chats/citations'
import { readPaperContext } from '../chats/paperContext'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { limitsFromConfig, type BudgetGuard } from '../llm/BudgetGuard'
import { runCappedOperation, type CappedDeps } from '../llm/cappedOperation'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type ChatResult, type LlmProvider } from '../llm/LlmProvider'
import { startAgentRun, type AgentRunLog } from '../log/agentLog'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import { foldQuery } from '../mcp/libraryTools'
import { newChatId } from '../project/chatFile'
import { ConflictError, type ReadResult } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { AGENT_TIMEOUT_MS } from '../relations/RelationSuggester'
import { DRAFT_MAX_TOOL_CALLS, draftInput, draftSystemPrompt } from './draftPrompt'

export interface DraftServiceDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  /** Starts the read-only MCP server for one draft, its tools limited to `papers` (closed when the draft ends). */
  startTools: (opts: LibraryMcpOptions, papers: readonly string[]) => Promise<LibraryMcpHandle>
  /** Names this machine in the files it writes (`updated_on`), so the sync can name a copy. */
  machine: string
  /** The drafts changed (the session's 'drafts' event). */
  emit: () => void
  /** A draft's progress, for the window. */
  stream: (update: DraftStreamUpdate) => void
  now?: () => Date
  /** Random hex for new ids; tests pass their own. */
  randomHex?: () => string
}

/** One draft as the index keeps it; `file` is null when the file cannot be read. */
interface Entry {
  id: string
  hash: string
  file: DraftFile | null
  /** Title, purpose and the current text, folded for search. */
  search: string
}

/** A version being written. */
interface Run {
  controller: AbortController
  /** The text of the current turn so far. */
  text: string
  tools: number
  seq: number
  done: Promise<void>
  log: AgentRunLog | null
  /** How the version ended, once `done`: stopped, or the error code the stream reported. */
  outcome?: { stopped: boolean; error: string | null }
}

const SEARCH_CHARS = 200_000
const MAX_WRITE_ATTEMPTS = 3
/** The summary field each chosen paper shows Claude: its one-liner («en pocas palabras»). */
const DRAFT_SUMMARY_FIELDS = ['tldr'] as const
const logged = (error: unknown): void => console.error('draft', error)
/** Orders stream updates across every session of the app run. */
let streamSeq = 0

function toEntry(id: string, read: ReadResult<DraftFile>): Entry {
  if (!read.ok) return { id, hash: read.hash, file: null, search: '' }
  const { meta, texts } = read.value
  const text = [meta.title, meta.purpose, texts.at(-1) ?? ''].join('\n')
  return { id, hash: read.hash, file: read.value, search: foldQuery(text.slice(0, SEARCH_CHARS)) }
}

const cleanTitle = (title: string): string => title.replace(/\s+/g, ' ').trim()

/**
 * «Borrador»: drafts/ and its index, and the versions Claude writes. A version is one confirmed, capped agent run (kind
 * `draft`) with the chat's read-only library tools limited to the chosen papers, streamed to the window and written once at the end; «Detener»
 * keeps what arrived. Every citation is checked as the chat's are, and flagged when it cites a paper outside the draft's
 * selection.
 */
export class DraftService {
  private readonly entries = new Map<string, Entry>()
  private readonly runs = new Map<string, Run>()
  /** Drafts a run is being admitted for (before its run starts). */
  private readonly sending = new Set<string>()
  private readonly preparing = new Set<Promise<unknown>>()
  private closed = false
  /** Counts the app's own writes and deletions; `changedAt` holds the count at each draft's last one. */
  private writes = 0
  private readonly changedAt = new Map<string, number>()
  /** The last write queued for each draft (see update). */
  private readonly writing = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: DraftServiceDeps) {}

  private get capped(): CappedDeps {
    const { budget, ledger, store } = this.deps
    return { budget, ledger, limits: () => limitsFromConfig(store.config.llm) }
  }

  async reindex(): Promise<void> {
    const start = this.writes
    const next = new Map<string, Entry>()
    for (const id of await this.deps.store.listDraftIds()) {
      const read = await this.deps.store.readDraft(id)
      if (read) next.set(id, toEntry(id, read))
    }
    this.replaceEntries(next, start)
  }

  /** For the watcher: true when some file differs from the index (the app's own writes are already in it). */
  async reindexIfChanged(): Promise<boolean> {
    const start = this.writes
    const ids = await this.deps.store.listDraftIds()
    let changed = ids.length !== this.entries.size
    const next = new Map<string, Entry>()
    for (const id of ids) {
      const read = await this.deps.store.readDraft(id)
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

  /** Newest first; `text` matches the title, the purpose and the current text (case, accents and whitespace ignored). */
  list(q: DraftListQuery = {}): DraftSummary[] {
    const text = q.text ? foldQuery(q.text) : ''
    return [...this.entries.values()]
      .filter((e) => !text || e.search.includes(text))
      .map((e) => this.summary(e))
      .sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? 1 : -1))
  }

  /** The draft as it is on disk now, every version's citations checked, and the version being written, if any. */
  async open(id: string): Promise<DraftView> {
    const e = await this.fresh(id)
    if (!e.file) throw new UserFacingError('draft_invalid')
    const { meta, texts } = e.file
    const run = this.runs.get(id)
    return {
      summary: this.summary(e),
      input: { title: meta.title, purpose: meta.purpose, rq: meta.rq, papers: meta.papers, length: meta.length, model: meta.model },
      versions: meta.versions.map((v, i) => ({
        at: v.at,
        model: v.model,
        costUsd: v.cost_usd,
        stopped: v.stopped,
        editedAt: v.edited_at ?? null,
        text: texts[i],
        check: this.check(texts[i], meta.papers)
      })),
      partial: run ? { text: run.text, tools: run.tools, seq: run.seq } : null
    }
  }

  /** A text's citations checked against the papers' text, and flagged when outside `papers`. */
  check(text: string, papers: readonly string[]): DraftCheck {
    return draftCheck(text, verifyCitations(text, indexSources(this.deps.cache)), papers)
  }

  /**
   * «Redactar» (a new draft, `draftId` null) or «Regenerar» (a new version of `draftId`, written from the form as it is
   * now). Resolves with the draft's id once the run is admitted and the draft written; over a cap nothing is written.
   * The caller asked the user first with `writing.plan('draft')` (the run IPC checks `confirmed`).
   */
  run(input: DraftInput, draftId: string | null): Promise<string> {
    return this.track(this.runNow(input, draftId))
  }

  /**
   * For a caller that waits for the whole version (the local API): resolves once the run of `id` ends, with how it
   * ended (the window follows the stream instead). A draft not being written resolves at once, as finished.
   */
  async finished(id: string): Promise<{ stopped: boolean; error: string | null }> {
    const run = this.runs.get(id)
    if (!run) return { stopped: false, error: null }
    await run.done
    return run.outcome ?? { stopped: false, error: null }
  }

  /** «Detener»: what arrived is kept as a stopped version. */
  stop(id: string): void {
    this.runs.get(id)?.controller.abort()
  }

  /** The user's edit of the current version (markers kept as typed); its citations checked again. */
  async edit(id: string, text: string): Promise<DraftCheck> {
    if (typeof text !== 'string' || text.length > MAX_DRAFT_TEXT) throw new UserFacingError('invalid_edit')
    if (this.busy(id)) throw new UserFacingError('draft_busy')
    const file = await this.update(id, (f) => {
      const last = f.texts.length - 1
      if (last < 0) throw new UserFacingError('invalid_edit')
      const versions = f.meta.versions.map((v, i) => (i === last ? { ...v, edited_at: this.now().toISOString() } : v))
      return { meta: { ...f.meta, versions }, texts: f.texts.map((t, i) => (i === last ? text : t)) }
    })
    return this.check(file.texts.at(-1) ?? '', file.meta.papers)
  }

  async rename(id: string, title: string): Promise<void> {
    const clean = cleanTitle(title)
    if (!clean || clean.length > MAX_DRAFT_TITLE) throw new UserFacingError('invalid_edit')
    await this.update(id, (f) => ({ ...f, meta: { ...f.meta, title: clean } }))
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.update(id, (f) => ({ ...f, meta: { ...f.meta, archived } }))
  }

  /** «Borrar»: only with `confirmed` (the user said yes to the UI's question), never while a version is written. */
  async remove(id: string, confirmed: boolean): Promise<void> {
    if (confirmed !== true) throw new UserFacingError('invalid_edit')
    if (!DRAFT_ID.test(id)) throw new UserFacingError('draft_not_found')
    if (this.busy(id)) throw new UserFacingError('draft_busy')
    const read = await this.deps.store.readDraft(id)
    if (read) await this.deps.store.deleteDraft(id, read.hash)
    this.entries.delete(id)
    this.changedAt.set(id, ++this.writes)
    this.deps.emit()
  }

  /** Resolves once no version is being written. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs.values()].map((r) => r.done))
  }

  /** The project closes: no new runs; admissions in progress finish, then running ones stop (kept as stopped). */
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

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private busy(id: string): boolean {
    return this.runs.has(id) || this.sending.has(id)
  }

  /** The form as a draft keeps it, or invalid_edit; every chosen paper must be in the library now. */
  private cleanInput(input: DraftInput): DraftInput {
    const title = cleanTitle(String(input.title ?? ''))
    const purpose = String(input.purpose ?? '').trim()
    const papers = [...new Set(input.papers)]
    if (!title || title.length > MAX_DRAFT_TITLE || purpose.length > MAX_DRAFT_PURPOSE) throw new UserFacingError('invalid_edit')
    if (!(DRAFT_LENGTHS as readonly string[]).includes(input.length) || !(LLM_MODELS as readonly string[]).includes(input.model)) throw new UserFacingError('invalid_edit')
    if (papers.length === 0 || papers.length > MAX_DRAFT_PAPERS || papers.some((p) => !PAPER_KEY.test(p))) throw new UserFacingError('invalid_edit')
    const rq = input.rq ?? null
    if (rq !== null && !this.deps.store.config.thesis.research_questions.some((q) => q.id === rq)) throw new UserFacingError('invalid_edit')
    if (papers.some((p) => indexSources(this.deps.cache).paperState(p) !== 'library')) throw new UserFacingError('paper_not_in_library')
    return { title, purpose, rq, papers, length: input.length, model: input.model }
  }

  private async runNow(raw: DraftInput, draftId: string | null): Promise<string> {
    if (this.closed) throw new UserFacingError('draft_busy')
    if (draftId !== null && !DRAFT_ID.test(draftId)) throw new UserFacingError('draft_not_found')
    if (draftId !== null && this.busy(draftId)) throw new UserFacingError('draft_busy')
    const input = this.cleanInput(raw)
    if (draftId !== null) {
      const e = await this.fresh(draftId)
      if (!e.file) throw new UserFacingError('draft_invalid')
    }
    const id = draftId ?? newChatId(this.now(), this.deps.randomHex?.() ?? randomBytes(2).toString('hex'))
    this.sending.add(id)
    const run: Run = { controller: new AbortController(), text: '', tools: 0, seq: streamSeq, done: Promise.resolve(), log: null }
    let admitted!: () => void
    let refused!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      admitted = resolve
      refused = reject
    })
    let started = false
    run.done = this.write(id, run, input, draftId === null, () => {
      started = true
      this.runs.set(id, run)
      this.sending.delete(id)
      admitted()
    })
      .catch((error: unknown) => {
        if (!started) refused(error)
      })
      .finally(() => {
        this.sending.delete(id)
        if (this.runs.get(id) === run) this.runs.delete(id)
      })
    await ready
    return id
  }

  private push(id: string, run: Run, event: DraftStreamEvent): void {
    run.seq = ++streamSeq
    try {
      this.deps.stream({ ...event, draftId: id, seq: run.seq })
    } catch (error) {
      logged(error)
    }
  }

  /**
   * One version: admitted under the draft cap; the draft's form written (a new draft created) once admitted, then the
   * agent run streamed and the version appended at the end. Rejects only before `started` (admission or the form's
   * write): after it every failure is reported on the stream.
   */
  private async write(id: string, run: Run, input: DraftInput, create: boolean, started: () => void): Promise<void> {
    const { store, provider } = this.deps
    let begun = false
    try {
      const result = await runCappedOperation<ChatResult>(this.capped, { kind: 'draft', model: input.model }, async (maxUsd) => {
        if (create) await this.create(id, input)
        else await this.update(id, (f) => ({ ...f, meta: { ...f.meta, ...input } }))
        begun = true
        started()
        this.push(id, run, { kind: 'start' })
        const papers: PaperContext[] = []
        const missing: string[] = []
        for (const key of input.papers) {
          const p = await readPaperContext(store, key, DRAFT_SUMMARY_FIELDS)
          if (p) papers.push({ ...p, abstract: null })
          else missing.push(key)
        }
        const thesis = store.config.thesis
        const rq = thesis.research_questions.find((q) => q.id === input.rq) ?? null
        run.controller.signal.throwIfAborted()
        const maxTurns = DRAFT_MAX_TOOL_CALLS + 3
        const log = startAgentRun({ kind: 'draft', subject: id, model: input.model, capUsd: maxUsd, maxTurns, ids: { papers: input.papers.length } })
        run.log = log
        const tools = await this.deps.startTools({ maxToolCalls: DRAFT_MAX_TOOL_CALLS, markData: true, log }, input.papers).catch((error: unknown) => {
          throw new UserFacingError('agent_tools_unavailable', { cause: error })
        })
        try {
          run.controller.signal.throwIfAborted()
          return await provider.chat(
            {
              system: draftSystemPrompt(thesisLanguage(thesis), input.length),
              input: draftInput({ thesis, title: input.title, purpose: input.purpose, rq, papers, missing, length: input.length }),
              model: input.model,
              maxUsd,
              servers: [{ name: MCP_SERVER_NAME, url: tools.url, token: tools.token }],
              maxTurns,
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
      })
      const text = (result.text.trim() || run.text.trim()).slice(0, MAX_DRAFT_TEXT)
      if (!text) throw new LlmError('llm_invalid_output', 0)
      await this.appendVersion(id, { at: this.now().toISOString(), model: answerModel(result.model), cost_usd: result.costUsd, stopped: false }, text)
      run.log?.end({ costUsd: result.costUsd, turns: result.turns })
      run.outcome = { stopped: false, error: null }
      this.push(id, run, { kind: 'done' })
    } catch (error) {
      if (!begun) throw error
      // The cost is in the ledger already (runCappedOperation logged it, at its cap when the run was cut off).
      const charge = failedCallCost(error)
      run.log?.fail(run.controller.signal.aborted ? new DOMException('Stopped', 'AbortError') : error, charge)
      if (run.controller.signal.aborted) {
        const text = run.text.trim()
        if (text) await this.appendVersion(id, { at: this.now().toISOString(), model: answerModel(input.model), cost_usd: charge.costUsd, stopped: true }, text).catch(logged)
        run.outcome = { stopped: true, error: null }
        this.push(id, run, { kind: 'stopped' })
      } else {
        const code = toUserFacing(error).code
        // The CLI's cap here is the per-draft one, which has its own setting.
        run.outcome = { stopped: false, error: code === 'operation_budget' ? 'draft_budget' : code }
        this.push(id, run, { kind: 'error', error: run.outcome.error! })
      }
    }
  }

  private async appendVersion(id: string, version: DraftFile['meta']['versions'][number], text: string): Promise<void> {
    await this.update(id, (f) => ({ meta: { ...f.meta, versions: [...f.meta.versions, version] }, texts: [...f.texts, text] }))
  }

  /**
   * Installs a scan that started when the write count was `start`; a draft the app wrote or deleted since keeps its
   * current entry (or absence), so a scan never puts back a version older than the app's own write.
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

  private summary(e: Entry): DraftSummary {
    if (!e.file) return { id: e.id, title: e.id, archived: false, updatedAt: '', costUsd: 0, versions: 0, papers: 0, copyOf: null, problem: true }
    const { meta } = e.file
    return {
      id: e.id,
      title: meta.title,
      archived: meta.archived,
      updatedAt: meta.updated_at,
      costUsd: meta.cost_usd,
      versions: meta.versions.length,
      papers: meta.papers.length,
      copyOf: meta.copy_of ? { machine: meta.copy_of.machine } : null,
      problem: false
    }
  }

  /** The file as it is on disk now (the watcher may not have reported a change yet), kept in the index. */
  private async fresh(id: string): Promise<Entry> {
    if (!DRAFT_ID.test(id)) throw new UserFacingError('draft_not_found')
    const read = await this.deps.store.readDraft(id)
    if (!read) {
      if (this.entries.delete(id)) this.deps.emit()
      throw new UserFacingError('draft_not_found')
    }
    const known = this.entries.get(id)
    if (known && known.hash === read.hash) return known
    const e = toEntry(id, read)
    this.entries.set(id, e)
    this.deps.emit()
    return e
  }

  /** Writes a draft (`expectedHash` null creates it) stamped with this machine and the time; the index keeps what the file holds. */
  private async writeFile(file: DraftFile, expectedHash: string | null): Promise<DraftFile> {
    const stamped: DraftFile = { ...file, meta: { ...file.meta, updated_at: this.now().toISOString(), updated_on: this.deps.machine } }
    const hash = await this.deps.store.writeDraft(stamped, expectedHash)
    const read = await this.deps.store.readDraft(stamped.meta.id)
    const entry = read && read.hash === hash ? toEntry(stamped.meta.id, read) : toEntry(stamped.meta.id, { ok: true, hash, value: stamped })
    this.entries.set(stamped.meta.id, entry)
    this.changedAt.set(stamped.meta.id, ++this.writes)
    this.deps.emit()
    return entry.file ?? stamped
  }

  /** Read, change and write one draft, one write at a time; read again and redo the change on a concurrent write (at most 3 times). */
  private update(id: string, change: (file: DraftFile) => DraftFile): Promise<DraftFile> {
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

  private async updateNow(id: string, change: (file: DraftFile) => DraftFile): Promise<DraftFile> {
    for (let attempt = 1; ; attempt++) {
      const e = await this.fresh(id)
      if (!e.file) throw new UserFacingError('draft_invalid')
      try {
        return await this.writeFile(change(e.file), e.hash)
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= MAX_WRITE_ATTEMPTS) throw error
      }
    }
  }

  /** A new draft with no version yet; a taken id (practically impossible) is a ConflictError, never an overwrite. */
  private async create(id: string, input: DraftInput): Promise<void> {
    const at = this.now().toISOString()
    await this.writeFile(
      {
        meta: {
          schema_version: 1,
          id,
          ...input,
          created_at: at,
          updated_at: at,
          archived: false,
          cost_usd: 0,
          versions: [],
          updated_on: this.deps.machine
        },
        texts: []
      },
      null
    )
  }
}
