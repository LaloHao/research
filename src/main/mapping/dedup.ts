import { randomBytes } from 'node:crypto'
import type { DuplicateReason, MappingRecord, RecordIdentifiers, WorkCandidate } from '../../shared/mapping'
import { arxivFromDoi, normalizeArxiv, normalizeDoi } from '../ingest/identifiers'
import { bareOpenAlexId } from '../ingest/openalex'
import { normalizeTitle } from '../library/dedupe'
import { sha256 } from '../project/atomicWrite'

const KINDS = ['doi', 'arxiv', 'openalex'] as const
type Clean = Pick<RecordIdentifiers, (typeof KINDS)[number]>
/** Shorter titles ("Introduction") never make two records the same work on their own. */
const MIN_TITLE = 15
export const SIMILAR_TITLE = 0.9

/** DOIs lowercase and bare, arXiv ids without version (also from an arXiv DOI), OpenAlex ids bare. Only these three keys. */
export function cleanIdentifiers(ids: RecordIdentifiers): Clean {
  const doi = ids.doi ? normalizeDoi(ids.doi) || undefined : undefined
  const arxiv = (ids.arxiv ? normalizeArxiv(ids.arxiv) : null) ?? (doi ? arxivFromDoi(doi) : null) ?? undefined
  const openalex = ids.openalex ? bareOpenAlexId(ids.openalex).toUpperCase() || undefined : undefined
  return { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(openalex ? { openalex } : {}) }
}

/** Some identifier kind both have, with different values. */
function conflicting(a: Clean, b: Clean): boolean {
  return KINDS.some((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k])
}

/** A title that can stand for its work: long enough once normalized (a non-Latin title folds to nothing). */
const keyTitle = (normalized: string): boolean => normalized.length >= MIN_TITLE

/**
 * What a record's id is derived from: its best identifier, else its normalized title and year, so one work gets one id
 * on every machine. A title that cannot tell works apart (short, folding to nothing, or without a year) gets a random
 * key instead: two machines must never derive one id for two works, since the sync would join them silently.
 */
export function recordKey(c: Pick<WorkCandidate, 'title' | 'year' | 'identifiers'>): string {
  const ids = cleanIdentifiers(c.identifiers)
  if (ids.doi) return `doi:${ids.doi}`
  if (ids.arxiv) return `arxiv:${ids.arxiv}`
  if (ids.openalex) return `openalex:${ids.openalex}`
  const title = normalizeTitle(c.title)
  if (keyTitle(title) && c.year !== null) return `title:${title}|${c.year}`
  return `unkeyed:${randomBytes(8).toString('hex')}`
}

/** `r` + 12 hex of the key's hash: one work gets one id on every machine; a taken id (another record) hashes again. */
export function recordIdFor(key: string, taken: (id: string) => boolean): string {
  for (let n = 1; ; n++) {
    const id = `r${sha256(n === 1 ? key : `${key}#${n}`).slice(0, 12)}`
    if (!taken(id)) return id
  }
}

const words = (title: string): Set<string> => new Set(normalizeTitle(title).split(' ').filter(Boolean))

/** Dice coefficient of the titles' word sets (case, accents and punctuation ignored); 0 when either has no words. */
export function titleSimilarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return (2 * shared) / (x.size + y.size)
}

export type RecordMatch = { kind: 'same'; record: string } | { kind: 'doubtful'; record: string; reason: DuplicateReason } | null

const yearsNear = (a: number | null, b: number | null): boolean => a === null || b === null || Math.abs(a - b) <= 1

/**
 * Matches candidates against the records of a mapping (merged ones left out). It never joins two works on a guess:
 * - a shared identifier is the same work only when no identifier kind conflicts and every record sharing one agrees;
 *   otherwise the pair is doubtful (`conflicting_ids`), e.g. a preprint and its published version;
 * - the same normalized title (at least 15 characters) and the same known year, with no identifier in conflict, is the
 *   same work; the same title with conflicting identifiers, a year one apart or a missing year is doubtful;
 * - titles with a word Dice similarity of at least 0.9, a year apart at most, are doubtful (`similar_title`).
 */
export class RecordMatcher {
  private readonly byId = new Map<string, MappingRecord[]>()
  private readonly byTitle = new Map<string, MappingRecord[]>()
  private readonly byYear = new Map<number | null, MappingRecord[]>()
  private readonly clean = new Map<string, Clean>()

  constructor(records: Iterable<MappingRecord>) {
    for (const r of records) if (!r.merged_into) this.add(r)
  }

  add(r: MappingRecord): void {
    const ids = cleanIdentifiers(r.identifiers)
    this.clean.set(r.id, ids)
    for (const kind of KINDS) {
      const value = ids[kind]
      if (value) push(this.byId, `${kind}:${value}`, r)
    }
    const title = normalizeTitle(r.title)
    if (title) push(this.byTitle, title, r)
    push(this.byYear, r.year, r)
  }

  match(c: WorkCandidate): RecordMatch {
    const ids = cleanIdentifiers(c.identifiers)
    const hits: MappingRecord[] = []
    for (const kind of KINDS) {
      const value = ids[kind]
      for (const r of value ? (this.byId.get(`${kind}:${value}`) ?? []) : []) if (!hits.includes(r)) hits.push(r)
    }
    if (hits.length > 0) {
      const clash = hits.find((r) => conflicting(ids, this.ids(r)))
      return clash ? { kind: 'doubtful', record: clash.id, reason: 'conflicting_ids' } : { kind: 'same', record: hits[0].id }
    }

    const title = normalizeTitle(c.title)
    const sameTitle = title ? (this.byTitle.get(title) ?? []) : []
    const same = sameTitle.find((r) => keyTitle(title) && r.year !== null && r.year === c.year && !conflicting(ids, this.ids(r)))
    if (same) return { kind: 'same', record: same.id }
    for (const r of sameTitle) {
      const near = yearsNear(r.year, c.year)
      if (conflicting(ids, this.ids(r)) && (near || keyTitle(title))) return { kind: 'doubtful', record: r.id, reason: 'conflicting_ids' }
      if (near) return { kind: 'doubtful', record: r.id, reason: 'same_title' }
    }

    if (!title) return null
    for (const r of this.near(c.year)) {
      if (titleSimilarity(r.title, c.title) >= SIMILAR_TITLE) return { kind: 'doubtful', record: r.id, reason: 'similar_title' }
    }
    return null
  }

  private ids(r: MappingRecord): Clean {
    return this.clean.get(r.id) ?? cleanIdentifiers(r.identifiers)
  }

  /** Records a year apart at most (or without a year): the only ones whose titles are compared. */
  private near(year: number | null): MappingRecord[] {
    if (year === null) return [...this.byYear.values()].flat()
    return [year - 1, year, year + 1, null].flatMap((y) => this.byYear.get(y) ?? [])
  }
}

function push<K>(map: Map<K, MappingRecord[]>, key: K, r: MappingRecord): void {
  const list = map.get(key)
  if (list) list.push(r)
  else map.set(key, [r])
}

export function newRecord(
  c: WorkCandidate,
  opts: { id: string; searchId: string; at: string; paperId: string | null; duplicate: MappingRecord['duplicate_of'] }
): MappingRecord {
  return {
    id: opts.id,
    title: c.title,
    authors: c.authors,
    year: c.year,
    venue: c.venue,
    abstract: c.abstract,
    kind: c.kind,
    identifiers: cleanIdentifiers(c.identifiers),
    sources: [opts.searchId],
    paper_id: opts.paperId,
    duplicate_of: opts.duplicate,
    merged_into: null,
    distinct_from: [],
    added_at: opts.at,
    updated_at: opts.at
  }
}

function sameIdentifiers(a: RecordIdentifiers, b: RecordIdentifiers): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => a[k] === b[k])
}

/**
 * The same work found again: the search joins its sources and the record takes only what it lacked (its own
 * identifiers and unknown keys are kept). The same object when nothing changes.
 */
export function mergeCandidate(r: MappingRecord, c: WorkCandidate, searchId: string, at: string): MappingRecord {
  const ids: RecordIdentifiers = { ...r.identifiers, ...cleanIdentifiers(c.identifiers), ...cleanIdentifiers(r.identifiers) }
  const next: MappingRecord = {
    ...r,
    sources: r.sources.includes(searchId) ? r.sources : [...r.sources, searchId],
    authors: r.authors.length > 0 ? r.authors : c.authors,
    year: r.year ?? c.year,
    venue: r.venue ?? c.venue,
    abstract: r.abstract ?? c.abstract,
    kind: r.kind ?? c.kind,
    paper_id: r.paper_id ?? c.paperId ?? null
  }
  const idsChanged = !sameIdentifiers(ids, r.identifiers)
  const changed =
    idsChanged ||
    next.sources !== r.sources ||
    next.authors !== r.authors ||
    next.year !== r.year ||
    next.venue !== r.venue ||
    next.abstract !== r.abstract ||
    next.kind !== r.kind ||
    next.paper_id !== r.paper_id
  return changed ? { ...next, identifiers: idsChanged ? ids : r.identifiers, updated_at: at } : r
}

/**
 * Records that share an identifier although entry would have matched them: two machines added the same work under
 * different keys and the sync kept both. Each later record (by `added_at`, then id) is paired with the earliest record
 * sharing an identifier with it that it is not told distinct from and not already waiting on as a doubtful duplicate.
 * Pass only active records.
 */
export function identifierCollisions(records: MappingRecord[]): { record: string; other: string }[] {
  const sorted = [...records].sort((a, b) => (a.added_at < b.added_at ? -1 : a.added_at > b.added_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const owners = new Map<string, MappingRecord[]>()
  const out: { record: string; other: string }[] = []
  for (const r of sorted) {
    const ids = cleanIdentifiers(r.identifiers)
    let paired = false
    for (const kind of KINDS) {
      const value = ids[kind]
      if (!value) continue
      const key = `${kind}:${value}`
      const earlier = owners.get(key) ?? []
      if (!paired) {
        const other = earlier.find((o) => o.id !== r.id && !told(r, o))
        if (other) {
          out.push({ record: r.id, other: other.id })
          paired = true
        }
      }
      if (!earlier.includes(r)) owners.set(key, [...earlier, r])
    }
  }
  return out
}

/** The user already said they are distinct, or the pair already waits as a doubtful duplicate. */
function told(a: MappingRecord, b: MappingRecord): boolean {
  return (
    a.distinct_from.includes(b.id) ||
    b.distinct_from.includes(a.id) ||
    a.duplicate_of?.record === b.id ||
    b.duplicate_of?.record === a.id
  )
}
