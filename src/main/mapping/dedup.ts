import { randomBytes } from 'node:crypto'
import type { Author } from '../../shared/schemas'
import type { DuplicateReason, MappingRecord, RecordIdentifiers, WorkCandidate } from '../../shared/mapping'
import { asciiFold } from '../ingest/citekey'
import { arxivDoi, arxivFromDoi, normalizeArxiv, normalizeDoi, parseInput } from '../ingest/identifiers'
import { bareOpenAlexId } from '../ingest/openalex'
import { sha256 } from '../project/atomicWrite'

const KINDS = ['doi', 'arxiv', 'openalex'] as const
type Clean = Pick<RecordIdentifiers, (typeof KINDS)[number]>
/**
 * How much of a title it takes to stand for its work, counted on its normal form: one per character (spaces included,
 * as before), 2.5 per character of a script written without spaces (6 Chinese characters are enough). Shorter titles
 * ("Introduction") never make two records the same work, nor a shared record id, on their own.
 */
const MIN_TITLE = 15
const DENSE_WEIGHT = 2.5
export const SIMILAR_TITLE = 0.9

const DOI = /^10\.\d{4,9}\/\S+$/
const OPENALEX = /^W\d+$/

/**
 * DOIs lowercase and bare (also from doi.org URLs), arXiv ids without version (also from arXiv URLs and arXiv DOIs),
 * OpenAlex ids bare. Values that are not identifiers ("N/A", "-") are dropped. Only these three keys.
 */
export function cleanIdentifiers(ids: RecordIdentifiers): Clean {
  let doi = ids.doi ? cleanDoi(ids.doi) : undefined
  const fromDoi = doi ? arxivFromDoi(doi) : null
  const doiArxiv = fromDoi ? normalizeArxiv(fromDoi) : null
  if (doiArxiv) doi = arxivDoi(doiArxiv)
  const arxiv = (ids.arxiv ? cleanArxiv(ids.arxiv) : null) ?? doiArxiv ?? undefined
  const oa = ids.openalex ? bareOpenAlexId(ids.openalex).toUpperCase() : ''
  const openalex = OPENALEX.test(oa) ? oa : undefined
  return { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(openalex ? { openalex } : {}) }
}

function cleanDoi(raw: string): string | undefined {
  const parsed = parseInput(raw.trim().replace(/^(https?:\/\/)www\./i, '$1'))
  const doi = parsed.kind === 'doi' ? parsed.doi : normalizeDoi(raw)
  return DOI.test(doi) ? doi : undefined
}

function cleanArxiv(raw: string): string | null {
  const direct = normalizeArxiv(raw)
  if (direct) return direct
  const parsed = parseInput(raw)
  return parsed.kind === 'arxiv' ? parsed.arxiv : null
}

/** Some identifier kind both have, with different values. */
function conflicting(a: Clean, b: Clean): boolean {
  return KINDS.some((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k])
}

const shared = (a: Clean, b: Clean): number => KINDS.filter((k) => a[k] !== undefined && a[k] === b[k]).length
const hasIds = (a: Clean): boolean => KINDS.some((k) => a[k] !== undefined)

/** Scripts written without spaces between words: their characters are compared in pairs. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const DENSE_RUNS = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+)/u

/**
 * A title's normal form for deduplication: Latin accents folded as the library does, lowercase, letters, marks and
 * digits of every script kept, anything else a single space. Latin titles give the library's own normal form.
 */
export function titleForm(title: string): string {
  return asciiFold(title)
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .normalize('NFKC')
}

function titleWeight(form: string): number {
  let w = 0
  for (const ch of form) w += DENSE.test(ch) ? DENSE_WEIGHT : 1
  return w
}

const strongTitle = (form: string): boolean => titleWeight(form) >= MIN_TITLE

/** Words of the normal form; runs of a script without spaces become their character pairs. */
function titleTokens(form: string): Set<string> {
  const out = new Set<string>()
  for (const word of form.split(' ')) {
    for (const part of word.split(DENSE_RUNS)) {
      if (!part) continue
      if (!DENSE.test(part)) {
        out.add(part)
        continue
      }
      const chars = [...part]
      if (chars.length === 1) out.add(part)
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
    }
  }
  return out
}

/** The first author's family name, folded; '' when there is none. */
function firstFamily(authors: Author[]): string {
  return authors.length > 0 ? titleForm(authors[0].family) : ''
}

/**
 * What a record's id is derived from, so one work gets one id on every machine: its best identifier (an arXiv DOI keys
 * as its arXiv id), else its title's normal form, year and first author's family name. A title that cannot tell works
 * apart (too short, or without a year) gets a random key instead, since the sync would silently join two works that
 * derived one id. Not deterministic then: call it once per new record (not once per retry of a write).
 */
export function recordKey(c: Pick<WorkCandidate, 'title' | 'year' | 'identifiers' | 'authors'>): string {
  const ids = cleanIdentifiers(c.identifiers)
  if (ids.doi && !(ids.arxiv && ids.doi === arxivDoi(ids.arxiv))) return `doi:${ids.doi}`
  if (ids.arxiv) return `arxiv:${ids.arxiv}`
  if (ids.openalex) return `openalex:${ids.openalex}`
  const title = titleForm(c.title)
  if (strongTitle(title) && c.year !== null) return `title:${title}|${c.year}|${firstFamily(c.authors)}`
  return `unkeyed:${randomBytes(8).toString('hex')}`
}

/** `r` + 12 hex of the key's hash: one work gets one id on every machine; a taken id (another record) hashes again. */
export function recordIdFor(key: string, taken: (id: string) => boolean): string {
  for (let n = 1; ; n++) {
    const id = `r${sha256(n === 1 ? key : `${key}#${n}`).slice(0, 12)}`
    if (!taken(id)) return id
  }
}

function dice(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 || y.size === 0) return 0
  const [small, big] = x.size <= y.size ? [x, y] : [y, x]
  let n = 0
  for (const w of small) if (big.has(w)) n++
  return (2 * n) / (x.size + y.size)
}

/** Dice coefficient of the titles' tokens (case, accents and punctuation ignored; character pairs for CJK and the like). */
export function titleSimilarity(a: string, b: string): number {
  return dice(titleTokens(titleForm(a)), titleTokens(titleForm(b)))
}

export type RecordMatch = { kind: 'same'; record: string } | { kind: 'doubtful'; record: string; reason: DuplicateReason } | null

/** A match with how it was found: `basis` tells an identifier match from a title one. */
type FullMatch = { kind: 'same'; record: string; basis: 'id' | 'title' } | { kind: 'doubtful'; record: string; reason: DuplicateReason }

interface Entry {
  record: MappingRecord
  /** The record a match with this one resolves to: itself, or the record it was merged into. */
  root: string
  ids: Clean
  title: string
  tokens: Set<string>
  family: string
  venue: string
}

const yearsNear = (a: number | null, b: number | null): boolean => a === null || b === null || Math.abs(a - b) <= 1
/** How far two years are; an unknown year comes after any known year one apart. */
const yearGap = (a: number | null, b: number | null): number => (a === null || b === null ? 1.5 : Math.abs(a - b))

/**
 * Matches candidates against the records of a mapping. It never joins two works on a guess:
 * - identifiers: a record sharing one with the candidate and conflicting on none is the same work (the one sharing
 *   most kinds wins); when every record sharing one also conflicts on another kind (a preprint and its published
 *   version), the pair is doubtful (`conflicting_ids`);
 * - title: the same normal form, with no identifier in conflict, is the same work when the title is long enough, the
 *   years are equal and known, and both have authors with the same first family name; also when the candidate
 *   replicates a record without identifiers exactly (title, year, venue and first author, or both without authors:
 *   an exact re-import). Without authors on either side it is never joined otherwise. Otherwise the same
 *   title a year apart at most (or without a year) is doubtful (`same_title`, or `conflicting_ids`), the nearest year
 *   first;
 * - titles with a token Dice similarity of at least 0.9, a year apart at most, are doubtful (`similar_title`).
 * Merged records are indexed too and resolve to the record they were merged into, so a confirmed «Es el mismo» or
 * «Son distintos» stays settled when the same works arrive again.
 */
export class RecordMatcher {
  private readonly byId = new Map<string, Entry[]>()
  private readonly byTitle = new Map<string, Entry[]>()
  private readonly postings = new Map<string, Entry[]>()

  constructor(records: Iterable<MappingRecord>) {
    const all = new Map<string, MappingRecord>()
    for (const r of records) all.set(r.id, r)
    for (const r of all.values()) {
      const root = rootOf(r, all)
      if (root) this.index(r, root)
    }
  }

  /** A record added during the same import (active). */
  add(r: MappingRecord): void {
    this.index(r, r.id)
  }

  match(c: WorkCandidate): RecordMatch {
    const m = this.matchFull(c)
    if (!m) return null
    return m.kind === 'same' ? { kind: 'same', record: m.record } : m
  }

  /** The match, leaving out the records `skip` names (by the record it resolves to). */
  matchFull(c: WorkCandidate, skip: (root: string) => boolean = () => false): FullMatch | null {
    const ids = cleanIdentifiers(c.identifiers)
    const hits: Entry[] = []
    for (const kind of KINDS) {
      const value = ids[kind]
      if (!value) continue
      for (const e of this.byId.get(`${kind}:${value}`) ?? []) if (!skip(e.root) && !hits.includes(e)) hits.push(e)
    }
    if (hits.length > 0) {
      const clean = hits.filter((e) => !conflicting(ids, e.ids)).sort((a, b) => shared(ids, b.ids) - shared(ids, a.ids))
      if (clean.length > 0) return { kind: 'same', record: clean[0].root, basis: 'id' }
      return { kind: 'doubtful', record: hits[0].root, reason: 'conflicting_ids' }
    }

    const title = titleForm(c.title)
    if (!title) return null
    const family = firstFamily(c.authors)
    const venue = titleForm(c.venue ?? '')
    const strong = strongTitle(title)
    const sameTitle = (this.byTitle.get(title) ?? []).filter((e) => !skip(e.root))
    const same = sameTitle.find((e) => {
      if (conflicting(ids, e.ids)) return false
      if (strong && c.year !== null && e.record.year === c.year && family !== '' && family === e.family) return true
      return !hasIds(ids) && !hasIds(e.ids) && e.record.year === c.year && e.venue === venue && e.family === family
    })
    if (same) return { kind: 'same', record: same.root, basis: 'title' }
    const byYear = [...sameTitle].sort((a, b) => yearGap(a.record.year, c.year) - yearGap(b.record.year, c.year))
    for (const e of byYear) {
      const near = yearsNear(e.record.year, c.year)
      if (conflicting(ids, e.ids) && (near || strong)) return { kind: 'doubtful', record: e.root, reason: 'conflicting_ids' }
      if (near) return { kind: 'doubtful', record: e.root, reason: 'same_title' }
    }

    const similar = this.similar(titleTokens(title), c.year, skip)
    return similar ? { kind: 'doubtful', record: similar.root, reason: 'similar_title' } : null
  }

  private index(r: MappingRecord, root: string): void {
    const title = titleForm(r.title)
    const e: Entry = { record: r, root, ids: cleanIdentifiers(r.identifiers), title, tokens: titleTokens(title), family: firstFamily(r.authors), venue: titleForm(r.venue ?? '') }
    for (const kind of KINDS) {
      const value = e.ids[kind]
      if (value) push(this.byId, `${kind}:${value}`, e)
    }
    if (!title) return
    push(this.byTitle, title, e)
    for (const t of e.tokens) push(this.postings, t, e)
  }

  /**
   * The most similar title a year apart at most. Dice ≥ 0.9 needs at least 9/11 of the candidate's tokens shared, so
   * any match holds one of its (n − ⌈9n/11⌉ + 1) rarest tokens: only the records listed under those are compared.
   */
  private similar(tokens: Set<string>, year: number | null, skip: (root: string) => boolean): Entry | null {
    const n = tokens.size
    if (n === 0) return null
    const need = Math.ceil((n * 9) / 11 - 1e-9)
    const probes = [...tokens].sort((a, b) => (this.postings.get(a)?.length ?? 0) - (this.postings.get(b)?.length ?? 0)).slice(0, n - need + 1)
    const seen = new Set<Entry>()
    let best: Entry | null = null
    let bestScore = 0
    for (const t of probes) {
      for (const e of this.postings.get(t) ?? []) {
        if (seen.has(e)) continue
        seen.add(e)
        if (!yearsNear(e.record.year, year) || skip(e.root)) continue
        const m = e.tokens.size
        if (m * 11 < n * 9 || m * 9 > n * 11) continue
        const score = dice(tokens, e.tokens)
        if (score >= SIMILAR_TITLE && score > bestScore) {
          best = e
          bestScore = score
        }
      }
    }
    return best
  }
}

/** The active record `r` resolves to through its `merged_into` chain; null when the chain breaks or loops. */
function rootOf(r: MappingRecord, all: Map<string, MappingRecord>): string | null {
  let cur = r
  for (let steps = 0; cur.merged_into; steps++) {
    const next = all.get(cur.merged_into)
    if (!next || steps > all.size) return null
    cur = next
  }
  return cur.id
}

function push<K>(map: Map<K, Entry[]>, key: K, e: Entry): void {
  const list = map.get(key)
  if (list) list.push(e)
  else map.set(key, [e])
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
 * Possible duplicates among active records that entry could not catch: two machines added one work under different
 * ids (different keys, or random keys of weak titles) and the sync kept both. Each record, in `added_at` then id order,
 * is matched with the matcher's own rules against the earlier ones; a match becomes a pair with its reason (`same_id`
 * for a shared identifier, `same_title` for a title the matcher would have joined, else the doubtful reason). Pairs the
 * user already settled (`distinct_from`) and records already waiting on a doubtful pair (`duplicate_of`) are left out.
 * Pass only active records.
 */
export function syncDuplicates(records: MappingRecord[]): { record: string; other: string; reason: DuplicateReason }[] {
  const sorted = [...records].sort((a, b) => (a.added_at < b.added_at ? -1 : a.added_at > b.added_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const byId = new Map(sorted.map((r) => [r.id, r]))
  const matcher = new RecordMatcher([])
  const out: { record: string; other: string; reason: DuplicateReason }[] = []
  for (const r of sorted) {
    if (!r.duplicate_of) {
      const told = (other: string): boolean => other === r.id || r.distinct_from.includes(other) || (byId.get(other)?.distinct_from.includes(r.id) ?? false) || byId.get(other)?.duplicate_of?.record === r.id
      const m = matcher.matchFull(r, told)
      if (m) out.push({ record: r.id, other: m.record, reason: m.kind === 'same' ? (m.basis === 'id' ? 'same_id' : 'same_title') : m.reason })
    }
    matcher.add(r)
  }
  return out
}
