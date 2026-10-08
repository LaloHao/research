import { describe, expect, it } from 'vitest'
import { PaperSchema, ProjectConfigSchema } from '../../src/shared/schemas'
import { samplePaper } from '../helpers/papers'

describe('ProjectConfigSchema', () => {
  it('fills defaults', () => {
    const cfg = ProjectConfigSchema.parse({ schema_version: 1, name: 'Thesis' })
    expect(cfg.content_language).toBe('en')
    expect(cfg.pdfs).toEqual({ policy: 'track' })
  })

  it('keeps keys it does not know (later stages add them)', () => {
    const cfg = ProjectConfigSchema.parse({ schema_version: 1, name: 'Thesis', protocol: { rq: ['RQ1'] } })
    expect((cfg as Record<string, unknown>).protocol).toEqual({ rq: ['RQ1'] })
  })

  it('rejects an unknown pdf policy', () => {
    expect(ProjectConfigSchema.safeParse({ schema_version: 1, name: 'T', pdfs: { policy: 'cloud' } }).success).toBe(false)
  })
})

describe('PaperSchema', () => {
  it('accepts a valid paper', () => {
    expect(PaperSchema.parse(samplePaper()).id).toBe('he2017drain')
  })

  it('rejects ids that are not lowercase ascii citation keys', () => {
    expect(PaperSchema.safeParse(samplePaper({ id: 'He2017' })).success).toBe(false)
    expect(PaperSchema.safeParse(samplePaper({ id: '2017drain' })).success).toBe(false)
    expect(PaperSchema.safeParse(samplePaper({ id: 'he_2017' })).success).toBe(false)
  })
})
