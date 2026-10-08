import type { Paper } from '../../src/shared/schemas'

export function samplePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    schema_version: 1,
    id: 'he2017drain',
    kind: 'conference',
    title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
    authors: [
      { family: 'He', given: 'Pinjia' },
      { family: 'Zhu', given: 'Jieming' }
    ],
    year: 2017,
    venue: '2017 IEEE International Conference on Web Services (ICWS)',
    identifiers: { doi: '10.1109/icws.2017.13' },
    bibtex: '@inproceedings{he2017drain,\n  title = {Drain: An Online Log Parsing Approach with Fixed Depth Tree},\n  year = {2017}\n}',
    metadata_status: 'complete',
    added_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    ...overrides
  }
}
