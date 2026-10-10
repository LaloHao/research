import { describe, expect, it } from 'vitest'
import { CitationsSchema } from '../../src/shared/relations'
import { PaperSchema, ProjectConfigSchema } from '../../src/shared/schemas'
import { samplePaper } from '../helpers/papers'

describe('CitationsSchema', () => {
  it('accepts a fetched block and an unresolved one', () => {
    const ok = CitationsSchema.parse({
      source: 'openalex',
      fetched_at: '2026-10-09T12:00:00.000Z',
      openalex_id: 'W2754665629',
      references: ['W66551789'],
      cited_by_count: 904
    })
    expect(ok.references).toEqual(['W66551789'])
    expect(CitationsSchema.parse({ source: 'openalex', fetched_at: 't', unresolved: true }).references).toEqual([])
  })

  it('rejects ids stored as URLs', () => {
    expect(CitationsSchema.safeParse({ source: 'openalex', fetched_at: 't', references: ['https://openalex.org/W1'] }).success).toBe(false)
  })
})

describe('citations in paper.yaml and snowball in project.yaml', () => {
  it('keeps a valid citations block and reads an invalid one as absent', () => {
    const citations = { source: 'openalex', fetched_at: 't', openalex_id: 'W1', references: ['W2'] }
    expect(PaperSchema.parse({ ...samplePaper(), citations }).citations?.openalex_id).toBe('W1')
    expect(PaperSchema.parse({ ...samplePaper(), citations: { source: 'crossref' } }).citations).toBeUndefined()
  })

  it('defaults snowball.dismissed and falls back on an invalid block', () => {
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T' }).snowball).toEqual({ dismissed: [] })
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T', snowball: { dismissed: ['nope'] } }).snowball).toEqual({ dismissed: [] })
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T', snowball: { dismissed: ['W9'] } }).snowball).toEqual({ dismissed: ['W9'] })
  })
})
