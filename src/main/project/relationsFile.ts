import { parse } from 'yaml'
import { PaperAnalysisSchema, TypedRelationSchema, type PaperAnalysis, type RelationsFile, type TypedRelation } from '../../shared/typedRelations'

export const RELATIONS_FILE = 'relations.yaml'
export const EMPTY_RELATIONS: RelationsFile = { schema_version: 1, relations: [], analyzed: {} }

export function sortRelations(list: TypedRelation[]): TypedRelation[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const isMarker = (line: string, marker: string): boolean => line === marker || line.startsWith(`${marker} `)

/** A real conflict marker always starts at column 0; the same text indented inside a block scalar, or inline inside a quoted string, does not match. */
const HAS_CONFLICT_MARKER = /^<{7} /m

/**
 * Both sides of every git conflict hunk. `ours` keeps the first side (between `<<<<<<<` and `=======`,
 * i.e. HEAD — during a rebase this is the upstream commit being replayed onto, not the work in progress),
 * `theirs` the second, and a diff3 base section is dropped. Line endings are normalized to LF. null when
 * the markers are unbalanced.
 */
export function splitConflict(text: string): { ours: string; theirs: string } | null {
  const ours: string[] = []
  const theirs: string[] = []
  let state: 'both' | 'ours' | 'base' | 'theirs' = 'both'
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (isMarker(line, '<<<<<<<')) {
      if (state !== 'both') return null
      state = 'ours'
    } else if (isMarker(line, '|||||||')) {
      if (state !== 'ours') return null
      state = 'base'
    } else if (line === '=======') {
      if (state !== 'ours' && state !== 'base') return null
      state = 'theirs'
    } else if (isMarker(line, '>>>>>>>')) {
      if (state !== 'theirs') return null
      state = 'both'
    } else {
      if (state === 'both' || state === 'ours') ours.push(line)
      if (state === 'both' || state === 'theirs') theirs.push(line)
    }
  }
  return state === 'both' ? { ours: ours.join('\n'), theirs: theirs.join('\n') } : null
}

export interface LenientSide {
  /** The side's top-level keys as written, so keys of a later version survive the resolution. */
  raw: Record<string, unknown>
  relations: TypedRelation[]
  analyzed: Record<string, PaperAnalysis>
  /** Entries (relations or analyses) that failed validation and were left out. */
  dropped: number
}

/** One side of a conflict, read leniently: an invalid entry is counted and skipped. null when it is not a relations file at all. */
export function lenientSide(text: string): LenientSide | null {
  let raw: unknown
  try {
    raw = parse(text)
  } catch {
    return null
  }
  if (raw === null || raw === undefined) return { raw: {}, relations: [], analyzed: {}, dropped: 0 }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.relations !== undefined && !Array.isArray(obj.relations)) return null
  let dropped = 0
  const relations = ((obj.relations as unknown[] | undefined) ?? []).flatMap((e) => {
    const r = TypedRelationSchema.safeParse(e)
    if (!r.success) dropped++
    return r.success ? [r.data] : []
  })
  const analyzed: Record<string, PaperAnalysis> = {}
  const rawAnalyzed = obj.analyzed && typeof obj.analyzed === 'object' && !Array.isArray(obj.analyzed) ? (obj.analyzed as Record<string, unknown>) : {}
  for (const [key, value] of Object.entries(rawAnalyzed)) {
    const a = PaperAnalysisSchema.safeParse(value)
    if (a.success && /^[a-z][a-z0-9]*$/.test(key)) analyzed[key] = a.data
    else dropped++
  }
  return { raw: obj, relations, analyzed, dropped }
}

/** `Date.parse`; an unparseable timestamp is treated as the oldest possible time, so it always loses instead of throwing or sorting arbitrarily. */
function parseTime(timestamp: string): number {
  const t = Date.parse(timestamp)
  return Number.isNaN(t) ? -Infinity : t
}

/** Union by id: the entry with the newest `updated_at` (by `Date.parse`) wins; a tie, including two invalid timestamps, keeps `ours`. */
export function mergeRelations(ours: TypedRelation[], theirs: TypedRelation[]): TypedRelation[] {
  const byId = new Map(ours.map((r) => [r.id, r]))
  for (const r of theirs) {
    const current = byId.get(r.id)
    if (!current || parseTime(r.updated_at) > parseTime(current.updated_at)) byId.set(r.id, r)
  }
  return sortRelations([...byId.values()])
}

/** Union by paper: the most recent analysis (by `Date.parse` of `at`) wins; a tie keeps `ours`. */
export function mergeAnalyzed(ours: Record<string, PaperAnalysis>, theirs: Record<string, PaperAnalysis>): Record<string, PaperAnalysis> {
  const out = { ...ours }
  for (const [paper, a] of Object.entries(theirs)) if (!out[paper] || parseTime(a.at) > parseTime(out[paper].at)) out[paper] = a
  return out
}

/** Whether a lenient side's own `schema_version` (when present) is anything but 1 — resolving must never silently downgrade it. */
function hasForeignSchemaVersion(side: LenientSide): boolean {
  return side.raw.schema_version !== undefined && side.raw.schema_version !== 1
}

/**
 * The merged file for a relations.yaml with conflict markers; null when it cannot be resolved automatically:
 * the text has no conflict markers at all (nothing to resolve — never rewrite a clean or already-hand-fixed
 * file), the markers are unbalanced, either side is not a relations file, or either side declares a
 * `schema_version` other than 1 (a future format must never be silently merged as if it were this one).
 */
export function resolveConflictText(text: string): { file: RelationsFile; dropped: number } | null {
  if (!HAS_CONFLICT_MARKER.test(text)) return null
  const sides = splitConflict(text)
  if (!sides) return null
  const ours = lenientSide(sides.ours)
  const theirs = lenientSide(sides.theirs)
  if (!ours || !theirs) return null
  if (hasForeignSchemaVersion(ours) || hasForeignSchemaVersion(theirs)) return null
  return {
    file: {
      ...theirs.raw,
      ...ours.raw,
      schema_version: 1,
      relations: mergeRelations(ours.relations, theirs.relations),
      analyzed: mergeAnalyzed(ours.analyzed, theirs.analyzed)
    },
    dropped: ours.dropped + theirs.dropped
  }
}
