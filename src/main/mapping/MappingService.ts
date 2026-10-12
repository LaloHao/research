import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { JobSpec } from '../../shared/jobs'
import {
  MAIN_REVIEWER,
  MAPPING_ID,
  ProtocolDraftSchema,
  SEARCH_CAP,
  SearchSchema,
  SNOWBALL_CAP,
  type DecideRequest,
  type Decision,
  type ImportOutcome,
  type ImportSource,
  type IngestPlan,
  type MappingRecord,
  type MappingRecordRow,
  type MappingSummary,
  type MappingView,
  type OpenAlexSearchRequest,
  type Phase,
  type ProtocolDraft,
  type QueueQuery,
  type ScreeningPlan,
  type ScreeningSuggestion,
  type Search,
  type SnowballDirection,
  type WorkCandidate
} from '../../shared/mapping'
import type { Paper } from '../../shared/schemas'
import type { CostOperation, LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { ResolvedMetadata } from '../ingest/types'
import { findDuplicate, type DedupeEntry } from '../library/dedupe'
import type { IngestOutcome } from '../library/LibraryService'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { operationCap, type BudgetLimits } from '../llm/BudgetGuard'
import { ConflictError, type ReadResult } from '../project/errors'
import { EMPTY_MAPPING_LISTS, MAPPING_FILE_KINDS, MAPPING_FILE_NAMES, newMappingId, type MappingFileKind, type MappingFiles } from '../project/mappingFiles'
import type { ProjectStore } from '../project/ProjectStore'
import { cleanIdentifiers, mergeCandidate, newRecord, RecordMatcher, recordIdFor, recordKey, syncDuplicates } from './dedup'
import { decodeExport, MAX_EXPORT_BYTES, parseExport } from './importers/importFile'
import { openAlexFilter, type OpenAlexSearch } from './OpenAlexSearch'
import { prismaCounts } from './prisma'
import { applyDraft, newProtocol } from './protocol'
import type { ScreeningSuggester, SuggestedScreening } from './ScreeningSuggester'
import { MAX_RECORDS_PER_CALL, SCREENING_PROMPT_VERSION } from './screeningPrompt'
import {
  activeSearchIds,
  carriedDecisions,
  conflictsOf,
  decisionHeads,
  decisionProblem,
  duplicatePairs,
  headsOf,
  latestSuggestions,
  matchesFilter,
  phaseView,
  recordRows,
  screeningCounts,
  undoDecision,
  type MappingContent
} from './screening'

export interface MappingServiceDeps {
  store: ProjectStore
  cache: IndexCache
  /** A mapping changed (the window reloads it). */
  emit: () => void
  /** Names this machine on searches and decisions. */
  machine: string
  now?: () => Date
  /** Random hex digits for new ids; tests pass a counter. */
  randomHex?: (digits: number) => string
  /** The usual ingest. */
  library: {
    ingestIdentifier(input: string, signal?: AbortSignal): Promise<IngestOutcome>
    ingestMetadata(meta: ResolvedMetadata, signal?: AbortSignal): Promise<IngestOutcome>
  }
  openalex: OpenAlexSearch
  /** 3a citations: a paper's references (written into paper.yaml) and the works citing it (the cache). */
  citations: { fetch(paperId: string, signal?: AbortSignal): Promise<unknown>; fetchCitedBy(paperId: string, signal?: AbortSignal): Promise<unknown> }
  suggester: Pick<ScreeningSuggester, 'titleAbstract' | 'fullText'>
  /** Learned estimates, caps and the month's spending, for the plans. */
  costs: { estimate(operation: CostOperation): number; limits(): BudgetLimits; monthSpent(): Promise<number> }
  /** Queues a job; returns its id. Jobs never queue themselves: the window asks after the user confirms. */
  enqueue: (spec: JobSpec) => number
  /** Cancels the queued jobs of a batch (a «Sugerir» that hit a cap or the CLI quota stops there). */
  cancelBatch: (batchId: string) => number
  /** Pause before each OpenAlex request; tests pass 0. */
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** A mapping's files as read, each with the hash of its text (null: not written yet; it reads as empty). */
export type LoadedMapping = { [K in MappingFileKind]: { value: MappingFiles[K]; hash: string | null } }

/** A search as its caller describes it; the service adds its id, date, machine and (unless given) its count. */
export type NewSearch = Partial<Omit<Search, 'id' | 'at' | 'machine' | 'kind' | 'database'>> & Pick<Search, 'kind' | 'database'>

type Write = { [K in MappingFileKind]: { kind: K; file: MappingFiles[K] } }[MappingFileKind]

interface Load {
  files: LoadedMapping | null
  /** File name → hash, for every file that exists (also when it does not read). */
  hashes: Record<string, string>
  problem: 'mapping_not_found' | 'mapping_invalid' | null
  title: string | null
}

/** An export bigger than this is refused (`file_too_large`). */
export const MAX_IMPORT_BYTES = MAX_EXPORT_BYTES

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort()

function contentOf(files: LoadedMapping): MappingContent {
  return {
    protocol: files.protocol.value,
    searches: files.searches.value.searches,
    records: files.records.value.records,
    decisions: files.decisions.value.decisions,
    suggestions: files.suggestions.value.suggestions
  }
}

/**
 * Screening started once anything was decided or suggested: a protocol edit from then on is a new version, so the
 * suggestions made before it show as outdated, with the wording they were made with, and can be asked for again.
 */
function screeningStarted(files: LoadedMapping): boolean {
  return files.decisions.value.decisions.length > 0 || files.suggestions.value.suggestions.length > 0
}

/** The latest date any file of the mapping records (for the list's order). */
function lastChange(c: MappingContent): string {
  const dates = [
    c.protocol.updated_at,
    ...c.searches.map((s) => s.discarded?.at ?? s.at),
    ...c.records.map((r) => r.updated_at),
    ...c.decisions.map((d) => d.at),
    ...c.suggestions.map((s) => s.at)
  ]
  return dates.reduce((a, b) => (b > a ? b : a))
}

/**
 * Pairs among the active records (not merged, brought by a live search) that entry could not compare: two machines
 * added one work under different ids and the sync kept both. Keyed by the newer record of each pair.
 */
function syncPairs(c: MappingContent): Map<string, ReturnType<typeof syncDuplicates>[number]> {
  const live = activeSearchIds(c.searches)
  const active = c.records.filter((r) => r.merged_into === null && r.sources.some((s) => live.has(s)))
  return new Map(syncDuplicates(active).map((x) => [x.record, x]))
}

/** Rows of the records a sync joined are marked as possible duplicates, with the reason the matcher gives. */
function withSyncDuplicates(rows: MappingRecordRow[], c: MappingContent): MappingRecordRow[] {
  const pairs = syncPairs(c)
  return rows.map((row) => {
    const pair = pairs.get(row.id)
    return pair && !row.duplicate ? { ...row, duplicate: { of: pair.other, reason: pair.reason } } : row
  })
}

/**
 * Live searches whose `count` is lower than the records (not merged into another) that name them. Every candidate a
 * search read gives its id to one record, and «Es el mismo» moves it from the merged record to the surviving one, so
 * only a hand-edited file breaks this.
 */
function inconsistentSearches(c: MappingContent): string[] {
  const holding = new Map<string, number>()
  for (const r of c.records) if (r.merged_into === null) for (const s of new Set(r.sources)) holding.set(s, (holding.get(s) ?? 0) + 1)
  return c.searches.filter((s) => !s.discarded && s.count < (holding.get(s.id) ?? 0)).map((s) => s.id)
}

/** The record `id` resolves to through its `merged_into` chain (itself when not merged); null when the chain breaks or loops. */
function survivor(records: Map<string, MappingRecord>, id: string): MappingRecord | null {
  let cur = records.get(id)
  for (let steps = 0; cur?.merged_into; steps++) {
    if (steps > records.size) return null
    cur = records.get(cur.merged_into)
  }
  return cur ?? null
}

/**
 * The library paper a new record is, by DOI, arXiv id or title. A title alone never links a record and a paper whose
 * DOIs differ (a journal version and the library's preprint, say): that link is left for the user.
 */
function libraryPaper(c: WorkCandidate, library: DedupeEntry[]): string | null {
  const ids = cleanIdentifiers(c.identifiers)
  const query = { doi: ids.doi, arxiv: ids.arxiv, title: c.title }
  const found = findDuplicate(query, library)
  if (!found || found.reason !== 'title' || !ids.doi) return found?.id ?? null
  const doi = ids.doi.toLowerCase()
  return findDuplicate(query, library.filter((e) => !e.doi || e.doi.toLowerCase() === doi))?.id ?? null
}

function fromPaper(p: Paper): WorkCandidate {
  return {
    title: p.title,
    authors: p.authors,
    year: p.year ?? null,
    venue: p.venue ?? null,
    abstract: p.abstract ?? null,
    kind: p.kind,
    identifiers: { doi: p.identifiers.doi, arxiv: p.identifiers.arxiv, openalex: p.identifiers.openalex ?? p.citations?.openalex_id },
    paperId: p.id
  }
}

/** A record as ingest metadata: what an export or OpenAlex gave, never claimed complete. */
function recordMetadata(r: MappingRecord): ResolvedMetadata {
  const ids = cleanIdentifiers(r.identifiers)
  return {
    kind: r.kind ?? 'other',
    title: r.title,
    authors: r.authors,
    year: r.year ?? undefined,
    venue: r.venue ?? undefined,
    abstract: r.abstract ?? undefined,
    identifiers: { ...(ids.doi ? { doi: ids.doi } : {}), ...(ids.arxiv ? { arxiv: ids.arxiv } : {}), ...(ids.openalex ? { openalex: ids.openalex } : {}) },
    complete: false
  }
}

function recordCandidate(r: MappingRecord): WorkCandidate {
  return { title: r.title, authors: r.authors, year: r.year, venue: r.venue, abstract: r.abstract, kind: r.kind, identifiers: r.identifiers }
}

/** `publication_year:>2014,type:article` as the log keeps it: `{ publication_year: '>2014', type: 'article' }`. */
function filtersOf(filter: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (filter ?? '').split(',')) {
    const at = part.indexOf(':')
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1)
  }
  return out
}

/** Failures that would fail every remaining call of a batch too. */
const BATCH_STOPPERS = new Set(['llm_quota', 'budget_exceeded'])

type Spec<T extends JobSpec['type']> = Extract<JobSpec, { type: T }>

/** Systematic mappings: protocol, search log, records, screening and their index. Every write goes through ProjectStore. */
export class MappingService {
  private readonly runs = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: MappingServiceDeps) {}

  /** Indexes every mapping on disk and forgets mappings no longer there (opening the project). */
  async reindexAll(): Promise<void> {
    const ids = await this.deps.store.listMappingIds()
    for (const id of this.deps.cache.mappingIds()) if (!ids.includes(id)) await this.serial(id, async () => this.deps.cache.removeMapping(id))
    for (const id of ids) await this.serial(id, async () => this.index(id, await this.load(id)))
  }

  /** For the watcher: re-indexes when a file differs from the indexed one, so our own writes do nothing. True when it changed. */
  reindexIfChanged(id: string): Promise<boolean> {
    if (!MAPPING_ID.test(id)) return Promise.resolve(false)
    return this.serial(id, async () => {
      const { store, cache } = this.deps
      if (!store.mappingExists(id)) {
        const indexed = cache.mappingFileHashes(id) !== null
        cache.removeMapping(id)
        return indexed
      }
      const loaded = await this.load(id)
      if (isDeepStrictEqual(cache.mappingFileHashes(id), loaded.hashes)) return false
      this.index(id, loaded)
      return true
    })
  }

  list(): MappingSummary[] {
    return this.deps.cache.mappingSummaries()
  }

  /** «Nuevo mapeo»: a folder with only its protocol. A folder of the same name created meanwhile gets another id. */
  async create(title: string): Promise<string> {
    const at = this.now()
    const protocol = newProtocol(title, at.toISOString())
    for (let attempt = 0; ; attempt++) {
      const id = newMappingId(at, this.hex(4))
      try {
        await this.deps.store.writeMappingFile(id, 'protocol', protocol, null)
      } catch (error) {
        if (error instanceof ConflictError && attempt < 2) continue
        throw error
      }
      await this.serial(id, async () => this.index(id, await this.load(id)))
      this.deps.emit()
      return id
    }
  }

  /** The mapping as the window shows it: its protocol, its log (newest first), PRISMA, counts, duplicates and conflicts. */
  open(id: string): Promise<MappingView> {
    if (!MAPPING_ID.test(id)) return Promise.reject(new UserFacingError('mapping_not_found'))
    return this.serial(id, async () => {
      const loaded = await this.load(id)
      if (!isDeepStrictEqual(this.deps.cache.mappingFileHashes(id), loaded.hashes)) this.index(id, loaded)
      const files = this.required(loaded)
      const rows = this.deps.cache.mappingRows(id)
      const state = this.deps.cache.mappingState(id)
      if (!state) throw new UserFacingError('mapping_invalid')
      return {
        id,
        protocol: files.protocol.value,
        searches: [...files.searches.value.searches].reverse(),
        prisma: state.prisma,
        counts: state.counts,
        duplicates: duplicatePairs(rows),
        conflicts: conflictsOf(rows),
        screeningStarted: screeningStarted(files),
        inconsistentSearches: inconsistentSearches(contentOf(files))
      }
    })
  }

  /** «Guardar protocolo»; `version` is the one the window edited (a newer one on disk is a conflict). */
  async saveProtocol(id: string, draft: ProtocolDraft, version: number): Promise<void> {
    const parsed = ProtocolDraftSchema.safeParse(draft)
    if (!parsed.success) throw new UserFacingError('invalid_edit')
    await this.mutate(id, (files) => {
      const current = files.protocol.value
      if (current.version !== version) throw new UserFacingError('conflict')
      const next = applyDraft(current, parsed.data, { screeningStarted: screeningStarted(files), now: this.now().toISOString() })
      return { writes: next === current ? [] : [{ kind: 'protocol', file: next }], result: undefined }
    })
  }

  /**
   * «Importar»: a BibTeX, RIS or CSV export the user picked, logged with the database and the string used there. An
   * export with more entries than the app reads is logged as `capped` and the outcome says `truncated`.
   */
  async importFile(id: string, path: string, source: ImportSource): Promise<ImportOutcome> {
    const database = source.database.trim()
    if (!database) throw new UserFacingError('invalid_edit')
    let bytes: Uint8Array
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new UserFacingError('import_unreadable')
      if (info.size > MAX_EXPORT_BYTES) throw new UserFacingError('file_too_large')
      bytes = await readFile(path)
    } catch (error) {
      if (error instanceof UserFacingError) throw error
      throw new UserFacingError('import_unreadable', { cause: error })
    }
    // The file may have grown between the size check and the read.
    if (bytes.byteLength > MAX_EXPORT_BYTES) throw new UserFacingError('file_too_large')
    const file = basename(path)
    const parsed = parseExport(file, decodeExport(bytes))
    if (!parsed || parsed.records.length === 0) throw new UserFacingError('import_unreadable')
    const outcome = await this.addSearch(
      id,
      { kind: 'import', database, query: source.query.trim() || null, file, format: parsed.format, skipped: parsed.skipped, capped: parsed.truncated === true },
      parsed.records
    )
    return parsed.truncated ? { ...outcome, truncated: true } : outcome
  }

  /** «Desde la biblioteca»: library papers as records, linked to them. */
  async addFromLibrary(id: string, paperIds: string[]): Promise<ImportOutcome> {
    const candidates: WorkCandidate[] = []
    for (const paperId of [...new Set(paperIds)]) {
      if (!this.deps.store.paperExists(paperId)) continue
      const read = await this.deps.store.readPaper(paperId)
      if (read.ok) candidates.push(fromPaper(read.value))
    }
    if (candidates.length === 0) throw new UserFacingError('file_problem')
    return this.addSearch(id, { kind: 'library', database: 'library' }, candidates)
  }

  /**
   * Logs a search and adds what it found: a work already among the records only gains the search as a source (and the
   * fields it lacked); a new one becomes a record, linked to its library paper when there is one, and marked as a
   * possible duplicate when it looks like another record. Records are written before the search, so an interruption
   * never leaves a logged search without its records. The search's `count` is never below the candidates it read.
   */
  async addSearch(id: string, search: NewSearch, candidates: WorkCandidate[]): Promise<ImportOutcome> {
    const searchId = this.newId('s')
    const at = this.now().toISOString()
    const library = this.deps.cache.dedupeEntries()
    const entry = SearchSchema.parse({ ...search, id: searchId, at, machine: this.deps.machine, count: Math.max(typeof search.count === 'number' ? search.count : 0, candidates.length) })
    // A record key is random for a weak title: derived once per candidate, so a retry gives the same new ids.
    const keys = new Map<number, string>()
    const keyOf = (i: number): string => {
      let key = keys.get(i)
      if (key === undefined) keys.set(i, (key = recordKey(candidates[i])))
      return key
    }
    return this.mutate(id, (files) => {
      const records = new Map(files.records.value.records.map((r) => [r.id, r]))
      const matcher = new RecordMatcher(records.values())
      const outcome: ImportOutcome = { read: candidates.length, added: 0, merged: 0, linked: 0, doubtful: 0, skipped: entry.skipped }
      candidates.forEach((c, i) => {
        const match = matcher.match(c)
        if (match?.kind === 'same') {
          records.set(match.record, mergeCandidate(records.get(match.record)!, c, searchId, at))
          outcome.merged++
          return
        }
        const paperId = c.paperId ?? libraryPaper(c, library)
        const record = newRecord(c, {
          id: recordIdFor(keyOf(i), (x) => records.has(x)),
          searchId,
          at,
          paperId,
          duplicate: match ? { record: match.record, reason: match.reason } : null
        })
        records.set(record.id, record)
        matcher.add(record)
        outcome.added++
        if (match) outcome.doubtful++
        if (paperId) outcome.linked++
      })
      const searches = files.searches.value.searches
      const writes: Write[] = [{ kind: 'records', file: { ...files.records.value, records: [...records.values()] } }]
      if (!searches.some((s) => s.id === searchId)) writes.push({ kind: 'searches', file: { ...files.searches.value, searches: [...searches, entry] } })
      return { writes, result: outcome }
    })
  }

  /** A search is never removed: «Descartar» marks it with a reason, and the records only it brought leave the screening. */
  async discardSearch(id: string, searchId: string, reason: string): Promise<void> {
    const text = reason.trim()
    if (!text) throw new UserFacingError('invalid_edit')
    await this.mutate(id, (files) => {
      const searches = files.searches.value.searches
      const search = searches.find((s) => s.id === searchId)
      if (!search) throw new UserFacingError('mapping_not_found')
      if (search.discarded) return { writes: [], result: undefined }
      const discarded = { at: this.now().toISOString(), reason: text, machine: this.deps.machine }
      return { writes: [{ kind: 'searches', file: { ...files.searches.value, searches: searches.map((s) => (s.id === searchId ? { ...s, discarded } : s)) } }], result: undefined }
    })
  }

  /**
   * «Es el mismo»: the record is merged into the one it duplicates (or the record that one was merged into since),
   * which takes its sources, the fields it lacked, its library link, its «Son distintos» answers and its current
   * decisions (`carriedDecisions`: a disagreement shows as a conflict). «Son distintos»: each names the other as
   * distinct, and neither is asked about again. The pair is read again from the files: when it is no longer the one
   * the window showed (another machine answered meanwhile), nothing is written (`conflict`).
   */
  async resolveDuplicate(id: string, recordId: string, same: boolean): Promise<void> {
    const shown = this.deps.cache.mappingRow(id, recordId)?.duplicate?.of ?? null
    const at = this.now().toISOString()
    await this.mutate(id, (files) => {
      const content = contentOf(files)
      const records = new Map(content.records.map((r) => [r.id, r]))
      const record = records.get(recordId)
      if (!record || record.merged_into) throw new UserFacingError('mapping_not_found')
      const pairOf = record.duplicate_of?.record ?? syncPairs(content).get(record.id)?.other ?? null
      if (!pairOf) throw new UserFacingError(shown ? 'conflict' : 'mapping_not_found')
      if (shown && shown !== pairOf) throw new UserFacingError('conflict')
      const other = survivor(records, pairOf)
      if (!other || other.id === record.id) throw new UserFacingError('mapping_not_found')
      if (record.distinct_from.includes(other.id) || other.distinct_from.includes(record.id)) throw new UserFacingError('conflict')
      const writes: Write[] = []
      if (same) {
        const carried = carriedDecisions(content.decisions, record.id, other.id)
        if (carried.length > 0) writes.push({ kind: 'decisions', file: { ...files.decisions.value, decisions: [...content.decisions, ...carried] } })
        records.set(other.id, {
          ...other,
          sources: union(other.sources, record.sources),
          authors: other.authors.length > 0 ? other.authors : record.authors,
          year: other.year ?? record.year,
          venue: other.venue ?? record.venue,
          abstract: other.abstract ?? record.abstract,
          kind: other.kind ?? record.kind,
          identifiers: { ...cleanIdentifiers(record.identifiers), ...other.identifiers },
          paper_id: other.paper_id ?? record.paper_id,
          // Its «Son distintos» answers, from either side of each pair.
          distinct_from: union(other.distinct_from, [...record.distinct_from, ...content.records.filter((r) => r.distinct_from.includes(record.id)).map((r) => r.id)]).filter(
            (x) => x !== other.id && x !== record.id
          ),
          updated_at: at
        })
        records.set(record.id, { ...record, merged_into: other.id, duplicate_of: null, updated_at: at })
      } else {
        records.set(record.id, { ...record, duplicate_of: null, distinct_from: union(record.distinct_from, [other.id]), updated_at: at })
        records.set(other.id, { ...other, distinct_from: union(other.distinct_from, [record.id]), updated_at: at })
      }
      // Decisions first: an interruption never leaves a merged record whose decisions the survivor lacks.
      writes.push({ kind: 'records', file: { ...files.records.value, records: [...records.values()] } })
      return { writes, result: undefined }
    })
  }

  /** A phase's queue under a filter, in record order, from the index. */
  queue(id: string, query: QueueQuery): MappingRecordRow[] {
    return this.deps.cache.mappingRows(id).filter((row) => matchesFilter(row, query.phase, query.filter))
  }

  /**
   * «Incluir», «Excluir» (with its criterion), «Dudoso», «No se pudo conseguir», or «Aceptar sugerencia» (the suggestion
   * exactly as it is): a new decision replacing the current ones of the record and phase. The same decision already
   * current writes nothing. A record waiting for «Es el mismo» or «Son distintos», merged into another, or brought only
   * by discarded searches is not decided (`not_eligible`). Returns the current decision's id, which «Deshacer» sends back.
   */
  decide(id: string, req: DecideRequest): Promise<string> {
    const at = this.now().toISOString()
    const decisionId = this.newId('d')
    return this.mutate(id, (files) => {
      const content = contentOf(files)
      const { protocol, searches, records, decisions, suggestions } = content
      const record = records.find((r) => r.id === req.recordId)
      if (!record) throw new UserFacingError('mapping_not_found')
      const live = activeSearchIds(searches)
      if (record.merged_into || !record.sources.some((s) => live.has(s))) throw new UserFacingError('not_eligible')
      if (record.duplicate_of || syncPairs(content).has(record.id)) throw new UserFacingError('not_eligible')
      const heads = decisionHeads(decisions)
      const titleAbstract = phaseView(headsOf(heads, record.id, 'title_abstract'), protocol.version).state
      const problem = decisionProblem(req, protocol, titleAbstract)
      if (problem) throw new UserFacingError(problem)
      if (req.suggestionId !== null) {
        const s = suggestions.find((x) => x.id === req.suggestionId)
        if (!s || s.record !== record.id || s.phase !== req.phase || s.decision !== req.decision || s.criterion !== req.criterion) throw new UserFacingError('invalid_edit')
      }
      const by = req.suggestionId === null ? 'user' : 'suggestion'
      const current = headsOf(heads, record.id, req.phase)
      const only = current.length === 1 ? current[0] : null
      if (
        only &&
        only.decision === req.decision &&
        only.criterion === req.criterion &&
        only.by === by &&
        only.suggestion === req.suggestionId &&
        only.protocol_version === protocol.version
      ) {
        return { writes: [], result: only.id }
      }
      const decision: Decision = {
        id: decisionId,
        record: record.id,
        phase: req.phase,
        reviewer: MAIN_REVIEWER,
        decision: req.decision,
        criterion: req.criterion,
        note: null,
        by,
        suggestion: req.suggestionId,
        protocol_version: protocol.version,
        at,
        machine: this.deps.machine,
        replaces: current.map((d) => d.id),
        undoes: null
      }
      return { writes: [{ kind: 'decisions', file: { ...files.decisions.value, decisions: [...decisions, decision] } }], result: decisionId }
    })
  }

  /**
   * «Deshacer»: appends a decision restoring the one `decisionId` replaced (or none), while `decisionId` is still the
   * only current decision of its record and phase and did not resolve a conflict (`undo_unavailable` otherwise).
   */
  undo(id: string, decisionId: string): Promise<void> {
    const ctx = { id: this.newId('d'), at: this.now().toISOString(), machine: this.deps.machine }
    return this.mutate(id, (files) => {
      const decisions = files.decisions.value.decisions
      const next = undoDecision(decisions, decisionId, ctx)
      if (!next) throw new UserFacingError('undo_unavailable')
      return { writes: [{ kind: 'decisions', file: { ...files.decisions.value, decisions: [...decisions, next] } }], result: undefined }
    })
  }

  /**
   * «Quedarme con esta»: a decision equal to the one kept (its value, criterion, author, suggestion and protocol
   * version), replacing every disagreeing current decision. `conflict` when there is no such conflict any more.
   */
  resolveConflict(id: string, recordId: string, phase: Phase, keepDecisionId: string): Promise<void> {
    const ctx = { id: this.newId('d'), at: this.now().toISOString(), machine: this.deps.machine }
    return this.mutate(id, (files) => {
      const content = contentOf(files)
      const record = content.records.find((r) => r.id === recordId)
      if (!record) throw new UserFacingError('mapping_not_found')
      // As `decide`: a record waiting for a duplicate answer (or merged) is settled there first.
      if (record.merged_into || record.duplicate_of || syncPairs(content).has(record.id)) throw new UserFacingError('not_eligible')
      const decisions = content.decisions
      const heads = headsOf(decisionHeads(decisions), recordId, phase)
      const keep = heads.find((d) => d.id === keepDecisionId)
      if (!keep || heads.every((d) => d.decision === keep.decision && d.criterion === keep.criterion)) throw new UserFacingError('conflict')
      const resolved: Decision = {
        id: ctx.id,
        record: keep.record,
        phase: keep.phase,
        reviewer: keep.reviewer,
        decision: keep.decision,
        criterion: keep.criterion,
        note: null,
        by: keep.by,
        suggestion: keep.suggestion,
        protocol_version: keep.protocol_version,
        at: ctx.at,
        machine: ctx.machine,
        replaces: heads.map((d) => d.id),
        undoes: null
      }
      return { writes: [{ kind: 'decisions', file: { ...files.decisions.value, decisions: [...decisions, resolved] } }], result: undefined }
    })
  }

  /** «Buscar en OpenAlex»: a job; the search is logged when it ends. */
  requestSearch(id: string, req: OpenAlexSearchRequest): number {
    if (!this.deps.store.mappingExists(id)) throw new UserFacingError('mapping_not_found')
    const query = req.query.trim()
    if (!query) throw new UserFacingError('invalid_edit')
    if (req.fromYear !== null && req.toYear !== null && req.fromYear > req.toYear) throw new UserFacingError('invalid_edit')
    const cap = Number.isFinite(req.cap) ? Math.round(req.cap) : SEARCH_CAP.default
    return this.deps.enqueue({
      type: 'mapping_search',
      mappingId: id,
      query,
      fromYear: req.fromYear,
      toYear: req.toYear,
      types: [...new Set(req.types)],
      cap: Math.max(1, Math.min(cap, SEARCH_CAP.max))
    })
  }

  /** Every page of results up to the cap, then one log entry with the exact string, filters, request and counts. */
  async runSearch(spec: Spec<'mapping_search'>, signal: AbortSignal): Promise<{ message: 'mapping_searched' }> {
    try {
      const { openalex } = this.deps
      const filter = openAlexFilter(spec)
      await this.pause()
      signal.throwIfAborted()
      const found = await openalex.search(spec.query, filter, spec.cap, signal)
      signal.throwIfAborted()
      await this.addSearch(
        spec.mappingId,
        {
          kind: 'openalex',
          database: 'OpenAlex',
          query: spec.query,
          filters: filtersOf(filter),
          request: openalex.requestUrl(spec.query, filter),
          total: found.total,
          capped: found.capped
        },
        found.works
      )
      return { message: 'mapping_searched' }
    } catch (error) {
      throw signal.aborted ? error : toUserFacing(error)
    }
  }

  /** «Buscar candidatos» (snowballing): a job, only when some record is included on full text and is a library paper. */
  requestSnowball(id: string, direction: SnowballDirection): number {
    if (!this.deps.store.mappingExists(id)) throw new UserFacingError('mapping_not_found')
    if (this.included(id).length === 0) throw new UserFacingError('nothing_to_snowball')
    return this.deps.enqueue({ type: 'mapping_snowball', mappingId: id, direction })
  }

  /**
   * Backward: the OpenAlex references of each included paper (fetched first when it never had them). Forward: the works
   * citing it, fetched now. The union is looked up with abstracts and logged as one iteration with its origin.
   */
  async runSnowball(spec: Spec<'mapping_snowball'>, signal: AbortSignal): Promise<{ message: 'snowballed' }> {
    try {
      const { cache, citations, openalex } = this.deps
      const from = this.included(spec.mappingId)
      if (from.length === 0) throw new UserFacingError('nothing_to_snowball')
      const paperIds = new Set(from.map((r) => r.paper_id!))
      for (const paperId of paperIds) {
        signal.throwIfAborted()
        // A paper whose citations were never fetched has neither its references nor its OpenAlex id yet.
        if (cache.getPaper(paperId)?.citations_status === 'none') await citations.fetch(paperId, signal)
        signal.throwIfAborted()
      }
      if (spec.direction !== 'backward') {
        const known = new Set(cache.relationRows().flatMap((r) => (paperIds.has(r.id) && r.openalex_id ? [r.id] : [])))
        for (const paperId of paperIds) {
          // A paper OpenAlex does not know has no citing works to fetch.
          if (known.has(paperId)) await citations.fetchCitedBy(paperId, signal)
          signal.throwIfAborted()
        }
      }
      const found = new Set<string>()
      if (spec.direction !== 'forward') for (const e of cache.citationEdges()) if (paperIds.has(e.citing)) found.add(e.cited)
      if (spec.direction !== 'backward') for (const e of cache.incomingEdges()) if (paperIds.has(e.paperId)) found.add(e.citing)
      const ids = [...found].sort().slice(0, SNOWBALL_CAP)
      let works: WorkCandidate[] = []
      if (ids.length > 0) {
        await this.pause()
        signal.throwIfAborted()
        works = await openalex.works(ids, signal)
      }
      signal.throwIfAborted()
      const searches = this.required(await this.load(spec.mappingId)).searches.value.searches
      const iteration = searches.filter((s) => s.kind === 'snowball').length + 1
      await this.addSearch(
        spec.mappingId,
        {
          kind: 'snowball',
          database: 'OpenAlex',
          filters: { direction: spec.direction },
          origin: { direction: spec.direction, from: from.map((r) => r.id), iteration },
          total: found.size,
          capped: found.size > ids.length
        },
        works
      )
      return { message: 'snowballed' }
    } catch (error) {
      throw signal.aborted ? error : toUserFacing(error)
    }
  }

  /**
   * What «Agregar a la biblioteca» would do (for these records, or all): which records, and the summaries it starts
   * when automatic summaries are on. The window sends the plan's ids back with the confirmation.
   */
  ingestPlan(id: string, recordIds?: string[]): IngestPlan {
    const ids = this.toIngest(id, recordIds).map((r) => r.id)
    const autoSummarize = this.deps.store.config.llm.auto_summarize
    return { count: ids.length, recordIds: ids, autoSummarize, estimateUsd: autoSummarize ? ids.length * this.deps.costs.estimate('summarize') : 0 }
  }

  /**
   * After the confirmation: one ingest job per record of the confirmed plan that is still included on title and
   * abstract and not a library paper yet (never a record the plan did not show); one batch.
   */
  requestIngest(id: string, recordIds: string[]): number {
    if (!this.deps.store.mappingExists(id)) throw new UserFacingError('mapping_not_found')
    const rows = this.toIngest(id, recordIds)
    const batchId = randomUUID()
    for (const row of rows) this.deps.enqueue({ type: 'ingest_record', mappingId: id, recordId: row.id, batchId })
    return rows.length
  }

  /**
   * The usual ingest by DOI, arXiv id or OpenAlex id; the record's own metadata when it has none or the registries do
   * not know it. The record is then linked to the paper. A record already a library paper (by DOI, arXiv id or title,
   * never a title across different DOIs) is only linked.
   */
  async ingestRecord(spec: Spec<'ingest_record'>, signal: AbortSignal): Promise<IngestOutcome> {
    try {
      const files = this.required(await this.load(spec.mappingId))
      const content = contentOf(files)
      const record = content.records.find((r) => r.id === spec.recordId)
      if (!record) throw new UserFacingError('mapping_not_found')
      if (!this.ingestable(content, record)) throw new UserFacingError('not_eligible')
      const { store, cache, library } = this.deps
      if (record.paper_id && store.paperExists(record.paper_id)) return { status: 'duplicate', paperId: record.paper_id }
      const known = libraryPaper(recordCandidate(record), cache.dedupeEntries())
      if (known && store.paperExists(known)) {
        await this.linkPaper(spec.mappingId, record.id, known)
        return { status: 'duplicate', paperId: known }
      }
      const ids = cleanIdentifiers(record.identifiers)
      const identifier = ids.doi ?? (ids.arxiv ? `arXiv:${ids.arxiv}` : undefined) ?? ids.openalex ?? null
      let outcome: IngestOutcome
      try {
        outcome = identifier ? await library.ingestIdentifier(identifier, signal) : await library.ingestMetadata(recordMetadata(record), signal)
      } catch (error) {
        if (!identifier || signal.aborted || toUserFacing(error).code !== 'not_found') throw error
        outcome = await library.ingestMetadata(recordMetadata(record), signal)
      }
      // The paper is in the library now: a cancel from here on still links it (and the handler runs the usual follow-ups),
      // or the record would stay unlinked and a new run would see a duplicate that never got its summary or citations.
      // A new paper is this record's; a paper the ingest merged into is linked only when it is the same work by identifier
      // or by title without different DOIs (the library's ingest may have taken a preprint for its published version).
      // When they disagree the record stays unlinked and keeps its place in the plan (backlog: the library merged the
      // record's work into another version of it).
      const link = outcome.status === 'added' ? outcome.paperId : libraryPaper(recordCandidate(record), cache.dedupeEntries())
      if (link === outcome.paperId) await this.linkPaper(spec.mappingId, record.id, outcome.paperId)
      return outcome
    } catch (error) {
      throw signal.aborted ? error : toUserFacing(error)
    }
  }

  /** «Sugerir cribado»'s confirmation: records, calls, estimate, caps and the month's spending. */
  async suggestPlan(id: string, phase: Phase): Promise<ScreeningPlan> {
    const { ready, withoutText } = this.toSuggest(id, phase)
    const calls = phase === 'title_abstract' ? Math.ceil(ready.length / MAX_RECORDS_PER_CALL) : ready.length
    const limits = this.deps.costs.limits()
    return {
      phase,
      count: ready.length,
      calls,
      estimateUsd: calls * this.deps.costs.estimate('screening'),
      perCallUsd: operationCap(limits, 'screening'),
      batchCapUsd: limits.perBatchUsd,
      monthSpentUsd: await this.deps.costs.monthSpent(),
      monthCapUsd: limits.perMonthUsd,
      withoutText,
      recordIds: ready.map((r) => r.id)
    }
  }

  /**
   * After the confirmation («Sugerir»): one job per 20 records (title and abstract) or per record (full text), all in
   * one batch, for the records of the confirmed plan that still need a suggestion. Records that arrived after the plan
   * was shown are never asked about: the user confirmed that number and that cost.
   */
  requestSuggestions(id: string, phase: Phase, recordIds: string[], model?: LlmModel): { batchId: string; count: number } {
    if (!this.deps.store.mappingExists(id)) throw new UserFacingError('mapping_not_found')
    const confirmed = new Set(recordIds)
    const ready = this.toSuggest(id, phase).ready.filter((r) => confirmed.has(r.id))
    const batchId = randomUUID()
    const size = phase === 'title_abstract' ? MAX_RECORDS_PER_CALL : 1
    for (let i = 0; i < ready.length; i += size) {
      this.deps.enqueue({ type: 'screen_suggest', mappingId: id, phase, recordIds: ready.slice(i, i + size).map((r) => r.id), batchId, ...(model ? { model } : {}) })
    }
    return { batchId, count: ready.length }
  }

  /**
   * Asks Claude about the job's records that are still undecided and eligible, and appends what comes back, stamped
   * with the protocol version sent. Decides nothing.
   */
  async runSuggestions(spec: Spec<'screen_suggest'>, signal: AbortSignal): Promise<{ message: 'screening_suggested' }> {
    try {
      const content = contentOf(this.required(await this.load(spec.mappingId)))
      const { protocol } = content
      const wanted = new Set(spec.recordIds)
      // Records decided, merged, waiting for a duplicate answer or already suggested since the job was queued are not asked about.
      const latest = latestSuggestions(content.suggestions)
      const pending = content.records.filter((r) => wanted.has(r.id) && this.suggestable(content, r, spec.phase, latest))
      if (pending.length === 0) return { message: 'screening_suggested' }
      const made: SuggestedScreening[] = []
      let model = ''
      if (spec.phase === 'title_abstract') {
        const out = await this.deps.suggester.titleAbstract({ protocol, records: pending, batchId: spec.batchId, model: spec.model, signal })
        made.push(...out.suggestions)
        model = out.model
      } else {
        for (const record of pending) {
          signal.throwIfAborted()
          const out = await this.deps.suggester.fullText({ protocol, record, paperId: record.paper_id!, batchId: spec.batchId, model: spec.model, signal })
          made.push(out.suggestion)
          model = out.model
        }
      }
      // A run cancelled while Claude answered writes nothing (its cost is logged).
      signal.throwIfAborted()
      await this.appendSuggestions(spec.mappingId, spec.phase, made, model, protocol.version)
      return { message: 'screening_suggested' }
    } catch (error) {
      if (signal.aborted) throw error
      const facing = toUserFacing(error)
      if (spec.batchId && BATCH_STOPPERS.has(facing.code)) this.deps.cancelBatch(spec.batchId)
      throw facing
    }
  }

  /** Records included on full text that are library papers: where snowballing starts. */
  private included(id: string): MappingRecordRow[] {
    const { cache, store } = this.deps
    return cache
      .mappingRows(id)
      .filter((r) => r.active && !r.duplicate && r.title_abstract.state === 'include' && r.full_text.state === 'include' && r.paper_id !== null && store.paperExists(r.paper_id))
  }

  private toIngest(id: string, recordIds?: string[]): MappingRecordRow[] {
    const wanted = recordIds ? new Set(recordIds) : null
    return this.deps.cache
      .mappingRows(id)
      .filter(
        (r) =>
          r.active && !r.duplicate && r.title_abstract.state === 'include' && (r.paper_id === null || !this.deps.store.paperExists(r.paper_id)) && (!wanted || wanted.has(r.id))
      )
  }

  /**
   * Undecided records whose newest suggestion (if any) was made with an earlier protocol; on full text, only papers with
   * text. The same rule as `suggestable`, which the job applies again to the files.
   */
  private toSuggest(id: string, phase: Phase): { ready: MappingRecordRow[]; withoutText: number } {
    const rows = this.queue(id, { phase, filter: 'pending' }).filter((r) => !r.suggestions[phase] || r.suggestions[phase]!.outdated)
    if (phase === 'title_abstract') return { ready: rows, withoutText: 0 }
    const ready = rows.filter((r) => r.paper_id !== null && this.deps.store.paperExists(r.paper_id) && this.deps.cache.getPaper(r.paper_id)?.text_status === 'ok')
    return { ready, withoutText: rows.length - ready.length }
  }

  /** As `decide` would take it: not merged, brought by a live search, not waiting for a duplicate answer. */
  private decidable(c: MappingContent, record: MappingRecord): boolean {
    const live = activeSearchIds(c.searches)
    return !record.merged_into && record.sources.some((s) => live.has(s)) && !record.duplicate_of && !syncPairs(c).has(record.id)
  }

  private ingestable(c: MappingContent, record: MappingRecord): boolean {
    if (!this.decidable(c, record)) return false
    return phaseView(headsOf(decisionHeads(c.decisions), record.id, 'title_abstract'), c.protocol.version).state === 'include'
  }

  /** Still worth asking Claude about: decidable, pending in the phase, and not suggested with the current protocol yet. */
  private suggestable(c: MappingContent, record: MappingRecord, phase: Phase, latest: Map<string, ScreeningSuggestion>): boolean {
    if (!this.decidable(c, record)) return false
    const heads = decisionHeads(c.decisions)
    const version = c.protocol.version
    if (phaseView(headsOf(heads, record.id, phase), version).state !== 'pending') return false
    if (phase === 'full_text') {
      if (phaseView(headsOf(heads, record.id, 'title_abstract'), version).state !== 'include') return false
      const paperId = record.paper_id
      if (!paperId || !this.deps.store.paperExists(paperId) || this.deps.cache.getPaper(paperId)?.text_status !== 'ok') return false
    }
    // As the plan counts it (the row's `outdated`): only the newest suggestion of the record and phase matters.
    const newest = latest.get(`${record.id}|${phase}`)
    return !newest || newest.protocol_version < version
  }

  private linkPaper(id: string, recordId: string, paperId: string): Promise<void> {
    const at = this.now().toISOString()
    return this.mutate(id, (files) => {
      const records = files.records.value.records
      const record = records.find((r) => r.id === recordId)
      if (!record || record.paper_id === paperId) return { writes: [], result: undefined }
      return {
        writes: [{ kind: 'records', file: { ...files.records.value, records: records.map((r) => (r.id === recordId ? { ...r, paper_id: paperId, updated_at: at } : r)) } }],
        result: undefined
      }
    })
  }

  private appendSuggestions(id: string, phase: Phase, made: SuggestedScreening[], model: string, version: number): Promise<void> {
    if (made.length === 0) return Promise.resolve()
    const at = this.now().toISOString()
    const entries: ScreeningSuggestion[] = made.map((s) => ({
      id: this.newId('g'),
      record: s.record,
      phase,
      decision: s.decision,
      criterion: s.criterion,
      justification: s.justification,
      quote: s.quote,
      page: s.page,
      found: s.found,
      model,
      at,
      protocol_version: version,
      prompt_version: SCREENING_PROMPT_VERSION
    }))
    return this.mutate(id, (files) => {
      const list = files.suggestions.value.suggestions
      const fresh = entries.filter((e) => !list.some((x) => x.id === e.id))
      return { writes: fresh.length > 0 ? [{ kind: 'suggestions', file: { ...files.suggestions.value, suggestions: [...list, ...fresh] } }] : [], result: undefined }
    })
  }

  private async pause(): Promise<void> {
    const ms = this.deps.pauseMs ?? 150
    if (ms > 0) await (this.deps.sleep ?? ((t: number) => new Promise<void>((resolve) => setTimeout(resolve, t))))(ms)
  }

  /**
   * Reads the mapping, lets `fn` decide the writes, makes them hash-checked (in the given order), re-indexes and emits.
   * A concurrent change (an edit outside the app, a sync) makes it read again and retry once (the store itself never
   * retries). `fn` must give the same writes when called again on files that already hold part of them; when part of
   * the first attempt's writes landed before the conflict, the first attempt's result is the one returned (the retry
   * sees its own records as already there).
   */
  private mutate<T>(id: string, fn: (files: LoadedMapping) => { writes: Write[]; result: T }): Promise<T> {
    return this.serial(id, async () => {
      let landed: { result: T } | null = null
      for (let attempt = 0; ; attempt++) {
        const files = this.required(await this.load(id))
        const { writes, result } = fn(files)
        let written = 0
        try {
          for (const w of writes) {
            await this.deps.store.writeMappingFile(id, w.kind, w.file, files[w.kind].hash)
            written++
          }
        } catch (error) {
          if (written > 0 && !landed) landed = { result }
          if (written > 0 || landed) {
            // Part of it is on disk: show it even if the retry fails.
            this.index(id, await this.load(id))
            this.deps.emit()
          }
          if (error instanceof ConflictError && attempt === 0) continue
          throw error
        }
        if (writes.length > 0 || landed) {
          this.index(id, await this.load(id))
          this.deps.emit()
        }
        return landed ? landed.result : result
      }
    })
  }

  /** Every file of a mapping, read; a file that does not read makes the whole mapping `mapping_invalid`. */
  private async load(id: string): Promise<Load> {
    const { store } = this.deps
    if (!store.mappingExists(id)) return { files: null, hashes: {}, problem: 'mapping_not_found', title: null }
    const protocol = await store.readMappingFile(id, 'protocol')
    const searches = await store.readMappingFile(id, 'searches')
    const records = await store.readMappingFile(id, 'records')
    const decisions = await store.readMappingFile(id, 'decisions')
    const suggestions = await store.readMappingFile(id, 'suggestions')
    const all: Record<MappingFileKind, ReadResult<unknown> | null> = { protocol, searches, records, decisions, suggestions }
    const hashes: Record<string, string> = {}
    for (const kind of MAPPING_FILE_KINDS) {
      const read = all[kind]
      if (read) hashes[MAPPING_FILE_NAMES[kind]] = read.hash
    }
    if (!protocol) return { files: null, hashes, problem: 'mapping_not_found', title: null }
    const title = protocol.ok ? protocol.value.protocol.title : null
    if (!protocol.ok || [searches, records, decisions, suggestions].some((r) => r !== null && !r.ok)) return { files: null, hashes, problem: 'mapping_invalid', title }
    const list = <T>(read: ReadResult<T> | null, empty: T): { value: T; hash: string | null } => ({ value: read?.ok ? read.value : empty, hash: read?.hash ?? null })
    return {
      files: {
        protocol: { value: protocol.value, hash: protocol.hash },
        searches: list(searches, EMPTY_MAPPING_LISTS.searches),
        records: list(records, EMPTY_MAPPING_LISTS.records),
        decisions: list(decisions, EMPTY_MAPPING_LISTS.decisions),
        suggestions: list(suggestions, EMPTY_MAPPING_LISTS.suggestions)
      },
      hashes,
      problem: null,
      title
    }
  }

  private required(load: Load): LoadedMapping {
    if (!load.files) throw new UserFacingError(load.problem ?? 'mapping_invalid')
    return load.files
  }

  /** The index of one mapping from its files (or its problem); a mapping gone from disk leaves the index. */
  private index(id: string, load: Load): void {
    const { cache } = this.deps
    if (load.problem === 'mapping_not_found') {
      cache.removeMapping(id)
      return
    }
    if (!load.files) {
      cache.setMappingProblem(id, { title: load.title, hashes: load.hashes, problem: load.problem ?? 'mapping_invalid' })
      return
    }
    const content = contentOf(load.files)
    const rows = withSyncDuplicates(recordRows(content), content)
    cache.replaceMapping({
      id,
      title: content.protocol.protocol.title,
      updatedAt: lastChange(content),
      hashes: load.hashes,
      rows,
      prisma: prismaCounts(rows, content.searches),
      counts: screeningCounts(rows)
    })
  }

  /** Work on one mapping runs one step at a time (reads, writes and re-indexing never interleave). */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runs.get(id) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.runs.set(id, settled)
    void settled.then(() => {
      if (this.runs.get(id) === settled) this.runs.delete(id)
    })
    return run
  }

  private newId(prefix: 's' | 'd' | 'g'): string {
    return `${prefix}${this.hex(12)}`
  }

  private hex(digits: number): string {
    return this.deps.randomHex?.(digits) ?? randomBytes(Math.ceil(digits / 2)).toString('hex').slice(0, digits)
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }
}
