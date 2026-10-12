import { authorsLabel } from '../../shared/format'
import {
  DATABASE_KINDS,
  EMPTY_PHASE_VIEW,
  MAIN_REVIEWER,
  PHASE_STATES,
  PHASES,
  type ConflictOption,
  type Decision,
  type DuplicatePair,
  type MappingRecord,
  type MappingRecordRow,
  type Phase,
  type PhaseState,
  type PhaseView,
  type ProtocolFile,
  type QueueFilter,
  type RecordBrief,
  type ScreeningConflict,
  type ScreeningCounts,
  type ScreeningSuggestion,
  type Search,
  type SuggestionView
} from '../../shared/mapping'

/** Everything a mapping's files hold, read. */
export interface MappingContent {
  protocol: ProtocolFile
  searches: Search[]
  records: MappingRecord[]
  decisions: Decision[]
  suggestions: ScreeningSuggestion[]
}

const groupKey = (record: string, phase: Phase, reviewer: string): string => `${record}|${phase}|${reviewer}`
const byTime = <T extends { at: string; id: string }>(a: T, b: T): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const sameOutcome = (a: Decision, b: Decision): boolean => a.decision === b.decision && a.criterion === b.criterion

const groupOf = (d: Decision): string => groupKey(d.record, d.phase, d.reviewer)

/** Decisions by id; a repeated id (which the sync's union by id should never leave) keeps its first occurrence. */
function uniqueById(decisions: Decision[]): Map<string, Decision> {
  const byId = new Map<string, Decision>()
  for (const d of decisions) if (!byId.has(d.id)) byId.set(d.id, d)
  return byId
}

/**
 * For each record, phase and reviewer: the decisions no other decision replaced, oldest first. One head is the usual
 * case; several only arise when two machines decided before syncing. A `replaces` only counts inside its own record,
 * phase and reviewer, so a hand-edited or badly merged file never erases another record's decision. A cycle of
 * replacements (corrupt input) leaves its members out, so the record reads as pending.
 */
export function decisionHeads(decisions: Decision[]): Map<string, Decision[]> {
  const byId = uniqueById(decisions)
  const replaced = new Set<string>()
  for (const d of byId.values())
    for (const r of d.replaces) {
      const target = byId.get(r)
      if (target && target.id !== d.id && groupOf(target) === groupOf(d)) replaced.add(r)
    }
  const heads = new Map<string, Decision[]>()
  for (const d of [...byId.values()].sort(byTime)) {
    if (replaced.has(d.id)) continue
    const key = groupKey(d.record, d.phase, d.reviewer)
    heads.set(key, [...(heads.get(key) ?? []), d])
  }
  return heads
}

export function headsOf(heads: ReadonlyMap<string, Decision[]>, record: string, phase: Phase, reviewer: string = MAIN_REVIEWER): Decision[] {
  return heads.get(groupKey(record, phase, reviewer)) ?? []
}

const option = (d: Decision): ConflictOption => ({ decisionId: d.id, decision: d.decision, criterion: d.criterion, by: d.by, at: d.at, machine: d.machine })

/**
 * A record's state in one phase: pending, the agreed current decision, or a conflict between disagreeing heads.
 * Several agreeing heads give their shared state with no `decisionId`: «Deshacer» needs a single current decision.
 * A value that does not belong to the phase (`not_retrieved` on title and abstract) reads as pending.
 */
export function phaseView(heads: Decision[], protocolVersion: number): PhaseView {
  if (heads.length === 0) return EMPTY_PHASE_VIEW
  if (heads.some((h) => !sameOutcome(h, heads[0]))) return { ...EMPTY_PHASE_VIEW, state: 'conflict', options: heads.map(option) }
  const h = heads[heads.length - 1]
  if (h.decision === 'none' || (h.decision === 'not_retrieved' && h.phase !== 'full_text')) return EMPTY_PHASE_VIEW
  return {
    state: h.decision,
    criterion: h.criterion,
    decisionId: heads.length === 1 ? h.id : null,
    by: h.by,
    at: h.at,
    protocolVersion: h.protocol_version,
    outdated: h.protocol_version < protocolVersion,
    options: []
  }
}

export function activeSearchIds(searches: Search[]): Set<string> {
  return new Set(searches.filter((s) => !s.discarded).map((s) => s.id))
}

/** The newest suggestion of each record and phase. */
function latestSuggestions(list: ScreeningSuggestion[]): Map<string, ScreeningSuggestion> {
  const out = new Map<string, ScreeningSuggestion>()
  for (const s of [...list].sort(byTime)) out.set(`${s.record}|${s.phase}`, s)
  return out
}

function suggestionView(s: ScreeningSuggestion | undefined, version: number): SuggestionView | null {
  if (!s) return null
  return {
    id: s.id,
    decision: s.decision,
    criterion: s.criterion,
    justification: s.justification,
    quote: s.quote,
    page: s.page,
    found: s.found,
    model: s.model,
    at: s.at,
    outdated: s.protocol_version < version
  }
}

const fullName = (a: { family: string; given?: string }): string => (a.given ? `${a.given} ${a.family}` : a.family)
const byAdded = (a: MappingRecord, b: MappingRecord): number => byTime({ at: a.added_at, id: a.id }, { at: b.added_at, id: b.id })

/** One row per record, in record order, with its PRISMA column, its state in each phase and its latest suggestions. */
export function recordRows(c: MappingContent): MappingRecordRow[] {
  const live = activeSearchIds(c.searches)
  const kindOf = new Map(c.searches.map((s) => [s.id, s.kind]))
  const heads = decisionHeads(c.decisions)
  const latest = latestSuggestions(c.suggestions)
  const version = c.protocol.version
  return [...c.records].sort(byAdded).map((r): MappingRecordRow => {
    const sources = r.sources.filter((s) => live.has(s))
    return {
      id: r.id,
      title: r.title,
      authors_label: authorsLabel(r.authors),
      authors: r.authors.map(fullName).join(', '),
      year: r.year,
      venue: r.venue,
      abstract: r.abstract,
      kind: r.kind,
      doi: r.identifiers.doi ?? null,
      arxiv: r.identifiers.arxiv ?? null,
      openalex: r.identifiers.openalex ?? null,
      paper_id: r.paper_id,
      sources: r.sources,
      active: r.merged_into === null && sources.length > 0,
      column: sources.some((s) => DATABASE_KINDS.has(kindOf.get(s)!)) ? 'databases' : 'other',
      duplicate: r.duplicate_of ? { of: r.duplicate_of.record, reason: r.duplicate_of.reason } : null,
      title_abstract: phaseView(headsOf(heads, r.id, 'title_abstract'), version),
      full_text: phaseView(headsOf(heads, r.id, 'full_text'), version),
      suggestions: {
        title_abstract: suggestionView(latest.get(`${r.id}|title_abstract`), version),
        full_text: suggestionView(latest.get(`${r.id}|full_text`), version)
      },
      added_at: r.added_at
    }
  })
}

/** Whether a row belongs to a phase's queue under a filter. A record waiting for a duplicate decision shows only under «all». */
export function matchesFilter(row: MappingRecordRow, phase: Phase, filter: QueueFilter): boolean {
  if (!row.active) return false
  if (phase === 'full_text' && row.title_abstract.state !== 'include') return false
  if (row.duplicate && filter !== 'all') return false
  return filter === 'all' || row[phase].state === filter
}

const zeroCounts = (): Record<PhaseState, number> => Object.fromEntries(PHASE_STATES.map((s) => [s, 0])) as Record<PhaseState, number>

/**
 * Active records per phase and state, as the queues show them: full text counts only the records included on title
 * and abstract, and a record waiting for a duplicate decision is left out (it is in no queue but «all»).
 */
export function screeningCounts(rows: MappingRecordRow[]): ScreeningCounts {
  const counts = Object.fromEntries(PHASES.map((p) => [p, zeroCounts()])) as ScreeningCounts
  for (const row of rows) {
    if (!row.active || row.duplicate) continue
    counts.title_abstract[row.title_abstract.state]++
    if (row.title_abstract.state === 'include') counts.full_text[row.full_text.state]++
  }
  return counts
}

export function brief(row: MappingRecordRow): RecordBrief {
  return { id: row.id, title: row.title, authors_label: row.authors_label, year: row.year, venue: row.venue, doi: row.doi }
}

/** Active records waiting for «Es el mismo» or «Son distintos», with the record each may duplicate. */
export function duplicatePairs(rows: MappingRecordRow[]): DuplicatePair[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return rows.flatMap((row) => {
    const other = row.duplicate ? byId.get(row.duplicate.of) : undefined
    return row.active && row.duplicate && other ? [{ record: brief(row), other: brief(other), reason: row.duplicate.reason }] : []
  })
}

/** Records two machines decided differently, per phase; full text only while the record is included on title and abstract. */
export function conflictsOf(rows: MappingRecordRow[]): ScreeningConflict[] {
  return rows.flatMap((row) =>
    row.active
      ? PHASES.filter((p) => row[p].state === 'conflict' && (p === 'title_abstract' || row.title_abstract.state === 'include')).map((phase) => ({
          record: brief(row),
          phase,
          options: row[phase].options
        }))
      : []
  )
}

/**
 * The decision «Deshacer» appends for decision `id`: a copy of the decision it replaced (or `none` when it replaced
 * nothing). When it replaced several agreeing decisions (two machines decided alike), a copy of the newest. Null when
 * `id` is unknown, is no longer the only current decision of its record and phase, resolved a conflict (undoing that
 * would need two heads back), or names a replaced decision that is missing or belongs to another record, phase or
 * reviewer. Undoing an undo restores the undone decision.
 */
export function undoDecision(decisions: Decision[], id: string, ctx: { id: string; at: string; machine: string }): Decision | null {
  const byId = uniqueById(decisions)
  const target = byId.get(id)
  if (!target) return null
  const heads = headsOf(decisionHeads(decisions), target.record, target.phase, target.reviewer)
  if (heads.length !== 1 || heads[0].id !== id) return null
  const replaced = target.replaces.map((r) => byId.get(r))
  if (replaced.some((p) => p === undefined || p.id === target.id || groupOf(p) !== groupOf(target))) return null
  const previousList = (replaced as Decision[]).sort(byTime)
  if (previousList.some((p) => !sameOutcome(p, previousList[0]))) return null
  const previous = previousList.length > 0 ? previousList[previousList.length - 1] : null
  return {
    id: ctx.id,
    record: target.record,
    phase: target.phase,
    reviewer: target.reviewer,
    decision: previous?.decision ?? 'none',
    criterion: previous?.criterion ?? null,
    note: null,
    by: previous?.by ?? 'user',
    suggestion: previous?.suggestion ?? null,
    protocol_version: previous?.protocol_version ?? target.protocol_version,
    at: ctx.at,
    machine: ctx.machine,
    replaces: [id],
    undoes: id
  }
}
