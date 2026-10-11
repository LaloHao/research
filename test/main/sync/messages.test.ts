import { describe, expect, it } from 'vitest'
import { machineName, mergeCommitMessage, syncCommitMessage, touchedPapers } from '../../../src/main/sync/messages'

describe('commit messages', () => {
  it('lists the papers whose folder changed, in the library or the trash, only inside the project', () => {
    const paths = ['research/papers/zhu2020loghub/summary.md', 'research/.trash/he2017drain/paper.yaml', 'research/papers/zhu2020loghub/notes.md', 'research/relations.yaml', 'papers/outside2020x/notes.md']
    expect(touchedPapers(paths, 'research/')).toEqual(['he2017drain', 'zhu2020loghub'])
    expect(syncCommitMessage('laptop', paths, 'research/')).toBe('research: sync from laptop\n\nPapers: he2017drain, zhu2020loghub\n')
    expect(syncCommitMessage('laptop', ['project.yaml'], '')).toBe('research: sync from laptop\n')
  })

  it('stops listing after twenty papers', () => {
    const paths = Array.from({ length: 23 }, (_, i) => `papers/p${String(i).padStart(2, '0')}/notes.md`)
    expect(syncCommitMessage('laptop', paths, '')).toMatch(/^research: sync from laptop\n\nPapers: p00, p01, .*, p19 \(and 3 more\)\n$/)
  })

  it('names the machine on one short line', () => {
    expect(machineName('my-laptop\nevil: line')).toBe('my-laptop evil: line')
    expect(machineName('x'.repeat(80))).toHaveLength(60)
    expect(machineName('  ')).toBe('unknown machine')
    expect(mergeCommitMessage('desktop')).toBe('research: merge sync from desktop\n')
  })
})
