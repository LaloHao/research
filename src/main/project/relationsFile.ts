import { parse } from 'yaml'
import { PaperAnalysisSchema, TypedRelationSchema, type PaperAnalysis, type RelationsFile, type TypedRelation } from '../../shared/typedRelations'

export const RELATIONS_FILE = 'relations.yaml'
export const EMPTY_RELATIONS: RelationsFile = { schema_version: 1, relations: [], analyzed: {} }

export function sortRelations(list: TypedRelation[]): TypedRelation[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const isMarker = (line: string, marker: string): boolean => line === marker || line.startsWith(`${marker} `)

/**
 * Both sides of every git conflict hunk: `ours` keeps the first side, `theirs` the second, and a diff3 base
 * section is dropped. Line endings are normalized to LF. null when the markers are unbalanced.
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

/** Union by id: the entry with the newest updated_at wins; a tie keeps `ours`. */
export function mergeRelations(ours: TypedRelation[], theirs: TypedRelation[]): TypedRelation[] {
  const byId = new Map(ours.map((r) => [r.id, r]))
  for (const r of theirs) {
    const current = byId.get(r.id)
    if (!current || r.updated_at > current.updated_at) byId.set(r.id, r)
  }
  return sortRelations([...byId.values()])
}

/** Union by paper: the most recent analysis wins; a tie keeps `ours`. */
export function mergeAnalyzed(ours: Record<string, PaperAnalysis>, theirs: Record<string, PaperAnalysis>): Record<string, PaperAnalysis> {
  const out = { ...ours }
  for (const [paper, a] of Object.entries(theirs)) if (!out[paper] || a.at > out[paper].at) out[paper] = a
  return out
}

/** The merged file for a relations.yaml with conflict markers; null when it cannot be resolved automatically. */
export function resolveConflictText(text: string): { file: RelationsFile; dropped: number } | null {
  const sides = splitConflict(text)
  if (!sides) return null
  const ours = lenientSide(sides.ours)
  const theirs = lenientSide(sides.theirs)
  if (!ours || !theirs) return null
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
