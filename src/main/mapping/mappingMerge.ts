import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import type { z } from 'zod'
import {
  DecisionsFileSchema,
  ProtocolFileSchema,
  RecordsFileSchema,
  SearchesFileSchema,
  SuggestionsFileSchema,
  type MappingRecord,
  type ProtocolBody,
  type ProtocolFile,
  type Search
} from '../../shared/mapping'
import { sortedMappingFile, type MappingFileKind, type MappingFiles } from '../project/mappingFiles'
import { toYaml } from '../project/yamlFile'
import type { MergeInput } from '../sync/mergers'

/**
 * Sync mergers of a mapping's five files. Nothing is ever dropped silently: searches, records, decisions and
 * suggestions are joined by id (none is ever removed), and whatever cannot be joined safely (a side that does not read,
 * one entry changed differently on both machines, two different protocols) returns null, so the file becomes the
 * user's decision.
 */

type Loose = Record<string, unknown>

/** One side read strictly: another schema version, an invalid entry or broken YAML leaves the file to the user. */
function side<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The three sides read; null when any of them (the base only when there is one) does not read. */
function sides<T>({ base, ours, theirs }: MergeInput, schema: z.ZodType<T>): { b: T | null; o: T; t: T } | null {
  const o = side(ours, schema)
  const t = side(theirs, schema)
  const b = base === null ? null : side(base, schema)
  if (!o || !t || (base !== null && !b)) return null
  return { b, o, t }
}

/** An unparseable timestamp counts as the oldest. */
function instant(at: string): number {
  const t = Date.parse(at)
  return Number.isNaN(t) ? -Infinity : t
}

/** A stable order of any two values, so swapping the machines never changes the merged bytes. */
function compareValues(a: unknown, b: unknown): number {
  const [x, y] = [JSON.stringify(a) ?? '', JSON.stringify(b) ?? '']
  return x < y ? -1 : x > y ? 1 : 0
}

/** The later of two timestamps; equal instants fall back to a stable order of the whole values. */
function later<T>(a: T, b: T, at: (x: T) => string): T {
  const d = instant(at(a)) - instant(at(b))
  if (d !== 0 && !Number.isNaN(d)) return d > 0 ? a : b
  return compareValues(a, b) >= 0 ? a : b
}

/** The earlier of two timestamps; equal instants fall back to a stable order of the whole values. */
function earlier<T>(a: T, b: T, at: (x: T) => string): T {
  return later(a, b, at) === a && !isDeepStrictEqual(a, b) ? b : a
}

const CLASH = Symbol('clash')

/**
 * Key by key against the base (absent keys included): the same value, or the one side that changed it; the same key
 * changed differently on both machines clashes. `skip` keys are left out (the caller merges them).
 */
function mergeKeys(base: Loose | undefined, ours: Loose, theirs: Loose, skip: readonly string[] = []): Loose | typeof CLASH {
  const before = base ?? {}
  const out: Loose = {}
  for (const key of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
    if (skip.includes(key)) continue
    const [b, o, t] = [before[key], ours[key], theirs[key]]
    let value: unknown
    if (isDeepStrictEqual(o, t) || isDeepStrictEqual(t, b)) value = o
    else if (isDeepStrictEqual(o, b)) value = t
    else return CLASH
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Every entry of both sides by id (none is removed); an entry on both goes through `pick`, which may clash. */
function joinById<T extends { id: string }>(base: T[] | undefined, ours: T[], theirs: T[], pick: (b: T | undefined, o: T, t: T) => T | typeof CLASH): T[] | null {
  const before = new Map((base ?? []).map((x) => [x.id, x]))
  const merged = new Map(ours.map((x) => [x.id, x]))
  for (const t of theirs) {
    const o = merged.get(t.id)
    if (!o) {
      merged.set(t.id, t)
      continue
    }
    const picked = isDeepStrictEqual(o, t) ? o : pick(before.get(t.id), o, t)
    if (picked === CLASH) return null
    merged.set(t.id, picked)
  }
  return [...merged.values()]
}

/** The file around the list: its other keys merged key by key, then validated and written in a stable order. */
function finish<K extends Exclude<MappingFileKind, 'protocol'>>(
  kind: K,
  listKey: string,
  schema: z.ZodType<MappingFiles[K]>,
  b: Loose | null,
  o: Loose,
  t: Loose,
  list: unknown[] | null
): string | null {
  if (list === null) return null
  const rest = mergeKeys(b ?? undefined, o, t, [listKey])
  if (rest === CLASH) return null
  const file = schema.safeParse({ ...rest, schema_version: 1, [listKey]: list })
  return file.success ? toYaml(sortedMappingFile(kind, file.data)) : null
}

/** An entry both machines have and that was never meant to change (decisions, suggestions): key by key, else the user's. */
const pickEntry = <T extends Loose>(b: T | undefined, o: T, t: T): T | typeof CLASH => mergeKeys(b, o, t) as T | typeof CLASH

/** A search: key by key, except a discard on either machine counts (the earlier one when both discarded it). */
function pickSearch(b: Search | undefined, o: Search, t: Search): Search | typeof CLASH {
  const rest = mergeKeys(b, o, t, ['discarded'])
  if (rest === CLASH) return CLASH
  const discards = [o.discarded, t.discarded].filter((d) => d !== null)
  const discarded = discards.length === 0 ? null : discards.reduce((x, y) => earlier(x, y, (d) => d.at))
  return { ...rest, discarded } as Search
}

/** searches.yaml: every search of both machines (none is ever removed); a discard on either counts, the first if both. */
export function mergeSearchesText(input: MergeInput): string | null {
  const s = sides(input, SearchesFileSchema)
  if (!s) return null
  const { b, o, t } = s
  return finish('searches', 'searches', SearchesFileSchema, b, o, t, joinById(b?.searches, o.searches, t.searches, pickSearch))
}

/** decisions.yaml: append-only, joined by id (two machines' decisions on one record become a conflict the app shows). */
export function mergeDecisionsText(input: MergeInput): string | null {
  const s = sides(input, DecisionsFileSchema)
  if (!s) return null
  const { b, o, t } = s
  return finish('decisions', 'decisions', DecisionsFileSchema, b, o, t, joinById(b?.decisions, o.decisions, t.decisions, pickEntry))
}

/** suggestions.yaml: append-only, joined by id. */
export function mergeSuggestionsText(input: MergeInput): string | null {
  const s = sides(input, SuggestionsFileSchema)
  if (!s) return null
  const { b, o, t } = s
  return finish('suggestions', 'suggestions', SuggestionsFileSchema, b, o, t, joinById(b?.suggestions, o.suggestions, t.suggestions, pickEntry))
}

const union = (a: string[], c: string[]): string[] => [...new Set([...a, ...c])].sort()

/** Keys of a record merged by their own rule rather than plain three-way. */
const RECORD_LISTS = ['sources', 'distinct_from'] as const
const RECORD_LINKS = ['paper_id', 'merged_into'] as const

/**
 * A record both machines have, merged field by field against the base (none when both created it): a field one side
 * changed takes that side's value whatever the clocks say; a field both changed differently takes the newer record's
 * (the newer `updated_at`, then a stable order), except that where the base had no value (or there is no base) a
 * value only one side has is never replaced by the other's absence or null. `sources` and `distinct_from` are joined, a library link or merge is
 * kept from either side, and `updated_at` is the latest. A pending duplicate that the merged record already resolved
 * («Son distintos» or «Es el mismo» on either machine) is cleared.
 */
function pickRecord(base: MappingRecord | undefined, o: MappingRecord, t: MappingRecord): MappingRecord {
  const newer = later(o, t, (r) => r.updated_at)
  const before: Loose = base ?? {}
  const [ol, tl]: Loose[] = [o, t]
  const out: Loose = {}
  for (const key of [...new Set([...Object.keys(o), ...Object.keys(t)])].sort()) {
    const [b, x, y] = [before[key], ol[key], tl[key]]
    let value: unknown
    if ((RECORD_LISTS as readonly string[]).includes(key)) value = union((x as string[] | undefined) ?? [], (y as string[] | undefined) ?? [])
    else if (key === 'updated_at') value = newer.updated_at
    else if (isDeepStrictEqual(x, y) || (base && isDeepStrictEqual(y, b))) value = x
    else if (base && isDeepStrictEqual(x, b)) value = y
    else if ((b === undefined || b === null || (RECORD_LINKS as readonly string[]).includes(key)) && (x == null || y == null)) value = x ?? y
    else value = newer === o ? x : y
    if (value !== undefined) out[key] = value
  }
  const merged = out as MappingRecord
  if (merged.duplicate_of && (merged.merged_into !== null || merged.distinct_from.includes(merged.duplicate_of.record))) merged.duplicate_of = null
  return merged
}

/** records.yaml: joined by id against the merge base (records are never removed). */
export function mergeRecordsText(input: MergeInput): string | null {
  const s = sides(input, RecordsFileSchema)
  if (!s) return null
  const { b, o, t } = s
  return finish('records', 'records', RecordsFileSchema, b, o, t, joinById(b?.records, o.records, t.records, pickRecord))
}

type HistoryEntry = ProtocolFile['history'][number]

/** Earlier versions by number; null when one number holds two different bodies. */
function historyByVersion(entries: HistoryEntry[]): Map<number, ProtocolBody> | null {
  const out = new Map<number, ProtocolBody>()
  for (const h of entries) {
    const known = out.get(h.version)
    if (known && !isDeepStrictEqual(known, h.protocol)) return null
    out.set(h.version, h.protocol)
  }
  return out
}

/**
 * What decisions and suggestions point to: the current body and its number, and each earlier version's body by number
 * (the date it was replaced is not part of it, so the same edit made on two machines is the same protocol).
 */
function versions(p: ProtocolFile): { protocol: ProtocolBody; version: number; history: [number, ProtocolBody][] } | null {
  const history = historyByVersion(p.history)
  if (!history) return null
  return { protocol: p.protocol, version: p.version, history: [...history].sort(([x], [y]) => x - y) }
}

/** Both histories, one entry per version (the earliest replacement date; unknown keys of both kept); null on a clash. */
function joinHistory(base: HistoryEntry[], a: HistoryEntry[], c: HistoryEntry[]): HistoryEntry[] | null {
  const before = new Map(base.map((h) => [h.version, h]))
  const out = new Map<number, HistoryEntry>()
  for (const h of [...a, ...c]) {
    const known = out.get(h.version)
    if (!known) {
      out.set(h.version, h)
      continue
    }
    if (!isDeepStrictEqual(known.protocol, h.protocol)) return null
    const keys = mergeKeys(before.get(h.version), known, h, ['replaced_at'])
    if (keys === CLASH) return null
    out.set(h.version, { ...keys, replaced_at: earlier(known, h, (x) => x.replaced_at).replaced_at } as HistoryEntry)
  }
  return [...out.values()]
}

/**
 * protocol.yaml. The body, its version and the earlier versions are what decisions and suggestions point to (by
 * number), so they are taken from the one side that changed them; when both machines changed them differently (two
 * new versions from one base, the same new criterion id worded differently, an in-place edit on each) nothing is
 * merged: renumbering either side would relabel the decisions made with it, so the file becomes the user's decision.
 * `last_ids` takes the highest number of each kind, `created_at` the earliest and `updated_at` the latest; any other
 * key goes key by key against the base.
 */
export function mergeProtocolText(input: MergeInput): string | null {
  const s = sides(input, ProtocolFileSchema)
  if (!s) return null
  const { b, o, t } = s
  const [vo, vt] = [versions(o), versions(t)]
  const vb = b ? versions(b) : null
  if (!vo || !vt) return null
  let source: ProtocolFile
  if (isDeepStrictEqual(vo, vt) || (vb && isDeepStrictEqual(vt, vb))) source = o
  else if (vb && isDeepStrictEqual(vo, vb)) source = t
  else return null
  const history = joinHistory(b?.history ?? [], o.history, t.history)
  if (!history) return null
  const rest = mergeKeys(b ?? undefined, o, t, ['protocol', 'version', 'history', 'last_ids', 'created_at', 'updated_at'])
  if (rest === CLASH) return null
  const lastIds: Loose = {}
  for (const key of [...new Set([...Object.keys(o.last_ids), ...Object.keys(t.last_ids)])].sort()) {
    const [x, y] = [o.last_ids[key], t.last_ids[key]]
    if (typeof x === 'number' && typeof y === 'number') lastIds[key] = Math.max(x, y)
    else if (x === undefined || isDeepStrictEqual(x, y)) lastIds[key] = y
    else if (y === undefined) lastIds[key] = x
    else return null
  }
  const merged = ProtocolFileSchema.safeParse({
    ...rest,
    protocol: source.protocol,
    version: source.version,
    history,
    last_ids: lastIds,
    created_at: earlier(o, t, (p) => p.created_at).created_at,
    updated_at: later(o, t, (p) => p.updated_at).updated_at
  })
  return merged.success ? toYaml(sortedMappingFile('protocol', merged.data)) : null
}
