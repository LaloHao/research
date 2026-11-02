import { describe, expect, it } from 'vitest'
import type { ChatCitation } from '../../../src/shared/chat'
import { draftCheck, exportDraft, rekeyDraft, uncitedCount } from '../../../src/shared/writing/draft'
import { draftFile } from '../../helpers/drafts'

const TEXT = 'Drain is online [[he2017drain|p. 1|"Drain parses logs"]]. Loghub [[zhu2020loghub|p. 2|"A collection"]]. All agree [[sin cita]].'
const CITATIONS: ChatCitation[] = [
  { paper: 'he2017drain', page: 3, quote: 'Drain parses logs', state: 'found' },
  { paper: 'zhu2020loghub', page: 2, quote: 'A collection', state: 'not_found' }
]

describe('draft checks and export', () => {
  it('flags citations outside the selection and counts what is not verified', () => {
    const check = draftCheck(TEXT, CITATIONS, ['he2017drain'])
    expect(check).toMatchObject({ unverified: 1, outside: 1, uncited: 1 })
    expect(check.citations.map((c) => c.outside)).toEqual([false, true])
    expect(uncitedCount('none here')).toBe(0)
  })

  it('converts verified markers at the page they were found, keeps unverified ones flagged and shows [SIN CITA]', () => {
    const check = draftCheck(TEXT, CITATIONS, ['he2017drain'])
    const org = exportDraft(TEXT, check, { format: 'org' })
    expect(org).toMatchObject({ converted: 2, unverified: 1 })
    expect(org.text).toBe('# NO VERIFICADA: zhu2020loghub, p. 2\nDrain is online [cite:@he2017drain p. 3]. Loghub [cite:@zhu2020loghub p. 2]. All agree [SIN CITA].')
    const latex = exportDraft(TEXT, check, { format: 'latex', latexCommand: 'parencite', quotes: true })
    expect(latex.text).toContain('Drain is online \\parencite[p.~3]{he2017drain}.')
    expect(latex.text).toContain('% he2017drain, p. 3: "Drain parses logs"')
    expect(latex.text).toContain('All agree [SIN CITA].')
    const md = exportDraft(TEXT, check, { format: 'markdown' })
    expect(md.text).toBe('Drain is online [@he2017drain, p. 3]. Loghub [@zhu2020loghub, p. 2] <!-- no verificada -->. All agree [SIN CITA].')
  })
})

describe('rekeyDraft', () => {
  it('renames the paper among the chosen ones and in every version, and is null for a draft without it', () => {
    const file = draftFile([TEXT, 'First try [[he2017drain|"Drain"]].'], { papers: ['he2017drain', 'zhu2020loghub'] })
    const next = rekeyDraft(file, 'he2017drain', 'he2017online')
    expect(next?.meta.papers).toEqual(['he2017online', 'zhu2020loghub'])
    expect(next?.texts).toEqual([TEXT.replace('[[he2017drain|', '[[he2017online|'), 'First try [[he2017online|"Drain"]].'])
    expect(rekeyDraft(draftFile(['No citations.'], { papers: ['zhu2020loghub'] }), 'he2017drain', 'x')).toBeNull()
  })
})
