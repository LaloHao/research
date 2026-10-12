import { describe, expect, it } from 'vitest'
import {
  carriedDecisionId,
  carriedDecisions,
  conflictsOf,
  decisionHeads,
  decisionProblem,
  duplicatePairs,
  headsOf,
  matchesFilter,
  phaseView,
  recordRows,
  screeningCounts,
  undoDecision,
  type MappingContent
} from '../../../src/main/mapping/screening'
import type { Decision } from '../../../src/shared/mapping'
import { AT, decision, hexId, protocolFile, record, search, suggestion } from '../../helpers/mappings'

const R1 = hexId('r', 1)
const R2 = hexId('r', 2)
const d = (n: number, over: Partial<Decision> = {}): Decision => decision({ id: hexId('d', n), at: `2026-10-12T10:0${n}:00.000Z`, ...over })
const content = (over: Partial<MappingContent> = {}): MappingContent => ({
  protocol: protocolFile(),
  searches: [search()],
  records: [record()],
  decisions: [],
  suggestions: [],
  ...over
})

describe('decision heads and phase views', () => {
  it('takes the latest decision of each record and phase as current', () => {
    const heads = decisionHeads([d(1), d(2, { decision: 'exclude', criterion: 'E1', replaces: [hexId('d', 1)] })])
    expect(phaseView(headsOf(heads, R1, 'title_abstract'), 1)).toEqual({
      state: 'exclude',
      criterion: 'E1',
      decisionId: hexId('d', 2),
      by: 'user',
      at: '2026-10-12T10:02:00.000Z',
      protocolVersion: 1,
      outdated: false,
      options: []
    })
    expect(phaseView(headsOf(heads, R1, 'full_text'), 1).state).toBe('pending')
  })

  it('shows a conflict when two machines replaced the same decision differently, but not when they agree', () => {
    const first = d(1)
    const a = d(2, { decision: 'exclude', criterion: 'E1', replaces: [first.id], machine: 'machine-a' })
    const b = d(3, { decision: 'uncertain', replaces: [first.id], machine: 'machine-b' })
    const view = phaseView(headsOf(decisionHeads([first, a, b]), R1, 'title_abstract'), 1)
    expect(view).toMatchObject({ state: 'conflict', decisionId: null })
    expect(view.options.map((o) => [o.decisionId, o.machine])).toEqual([
      [a.id, 'machine-a'],
      [b.id, 'machine-b']
    ])
    const same = d(3, { decision: 'exclude', criterion: 'E1', replaces: [first.id], machine: 'machine-b' })
    // Agreeing heads share their state, but there is no single decision for «Deshacer» to take back.
    expect(phaseView(headsOf(decisionHeads([first, a, same]), R1, 'title_abstract'), 1)).toMatchObject({ state: 'exclude', criterion: 'E1', decisionId: null })
  })

  it('clears a conflict once a decision replaces both heads, and keeps reviewers apart', () => {
    const first = d(1)
    const a = d(2, { decision: 'exclude', criterion: 'E1', replaces: [first.id], machine: 'machine-a' })
    const b = d(3, { decision: 'uncertain', replaces: [first.id], machine: 'machine-b' })
    const resolved = d(4, { decision: 'uncertain', replaces: [a.id, b.id] })
    const heads = decisionHeads([first, a, b, resolved])
    expect(headsOf(heads, R1, 'title_abstract').map((h) => h.id)).toEqual([resolved.id])
    expect(phaseView(headsOf(heads, R1, 'title_abstract'), 1)).toMatchObject({ state: 'uncertain', decisionId: resolved.id })
    const second = d(5, { reviewer: 'second', decision: 'exclude', criterion: 'E2' })
    const both = decisionHeads([first, second])
    expect(headsOf(both, R1, 'title_abstract').map((h) => h.id)).toEqual([first.id])
    expect(headsOf(both, R1, 'title_abstract', 'second').map((h) => h.id)).toEqual([second.id])
  })

  it('counts a replacement only within its own record, phase and reviewer', () => {
    const r1 = d(1)
    const r2 = d(2, { record: R2, decision: 'exclude', criterion: 'E1', replaces: [r1.id] })
    const otherPhase = d(3, { phase: 'full_text', replaces: [r1.id] })
    const second = d(4, { reviewer: 'second', replaces: [r1.id], decision: 'exclude', criterion: 'E2' })
    const heads = decisionHeads([r1, r2, otherPhase, second])
    expect(phaseView(headsOf(heads, R1, 'title_abstract'), 1)).toMatchObject({ state: 'include', decisionId: r1.id })
    expect(phaseView(headsOf(heads, R2, 'title_abstract'), 1)).toMatchObject({ state: 'exclude', decisionId: r2.id })
    const self = d(5, { replaces: [hexId('d', 5)] })
    expect(headsOf(decisionHeads([self]), R1, 'title_abstract').map((h) => h.id)).toEqual([self.id])
  })

  it('reads a repeated decision id once', () => {
    const first = d(1)
    expect(phaseView(headsOf(decisionHeads([first, { ...first }]), R1, 'title_abstract'), 1)).toMatchObject({ state: 'include', decisionId: first.id })
  })

  it('reads «not_retrieved» on title and abstract as pending', () => {
    expect(phaseView([d(1, { decision: 'not_retrieved' })], 1).state).toBe('pending')
    expect(phaseView([d(1, { phase: 'full_text', decision: 'not_retrieved' })], 1).state).toBe('not_retrieved')
  })

  it('reads «none» as pending and marks a decision made with an earlier protocol', () => {
    expect(phaseView([d(1, { decision: 'none' })], 1).state).toBe('pending')
    expect(phaseView([d(1)], 2)).toMatchObject({ state: 'include', outdated: true, protocolVersion: 1 })
  })
})

describe('recordRows', () => {
  it('builds rows with their column, states, latest suggestion and labels', () => {
    const snow = search({ id: hexId('s', 2), kind: 'snowball', database: 'OpenAlex' })
    const rows = recordRows(
      content({
        searches: [search(), snow],
        records: [
          record({ authors: [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }] }),
          record({ id: R2, title: 'Other', identifiers: {}, sources: [snow.id], added_at: '2026-10-12T09:30:00.000Z' })
        ],
        decisions: [d(1)],
        suggestions: [suggestion({ id: hexId('g', 1), at: AT }), suggestion({ id: hexId('g', 2), at: '2026-10-12T09:45:00.000Z', decision: 'exclude', criterion: 'E1' })]
      })
    )
    expect(rows.map((r) => [r.id, r.column, r.active])).toEqual([
      [R1, 'databases', true],
      [R2, 'other', true]
    ])
    expect(rows[0]).toMatchObject({ authors_label: 'He & Zhu', authors: 'Pinjia He, Jieming Zhu', doi: '10.1109/icws.2017.13', title_abstract: { state: 'include' } })
    expect(rows[0].suggestions.title_abstract).toMatchObject({ id: hexId('g', 2), decision: 'exclude', outdated: false })
    expect(rows[1].suggestions).toEqual({ title_abstract: null, full_text: null })
  })

  it('leaves out of the screening a record merged into another, or brought only by discarded searches', () => {
    const rows = recordRows(
      content({
        searches: [search({ discarded: { at: AT, reason: 'Wrong string.', machine: 'machine-a' } })],
        records: [record(), record({ id: R2, merged_into: R1 })]
      })
    )
    expect(rows.map((r) => r.active)).toEqual([false, false])
  })
})

describe('queues and lists', () => {
  const rows = recordRows(
    content({
      records: [
        record(),
        record({ id: R2, title: 'Waiting duplicate', identifiers: {}, duplicate_of: { record: R1, reason: 'same_title' } }),
        record({ id: hexId('r', 3), title: 'Third', identifiers: {} })
      ],
      decisions: [d(1), d(2, { record: hexId('r', 3), decision: 'exclude', criterion: 'E2' })]
    })
  )

  it('filters by phase and state; full text only takes records included on title and abstract; a waiting duplicate shows only under «all»', () => {
    expect(rows.filter((r) => matchesFilter(r, 'title_abstract', 'pending')).map((r) => r.id)).toEqual([])
    expect(rows.filter((r) => matchesFilter(r, 'title_abstract', 'all')).map((r) => r.id)).toEqual([R1, R2, hexId('r', 3)])
    expect(rows.filter((r) => matchesFilter(r, 'full_text', 'pending')).map((r) => r.id)).toEqual([R1])
    expect(rows.filter((r) => matchesFilter(r, 'full_text', 'all')).map((r) => r.id)).toEqual([R1])
  })

  it('counts states per phase, and lists the waiting duplicates', () => {
    const counts = screeningCounts(rows)
    // The waiting duplicate is in no queue but «all», so it is not counted as pending either.
    expect(counts.title_abstract).toMatchObject({ pending: 0, include: 1, exclude: 1 })
    expect(counts.full_text).toMatchObject({ pending: 1, include: 0 })
    expect(duplicatePairs(rows)).toEqual([
      {
        record: { id: R2, title: 'Waiting duplicate', authors_label: 'He', year: 2017, venue: 'ICWS', doi: null },
        other: { id: R1, title: record().title, authors_label: 'He', year: 2017, venue: 'ICWS', doi: '10.1109/icws.2017.13' },
        reason: 'same_title'
      }
    ])
  })

  it('lists the conflicts with their options', () => {
    const first = d(1)
    const conflicted = recordRows(content({ decisions: [first, d(2, { decision: 'exclude', criterion: 'E1', replaces: [first.id] }), d(3, { replaces: [first.id], decision: 'uncertain' })] }))
    expect(conflictsOf(conflicted)).toEqual([{ record: expect.objectContaining({ id: R1 }), phase: 'title_abstract', options: [expect.objectContaining({ decisionId: hexId('d', 2) }), expect.objectContaining({ decisionId: hexId('d', 3) })] }])
  })
})

describe('conflictsOf on full text', () => {
  it('leaves out a full-text conflict once the record is no longer included on title and abstract', () => {
    const ta = d(1)
    const ft = d(2, { phase: 'full_text' })
    const a = d(3, { phase: 'full_text', replaces: [ft.id], decision: 'exclude', criterion: 'E1' })
    const b = d(4, { phase: 'full_text', replaces: [ft.id], decision: 'uncertain' })
    expect(conflictsOf(recordRows(content({ decisions: [ta, ft, a, b] }))).map((c) => c.phase)).toEqual(['full_text'])
    const excluded = d(5, { replaces: [ta.id], decision: 'exclude', criterion: 'E1' })
    expect(conflictsOf(recordRows(content({ decisions: [ta, ft, a, b, excluded] })))).toEqual([])
  })
})

describe('undoDecision', () => {
  const ctx = { id: hexId('d', 9), at: '2026-10-12T11:00:00.000Z', machine: 'machine-a' }

  it('restores the decision the undone one replaced, or none', () => {
    const first = d(1)
    const second = d(2, { decision: 'exclude', criterion: 'E1', replaces: [first.id] })
    expect(undoDecision([first, second], second.id, ctx)).toMatchObject({ id: ctx.id, decision: 'include', criterion: null, replaces: [second.id], undoes: second.id, at: ctx.at })
    expect(undoDecision([first], first.id, ctx)).toMatchObject({ decision: 'none', criterion: null, replaces: [first.id], undoes: first.id })
  })

  it('refuses a decision that is no longer current, an unknown one and a conflict resolution', () => {
    const first = d(1)
    const second = d(2, { replaces: [first.id], decision: 'uncertain' })
    expect(undoDecision([first, second], first.id, ctx)).toBeNull()
    expect(undoDecision([first], hexId('d', 7), ctx)).toBeNull()
    const a = d(2, { replaces: [first.id], decision: 'exclude', criterion: 'E1' })
    const b = d(3, { replaces: [first.id], decision: 'uncertain' })
    const resolved = d(4, { replaces: [a.id, b.id], decision: 'uncertain' })
    expect(undoDecision([first, a, b, resolved], resolved.id, ctx)).toBeNull()
  })

  it('undoes a decision made over two agreeing heads by restoring the newest of them', () => {
    const first = d(1)
    const a = d(2, { replaces: [first.id], decision: 'exclude', criterion: 'E1', machine: 'machine-a' })
    const b = d(3, { replaces: [first.id], decision: 'exclude', criterion: 'E1', machine: 'machine-b' })
    expect(undoDecision([first, a, b], b.id, ctx)).toBeNull()
    const next = d(4, { replaces: [a.id, b.id], decision: 'include' })
    expect(undoDecision([first, a, b, next], next.id, ctx)).toMatchObject({ decision: 'exclude', criterion: 'E1', replaces: [next.id], undoes: next.id, machine: 'machine-a' })
  })

  it('refuses when the replaced decision belongs to another record, phase or reviewer, or is missing', () => {
    const other = d(1, { record: R2 })
    const target = d(2, { replaces: [other.id], decision: 'exclude', criterion: 'E1' })
    expect(undoDecision([other, target], target.id, ctx)).toBeNull()
    const otherPhase = d(3, { phase: 'full_text' })
    const target2 = d(4, { replaces: [otherPhase.id] })
    expect(undoDecision([otherPhase, target2], target2.id, ctx)).toBeNull()
    const orphan = d(5, { replaces: [hexId('d', 77)] })
    expect(undoDecision([orphan], orphan.id, ctx)).toBeNull()
  })
})

describe('decisionProblem', () => {
  const p = protocolFile()
  it('needs a fitting criterion, full text only after an inclusion, and «not retrieved» only on full text', () => {
    expect(decisionProblem({ phase: 'title_abstract', decision: 'exclude', criterion: 'E1' }, p, 'pending')).toBeNull()
    expect(decisionProblem({ phase: 'title_abstract', decision: 'exclude', criterion: null }, p, 'pending')).toBe('criterion_required')
    expect(decisionProblem({ phase: 'title_abstract', decision: 'exclude', criterion: 'E9' }, p, 'pending')).toBe('criterion_required')
    expect(decisionProblem({ phase: 'title_abstract', decision: 'uncertain', criterion: 'I1' }, p, 'pending')).toBe('criterion_required')
    expect(decisionProblem({ phase: 'title_abstract', decision: 'not_retrieved', criterion: null }, p, 'pending')).toBe('not_eligible')
    expect(decisionProblem({ phase: 'full_text', decision: 'include', criterion: null }, p, 'uncertain')).toBe('not_eligible')
    expect(decisionProblem({ phase: 'full_text', decision: 'not_retrieved', criterion: null }, p, 'include')).toBeNull()
  })
})

describe('protocol versions for criterion labels', () => {
  it('gives each conflict option and suggestion the protocol version it was made with', () => {
    const first = d(1)
    const a = d(2, { decision: 'exclude', criterion: 'E1', replaces: [first.id], protocol_version: 1 })
    const b = d(3, { decision: 'exclude', criterion: 'E2', replaces: [first.id], protocol_version: 2 })
    const [row] = recordRows(content({ protocol: protocolFile({ version: 2 }), decisions: [first, a, b], suggestions: [suggestion({ protocol_version: 1 })] }))
    expect(row.title_abstract.options.map((o) => [o.decisionId, o.protocolVersion])).toEqual([
      [a.id, 1],
      [b.id, 2]
    ])
    expect(row.suggestions.title_abstract).toMatchObject({ protocolVersion: 1, outdated: true })
  })
})

describe('carriedDecisions («Es el mismo»)', () => {
  const merged = R2
  const survivor = R1

  it('copies the merged record’s current decisions onto the survivor, with ids derived from both', () => {
    const old = d(1, { record: merged })
    const head = d(2, { record: merged, decision: 'exclude', criterion: 'E1', replaces: [old.id], by: 'suggestion', suggestion: hexId('g', 1), machine: 'machine-b' })
    const ft = d(3, { record: merged, phase: 'full_text', decision: 'none' })
    const copies = carriedDecisions([old, head, ft], merged, survivor)
    expect(copies).toEqual([
      {
        ...head,
        id: carriedDecisionId(head.id, survivor),
        record: survivor,
        by: 'user',
        suggestion: null,
        replaces: [],
        undoes: null,
        copied_from: head.id
      }
    ])
    expect(carriedDecisionId(head.id, survivor)).toMatch(/^d[0-9a-f]{12}$/)
    expect(carriedDecisionId(head.id, survivor)).toBe(carriedDecisionId(head.id, survivor))
    expect(carriedDecisionId(head.id, survivor)).not.toBe(carriedDecisionId(head.id, hexId('r', 3)))
    // Already copied (a retry, or the other machine made the same merge): nothing more.
    expect(carriedDecisions([old, head, ft, ...copies], merged, survivor)).toEqual([])
  })

  it('adds nothing where the survivor already agrees, and a disagreement becomes a conflict', () => {
    const mine = d(1, { record: survivor, decision: 'include' })
    const alike = d(2, { record: merged, decision: 'include' })
    expect(carriedDecisions([mine, alike], merged, survivor)).toEqual([])
    const unlike = d(3, { record: merged, decision: 'uncertain' })
    const copies = carriedDecisions([mine, unlike], merged, survivor)
    expect(copies).toHaveLength(1)
    const [row] = recordRows(content({ records: [record({ id: survivor })], decisions: [mine, unlike, ...copies] }))
    expect(row.title_abstract.state).toBe('conflict')
  })

  it('replaces a survivor’s decision that was undone back to none, instead of a conflict with it', () => {
    const mine = d(1, { record: survivor })
    const undone = d(2, { record: survivor, decision: 'none', replaces: [mine.id], undoes: mine.id })
    const theirs = d(3, { record: merged, decision: 'exclude', criterion: 'E2' })
    const copies = carriedDecisions([mine, undone, theirs], merged, survivor)
    expect(copies).toMatchObject([{ replaces: [undone.id] }])
    const [row] = recordRows(content({ records: [record({ id: survivor })], decisions: [mine, undone, theirs, ...copies] }))
    expect(row.title_abstract).toMatchObject({ state: 'exclude', criterion: 'E2' })
  })
})
