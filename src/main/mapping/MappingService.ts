import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  MAPPING_ID,
  ProtocolDraftSchema,
  SearchSchema,
  type ImportOutcome,
  type ImportSource,
  type MappingRecord,
  type MappingRecordRow,
  type MappingSummary,
  type MappingView,
  type ProtocolDraft,
  type Search,
  type WorkCandidate
} from '../../shared/mapping'
import type { Paper } from '../../shared/schemas'
import type { IndexCache } from '../cache/IndexCache'
import { findDuplicate } from '../library/dedupe'
import { UserFacingError } from '../library/UserFacingError'
import { ConflictError, type ReadResult } from '../project/errors'
import { EMPTY_MAPPING_LISTS, MAPPING_FILE_KINDS, MAPPING_FILE_NAMES, newMappingId, type MappingFileKind, type MappingFiles } from '../project/mappingFiles'
import type { ProjectStore } from '../project/ProjectStore'
import { cleanIdentifiers, mergeCandidate, newRecord, RecordMatcher, recordIdFor, recordKey, syncDuplicates } from './dedup'
import { decodeExport, MAX_EXPORT_BYTES, parseExport } from './importers/importFile'
import { prismaCounts } from './prisma'
import { applyDraft, newProtocol } from './protocol'
import { conflictsOf, duplicatePairs, recordRows, screeningCounts, type MappingContent } from './screening'

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
 * Rows of records entry could not compare (two machines added one work under different ids and the sync kept both)
 * are marked as possible duplicates, with the reason the matcher gives.
 */
function withSyncDuplicates(rows: MappingRecordRow[], c: MappingContent): MappingRecordRow[] {
  const activeIds = new Set(rows.filter((r) => r.active).map((r) => r.id))
  const pairs = new Map(syncDuplicates(c.records.filter((r) => activeIds.has(r.id))).map((x) => [x.record, x]))
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
        screeningStarted: files.decisions.value.decisions.length > 0,
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
      const next = applyDraft(current, parsed.data, { screeningStarted: files.decisions.value.decisions.length > 0, now: this.now().toISOString() })
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
        const ids = cleanIdentifiers(c.identifiers)
        const paperId = c.paperId ?? findDuplicate({ doi: ids.doi, arxiv: ids.arxiv, title: c.title }, library)?.id ?? null
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
   * which takes its sources, the fields it lacked and its library link. «Son distintos»: each names the other as
   * distinct, and neither is asked about again.
   */
  async resolveDuplicate(id: string, recordId: string, same: boolean): Promise<void> {
    const pairOf = this.deps.cache.mappingRow(id, recordId)?.duplicate?.of
    if (!pairOf) throw new UserFacingError('mapping_not_found')
    const at = this.now().toISOString()
    await this.mutate(id, (files) => {
      const records = new Map(files.records.value.records.map((r) => [r.id, r]))
      const record = records.get(recordId)
      const other = survivor(records, pairOf)
      if (!record || !other || other.id === record.id || record.merged_into) throw new UserFacingError('mapping_not_found')
      if (same) {
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
          updated_at: at
        })
        records.set(record.id, { ...record, merged_into: other.id, duplicate_of: null, updated_at: at })
      } else {
        records.set(record.id, { ...record, duplicate_of: null, distinct_from: union(record.distinct_from, [other.id]), updated_at: at })
        records.set(other.id, { ...other, distinct_from: union(other.distinct_from, [record.id]), updated_at: at })
      }
      return { writes: [{ kind: 'records', file: { ...files.records.value, records: [...records.values()] } }], result: undefined }
    })
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
