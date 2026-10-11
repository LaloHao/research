import { describe, expect, it } from 'vitest'
import { mergeNotes, planMergeFile, reviewedCount } from '../../../src/main/library/trashMerge'
import { toFrontmatter, toYaml } from '../../../src/main/project/yamlFile'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'

const b = (s: string): Uint8Array => new TextEncoder().encode(s)
const summary = (verified: number, body = 'Body.'): string => {
  const s = sampleSummary()
  for (const k of (['tldr', 'problem', 'contribution'] as const).slice(0, verified)) s.fields[k].status = 'verified'
  return toFrontmatter(s, body)
}

describe('restore with merge', () => {
  it('counts what the user verified or edited, and -1 for a file that does not parse', () => {
    expect(reviewedCount('summary.md', summary(2))).toBe(2)
    expect(reviewedCount('extraction.yaml', toYaml(sampleExtraction({ task: { values: ['x'], proposed: [], status: 'edited', evidence: [] } })))).toBe(1)
    expect(reviewedCount('summary.md', 'not a summary')).toBe(-1)
  })

  it('takes a trashed file the library lacks, skips an identical one, prefers the more reviewed summary and keeps any other copy beside', () => {
    expect(planMergeFile('content.md', null, b('x'))).toBe('adopt')
    expect(planMergeFile('paper.pdf', b('same'), b('same'))).toBe('same')
    expect(planMergeFile('paper.pdf', b('mine'), b('theirs'))).toBe('keep_trashed')
    expect(planMergeFile('summary.md', b(summary(1)), b(summary(2)))).toBe('adopt')
    expect(planMergeFile('summary.md', b(summary(1)), b(summary(1, 'Other.')))).toBe('keep_trashed')
  })

  it('appends the trashed notes under a marker, once', () => {
    expect(mergeNotes('', 'old', 'he2017drain')).toBe('old')
    const merged = mergeNotes('new\n', 'old', 'he2017drain')
    expect(merged).toBe('new\n\n<!-- notes of he2017drain, merged from the trash -->\nold')
    expect(mergeNotes(merged, 'old', 'he2017drain')).toBe(merged)
    expect(mergeNotes('new', '  ', 'he2017drain')).toBe('new')
  })
})
