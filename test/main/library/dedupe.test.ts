import { describe, expect, it } from 'vitest'
import { findDuplicate, mergePapers, normalizeTitle, samePaperContent } from '../../../src/main/library/dedupe'
import { samplePaper } from '../../helpers/papers'

const existing = [
  { id: 'he2017drain', doi: '10.1109/icws.2017.13', arxiv: null, title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree' },
  { id: 'zhu2020loghub', doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448', title: 'Loghub: A Large Collection of System Log Datasets' }
]

describe('findDuplicate', () => {
  it('matches by DOI case-insensitively', () => {
    expect(findDuplicate({ doi: '10.1109/ICWS.2017.13', title: 'x' }, existing)).toEqual({ id: 'he2017drain', reason: 'doi' })
  })

  it('matches an arXiv id against an arXiv DOI', () => {
    expect(findDuplicate({ arxiv: '2008.06448', title: 'x' }, existing)).toEqual({ id: 'zhu2020loghub', reason: 'arxiv' })
  })

  it('matches by normalized title (case, punctuation, accents)', () => {
    expect(findDuplicate({ title: 'DRAIN — an online log-parsing approach with fixed depth tree' }, existing)).toEqual({ id: 'he2017drain', reason: 'title' })
  })

  it('ignores short generic titles', () => {
    expect(findDuplicate({ title: 'Introduction' }, [{ id: 'a2020introduction', title: 'Introduction' }])).toBeNull()
  })

  it('returns null for a new paper', () => {
    expect(findDuplicate({ doi: '10.1/new', title: 'Something entirely different here' }, existing)).toBeNull()
  })
})

describe('normalizeTitle', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeTitle('Anonimización: ¡Logs!')).toBe('anonimizacion logs')
  })
})

describe('mergePapers', () => {
  it('upgrades a preprint to its published version but keeps the id and the arXiv id', () => {
    const preprint = samplePaper({
      id: 'zhu2020loghub',
      kind: 'preprint',
      title: 'Loghub',
      identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' },
      bibtex: '@misc{zhu2020loghub,\n  title = {Loghub}\n}',
      added_at: '2026-01-01T00:00:00.000Z'
    })
    const published = samplePaper({
      id: 'zhu2023loghub',
      kind: 'conference',
      title: 'Loghub (published)',
      identifiers: { doi: '10.1109/issre59848.2023.00071' },
      bibtex: '@inproceedings{Zhu_2023,\n  title = {Loghub}\n}',
      updated_at: '2026-10-07T00:00:00.000Z'
    })
    const merged = mergePapers(preprint, published)
    expect(merged.id).toBe('zhu2020loghub')
    expect(merged.kind).toBe('conference')
    expect(merged.title).toBe('Loghub (published)')
    expect(merged.identifiers).toEqual({ doi: '10.1109/issre59848.2023.00071', arxiv: '2008.06448' })
    expect(merged.bibtex.startsWith('@inproceedings{zhu2020loghub,')).toBe(true)
    expect(merged.added_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps complete metadata and only fills gaps from an incomplete incoming paper', () => {
    const complete = samplePaper()
    const fromPdf = samplePaper({ id: 'anonnddrain', kind: 'other', title: 'whatever', metadata_status: 'incomplete', pdf_sha256: 'abc', identifiers: {} })
    const merged = mergePapers(complete, fromPdf)
    expect(merged.title).toBe(complete.title)
    expect(merged.pdf_sha256).toBe('abc')
    expect(merged.metadata_status).toBe('complete')
  })
})

describe('samePaperContent', () => {
  it('ignores updated_at', () => {
    expect(samePaperContent(samplePaper(), samplePaper({ updated_at: '2030-01-01T00:00:00.000Z' }))).toBe(true)
    expect(samePaperContent(samplePaper(), samplePaper({ title: 'Other' }))).toBe(false)
  })
})
