import { describe, expect, it } from 'vitest'
import { buildPaper } from '../../../src/main/library/buildPaper'
import type { ResolvedMetadata } from '../../../src/main/ingest/types'

const now = new Date('2026-10-07T12:00:00.000Z')

describe('buildPaper', () => {
  it('rekeys the publisher BibTeX to the paper id', () => {
    const meta: ResolvedMetadata = {
      kind: 'conference',
      title: 'Drain',
      authors: [{ family: 'He', given: 'Pinjia' }],
      year: 2017,
      identifiers: { doi: '10.1109/icws.2017.13' },
      bibtex: ' @inproceedings{He_2017, title={Drain}, year={2017} }',
      complete: true
    }
    const paper = buildPaper(meta, 'he2017drain', now)
    expect(paper.bibtex.startsWith('@inproceedings{he2017drain,')).toBe(true)
    expect(paper).toMatchObject({ id: 'he2017drain', metadata_status: 'complete', added_at: '2026-10-07T12:00:00.000Z' })
    expect(paper.identifiers).toEqual({ doi: '10.1109/icws.2017.13' })
  })

  it('builds an @online entry for web pages with today as urldate', () => {
    const paper = buildPaper(
      { kind: 'web', title: 'Outage', authors: [], identifiers: { url: 'https://eng.acme.test/outage' }, web: { site: 'Acme Engineering', date: '2024-03-01' }, year: 2024, complete: true },
      'acmeengineering2024outage',
      now
    )
    expect(paper.bibtex).toContain('@online{acmeengineering2024outage,')
    expect(paper.bibtex).toContain('urldate = {2026-10-07}')
  })

  it('falls back to a generated entry and marks metadata incomplete', () => {
    const paper = buildPaper({ kind: 'other', title: 'Sanitizing logs with NER', authors: [], identifiers: {}, complete: false }, 'anonndsanitizing', now)
    expect(paper.metadata_status).toBe('incomplete')
    expect(paper.bibtex).toContain('@misc{anonndsanitizing,')
  })
})
