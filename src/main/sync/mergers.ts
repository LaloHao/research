import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import { TrashedFileSchema } from '../../shared/trash'
import { RelationsFileSchema, type TypedRelation } from '../../shared/typedRelations'
import { lenientSide, mergeAnalyzed, mergeRelations, sortRelations, type LenientSide } from '../project/relationsFile'
import { toYaml } from '../project/yamlFile'

/** The three versions of a file both machines changed; `base` is null when both added it. */
export interface MergeInput {
  base: string | null
  ours: string
  theirs: string
}

/** The merged text, or null when the user has to pick a version. */
export type Merger = (input: MergeInput) => string | null

/** Ids of `base` that one side removed while the other left them exactly as they were: they stay removed. */
function removedIds<T>(base: ReadonlyMap<string, T>, ours: ReadonlyMap<string, T>, theirs: ReadonlyMap<string, T>): Set<string> {
  const out = new Set<string>()
  for (const [id, before] of base) {
    const o = ours.get(id)
    const t = theirs.get(id)
    if ((o === undefined && (t === undefined || isDeepStrictEqual(t, before))) || (t === undefined && isDeepStrictEqual(o, before))) out.add(id)
  }
  return out
}

const byId = (list: TypedRelation[]): Map<string, TypedRelation> => new Map(list.map((r) => [r.id, r]))
const foreignVersion = (side: LenientSide): boolean => side.raw.schema_version !== undefined && side.raw.schema_version !== 1

/**
 * When an id is in `base`, a side that left it exactly as the base had it is not a real edit: the other side's
 * version (if any) must win no matter what the timestamps say, because clock skew between machines can otherwise
 * make the untouched copy outrank a genuine one-sided edit. Mutates `ours` and `theirs` in place; only entries
 * both sides still have are touched, so removals (handled separately by `removedIds`) are unaffected.
 */
function preferChangedSide<T>(base: ReadonlyMap<string, T>, ours: Map<string, T>, theirs: Map<string, T>): void {
  for (const [id, before] of base) {
    const o = ours.get(id)
    const t = theirs.get(id)
    if (o === undefined || t === undefined) continue
    const oChanged = !isDeepStrictEqual(o, before)
    const tChanged = !isDeepStrictEqual(t, before)
    if (!oChanged && tChanged) ours.set(id, t)
    else if (oChanged && !tChanged) theirs.set(id, o)
  }
}

/**
 * relations.yaml: the same resolution as «Resolver automáticamente» (union by id, the newest `updated_at` wins, the same
 * for `analyzed`), plus the merge base so a removal one machine made and the other did not touch stays removed, and so
 * a one-sided edit always beats an untouched copy regardless of clock skew. Never merged when a side has invalid
 * entries (they would be dropped silently) or another schema version.
 */
export function mergeRelationsText({ base, ours, theirs }: MergeInput): string | null {
  const o = lenientSide(ours)
  const t = lenientSide(theirs)
  const b = base === null ? null : lenientSide(base)
  if (!o || !t || (base !== null && !b)) return null
  const sides = b ? [o, t, b] : [o, t]
  if (sides.some((s) => s.dropped > 0 || foreignVersion(s))) return null
  const oRelations = byId(o.relations)
  const tRelations = byId(t.relations)
  const oAnalyzed = new Map(Object.entries(o.analyzed))
  const tAnalyzed = new Map(Object.entries(t.analyzed))
  const goneRelations = b ? removedIds(byId(b.relations), oRelations, tRelations) : new Set<string>()
  const goneAnalyses = b ? removedIds(new Map(Object.entries(b.analyzed)), oAnalyzed, tAnalyzed) : new Set<string>()
  if (b) {
    preferChangedSide(byId(b.relations), oRelations, tRelations)
    preferChangedSide(new Map(Object.entries(b.analyzed)), oAnalyzed, tAnalyzed)
  }
  const relations = mergeRelations([...oRelations.values()], [...tRelations.values()]).filter((r) => !goneRelations.has(r.id))
  const analyzed = Object.fromEntries(
    Object.entries(mergeAnalyzed(Object.fromEntries(oAnalyzed), Object.fromEntries(tAnalyzed))).filter(([key]) => !goneAnalyses.has(key))
  )
  const file = RelationsFileSchema.safeParse({ ...t.raw, ...o.raw, schema_version: 1, relations: sortRelations(relations), analyzed })
  return file.success ? toYaml(file.data) : null
}

/** costs/<device>.jsonl is append-only: every line of both sides, once, this machine's first. */
export function mergeCostsText({ ours, theirs }: MergeInput): string {
  const lines = ours.split('\n').filter((line) => line.trim() !== '')
  const seen = new Set(lines)
  for (const line of theirs.split('\n')) {
    if (line.trim() === '' || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

const CLASH = Symbol('clash')
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** A three-way merge of plain YAML values: one side's change wins, nested objects merge key by key, the rest clashes. */
function merge3(base: unknown, ours: unknown, theirs: unknown, path: string): unknown {
  if (isDeepStrictEqual(ours, theirs)) return ours
  if (isDeepStrictEqual(ours, base)) return theirs
  if (isDeepStrictEqual(theirs, base)) return ours
  // Dismissed candidates never come back: both lists, joined.
  if (path === 'snowball.dismissed' && isStringList(ours) && isStringList(theirs)) return [...new Set([...ours, ...theirs])].sort()
  if (!isPlainObject(ours) || !isPlainObject(theirs)) return CLASH
  const before = isPlainObject(base) ? base : {}
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = merge3(before[key], ours[key], theirs[key], path ? `${path}.${key}` : key)
    if (value === CLASH) return CLASH
    if (value !== undefined) out[key] = value
  }
  return out
}

function yamlValue(text: string): unknown {
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

/** project.yaml: key by key against the merge base; the dismissed candidates are joined; the same key changed differently on both machines needs a decision. */
export function mergeProjectText({ base, ours, theirs }: MergeInput): string | null {
  const b = base === null ? {} : yamlValue(base)
  const o = yamlValue(ours)
  const t = yamlValue(theirs)
  if (!isPlainObject(o) || !isPlainObject(t) || !isPlainObject(b)) return null
  const merged = merge3(b, o, t, '')
  return merged === CLASH ? null : toYaml(merged)
}

/** `.trash/<key>/trashed.yaml` written on both machines: the most recent removal wins (a tie keeps ours). */
export function mergeTrashedText({ ours, theirs }: MergeInput): string | null {
  const o = TrashedFileSchema.safeParse(yamlValue(ours))
  const t = TrashedFileSchema.safeParse(yamlValue(theirs))
  if (!o.success || !t.success) return null
  return Date.parse(t.data.trashed_at) > Date.parse(o.data.trashed_at) ? theirs : ours
}

/** A generated file (exports/library.bib): this machine's copy; the app writes it again once the merged papers arrive. */
export function keepOurs({ ours }: MergeInput): string {
  return ours
}

const MERGERS: [RegExp, Merger][] = [
  [/^relations\.yaml$/, mergeRelationsText],
  [/^costs\/[A-Za-z0-9-]+\.jsonl$/, mergeCostsText],
  [/^project\.yaml$/, mergeProjectText],
  [/^\.trash\/[a-z][a-z0-9]*\/trashed\.yaml$/, mergeTrashedText],
  [/^exports\/library\.bib$/, keepOurs]
]

/** The merger for a file at `relPath` inside the project folder; null: a conflict there is the user's decision. */
export function mergerFor(relPath: string): Merger | null {
  return MERGERS.find(([pattern]) => pattern.test(relPath))?.[1] ?? null
}
