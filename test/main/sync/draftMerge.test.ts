import { describe, expect, it } from 'vitest'
import { parseDraft, renderDraft } from '../../../src/main/project/draftFile'
import { DRAFT_PATH, draftIdOfPath, mergeDraftText } from '../../../src/main/sync/draftMerge'
import type { DraftFile } from '../../../src/shared/writing/draft'
import { DRAFT_ID_A, draftFile, draftVersion } from '../../helpers/drafts'

const text = (f: DraftFile): string => renderDraft(f)
const read = (t: string): DraftFile => {
  const r = parseDraft(t)
  if (!r.ok) throw new Error(r.problem.message)
  return r.value
}
const V1 = draftVersion({ at: '2026-10-22T12:00:05.000Z' })
const V2 = draftVersion({ at: '2026-10-22T13:00:05.000Z', cost_usd: 0.2 })
const BASE = draftFile(['First.'], {}, [V1])

describe('mergeDraftText', () => {
  it('recognizes draft paths only', () => {
    expect(draftIdOfPath(`drafts/${DRAFT_ID_A}.md`)).toBe(DRAFT_ID_A)
    expect(draftIdOfPath(`chats/${DRAFT_ID_A}.md`)).toBeNull()
    expect(DRAFT_PATH.test('drafts/notes.md')).toBe(false)
  })

  it('merges a draft only one machine regenerated, taking the title from the machine that renamed it', () => {
    const ours = draftFile(['First.', 'Second.'], { papers: ['he2017drain', 'zhu2020loghub'], updated_at: '2026-10-22T13:00:05.000Z' }, [V1, V2])
    const theirs = draftFile(['First.'], { title: 'Parsers', updated_at: '2026-10-22T12:30:00.000Z', updated_on: 'desktop' }, [V1])
    const merged = mergeDraftText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!
    expect(merged.copy).toBeNull()
    expect(read(merged.text)).toEqual({ meta: { ...ours.meta, title: 'Parsers', cost_usd: 0.3 }, texts: ['First.', 'Second.'] })
  })

  it('takes the longer side when it is theirs, and «archivado» changed on both from the newest change', () => {
    const ours = draftFile(['First.'], { archived: true, updated_at: '2026-10-22T15:00:00.000Z' }, [V1])
    const theirs = draftFile(['First.', 'Second.'], { archived: false, updated_at: '2026-10-22T16:00:00.000Z', updated_on: 'desktop' }, [V1, V2])
    const base = draftFile(['First.'], { archived: true }, [V1])
    const merged = read(mergeDraftText({ base: text(base), ours: text(ours), theirs: text(theirs) })!.text)
    expect(merged.texts).toEqual(['First.', 'Second.'])
    expect(merged.meta).toMatchObject({ archived: false, updated_on: 'desktop' })
  })

  it('keeps both when the current version was edited differently, theirs as a copy named after its machine', () => {
    const ours = draftFile(['First, edited here.'], { updated_at: '2026-10-22T13:00:00.000Z' }, [{ ...V1, edited_at: '2026-10-22T13:00:00.000Z' }])
    const theirs = draftFile(['First, edited there.'], { updated_at: '2026-10-22T13:10:00.000Z', updated_on: 'desktop' }, [{ ...V1, edited_at: '2026-10-22T13:10:00.000Z' }])
    const merged = mergeDraftText({ base: text(BASE), ours: text(ours), theirs: text(theirs) }, DRAFT_ID_A)!
    expect(merged.text).toBe(text(ours))
    expect(merged.copy!.relPath).toMatch(new RegExp(`^drafts/${DRAFT_ID_A}-[0-9a-f]{6}\\.md$`))
    const copy = read(merged.copy!.text)
    expect(copy.texts).toEqual(['First, edited there.'])
    expect(copy.meta).toMatchObject({ copy_of: { id: DRAFT_ID_A, machine: 'desktop' } })
    expect(copy.meta.id).toBe(merged.copy!.relPath.slice('drafts/'.length, -3))
    // The same two versions always give the same copy.
    expect(mergeDraftText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!.copy).toEqual(merged.copy)
  })

  it('keeps both when each machine wrote a different new version', () => {
    const ours = draftFile(['First.', 'Ours.'], {}, [V1, V2])
    const theirs = draftFile(['First.', 'Theirs.'], { updated_on: 'desktop' }, [V1, V2])
    const merged = mergeDraftText({ base: text(BASE), ours: text(ours), theirs: text(theirs) })!
    expect(read(merged.copy!.text).texts).toEqual(['First.', 'Theirs.'])
  })

  it('leaves a side it cannot read, or an id that is not the file\'s, to the user', () => {
    expect(mergeDraftText({ base: null, ours: '<<<<<<< x\n', theirs: text(BASE) })).toBeNull()
    expect(mergeDraftText({ base: null, ours: text(BASE), theirs: text(BASE) }, '20261022-130000-ffff')).toBeNull()
  })
})
