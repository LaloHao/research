import { describe, expect, it } from 'vitest'
import { lenientSide, mergeAnalyzed, mergeRelations, resolveConflictText, sortRelations, splitConflict } from '../../../src/main/project/relationsFile'
import { toYaml } from '../../../src/main/project/yamlFile'
import { relationId, type RelationType, type TypedRelation } from '../../../src/shared/typedRelations'

function rel(from: string, to: string, type: RelationType, over: Partial<TypedRelation> = {}): TypedRelation {
  return { id: relationId(from, to, type), type, from, to, status: 'suggested', edited: false, justification: 'j', evidence: [], updated_at: '2026-10-10T10:00:00.000Z', ...over }
}
const side = (list: TypedRelation[], extra: Record<string, unknown> = {}): string => toYaml({ schema_version: 1, relations: list, ...extra })
const conflict = (ours: string, theirs: string): string => `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> origin/main\n`

describe('splitConflict', () => {
  it('rebuilds both sides of every hunk and drops a diff3 base section', () => {
    const text = ['a', '<<<<<<< HEAD', 'b-ours', '||||||| base', 'b-base', '=======', 'b-theirs', '>>>>>>> other', 'c'].join('\n')
    expect(splitConflict(text)).toEqual({ ours: 'a\nb-ours\nc', theirs: 'a\nb-theirs\nc' })
  })

  it('reads files with Windows line endings', () => {
    expect(splitConflict('a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n')).toEqual({ ours: 'a\nx\n', theirs: 'a\ny\n' })
  })

  it('returns the text unchanged on both sides when there are no markers, and null when markers are unbalanced', () => {
    expect(splitConflict('x\ny')).toEqual({ ours: 'x\ny', theirs: 'x\ny' })
    expect(splitConflict('<<<<<<< HEAD\nx\n=======\ny')).toBeNull()
    expect(splitConflict('=======\ny')).toBeNull()
  })
})

describe('mergeRelations / mergeAnalyzed', () => {
  it('unites both sides by id; the newest updated_at wins and a tie keeps ours; the result is sorted', () => {
    const a = rel('zhu2020loghub', 'he2017drain', 'extends', { status: 'confirmed', updated_at: '2026-10-10T11:00:00.000Z' })
    const aOld = { ...a, status: 'suggested' as const, updated_at: '2026-10-10T09:00:00.000Z' }
    const b = rel('am2019x', 'zz2020y', 'same_problem')
    const c = rel('am2019x', 'he2017drain', 'compares_with')
    const cTheirs = { ...c, status: 'rejected' as const }
    expect(mergeRelations([a, c], [aOld, b, cTheirs])).toEqual(sortRelations([a, b, c]))
    expect(mergeRelations([aOld], [a])).toEqual([a])
  })

  it('keeps the most recent analysis of each paper', () => {
    const old = { candidates: ['a1'], at: '2026-10-09T00:00:00.000Z' }
    const recent = { candidates: ['a1', 'b1'], at: '2026-10-10T00:00:00.000Z' }
    expect(mergeAnalyzed({ p1: old, p2: old }, { p1: recent, p3: old })).toEqual({ p1: recent, p2: old, p3: old })
  })
})

describe('lenientSide / resolveConflictText', () => {
  it('counts invalid entries instead of failing, and reads an empty side as no relations', () => {
    const good = rel('zhu2020loghub', 'he2017drain', 'extends')
    expect(lenientSide(side([good, { id: 'broken' } as unknown as TypedRelation]))).toMatchObject({ relations: [good], dropped: 1 })
    expect(lenientSide('')).toEqual({ raw: {}, relations: [], analyzed: {}, dropped: 0 })
    expect(lenientSide('just text')).toBeNull()
  })

  it('resolves a whole-file conflict into the union of both sides, keeping unknown keys and reporting dropped entries', () => {
    const ours = rel('zhu2020loghub', 'he2017drain', 'extends', { status: 'confirmed', updated_at: '2026-10-10T12:00:00.000Z' })
    const theirs = rel('zhu2020loghub', 'he2017drain', 'extends', { status: 'rejected', updated_at: '2026-10-10T08:00:00.000Z' })
    const other = rel('am2019x', 'he2017drain', 'same_problem')
    const analyzed = { zhu2020loghub: { candidates: ['he2017drain'], at: '2026-10-10T12:00:00.000Z' } }
    const text = conflict(side([ours], { future_key: 'x', analyzed }), side([theirs, other, { id: 'broken' } as unknown as TypedRelation]))
    expect(resolveConflictText(text)).toEqual({
      file: { schema_version: 1, future_key: 'x', relations: sortRelations([ours, other]), analyzed },
      dropped: 1
    })
    expect(resolveConflictText('<<<<<<< HEAD\nrelations: [\n=======\nx\n>>>>>>> b\n')).toBeNull()
  })
})
