import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { rowBadges } from '../../src/renderer/lib/badges'
import { errorText } from '../../src/renderer/lib/errorText'
import { jobDetail, jobLabel, visibleJobs } from '../../src/renderer/lib/jobLabel'
import type { JobRecord } from '../../src/shared/jobs'
import type { PaperRow } from '../../src/shared/library'

// Echoes the key and its options so assertions can see what was asked for.
const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 1,
  spec: { type: 'ingest_identifier', input: '10.1/x' },
  state: 'queued',
  message: null,
  paperId: null,
  createdAt: 't',
  updatedAt: 't',
  ...over
})

const row = (over: Partial<PaperRow>): PaperRow => ({
  id: 'a2020x',
  title: 'T',
  authors_label: '',
  year: null,
  venue: null,
  kind: 'article',
  doi: null,
  arxiv: null,
  metadata_status: 'complete',
  has_pdf: true,
  problem: null,
  added_at: null,
  text_status: 'ok',
  ...over
})

describe('jobLabel', () => {
  it('describes each job type', () => {
    expect(jobLabel(t, job({}))).toBe('jobs.ingest_identifier {"input":"10.1/x"}')
    expect(jobLabel(t, job({ spec: { type: 'ingest_pdf', path: '/home/me/Downloads/paper.pdf' } }))).toBe('jobs.ingest_pdf {"file":"paper.pdf"}')
    expect(jobLabel(t, job({ spec: { type: 'update_metadata', paperId: 'he2017drain' } }))).toBe('jobs.update_metadata {"id":"he2017drain"}')
  })
})

describe('jobDetail', () => {
  it('translates outcomes and errors, nothing for active jobs', () => {
    expect(jobDetail(t, job({ state: 'done', message: 'added' }))).toBe('jobs.outcome.added {"defaultValue":"added"}')
    expect(jobDetail(t, job({ state: 'failed', message: 'not_found' }))).toBe('errors.not_found {"defaultValue":"not_found"}')
    expect(jobDetail(t, job({ state: 'running' }))).toBeNull()
  })
})

describe('errorText', () => {
  it('falls back to the raw message for unknown codes', () => {
    expect(errorText(t, 'network')).toBe('errors.network {"defaultValue":"network"}')
  })
})

describe('visibleJobs', () => {
  it('keeps every active job and only the latest finished ones', () => {
    const jobs = [
      job({ id: 9, state: 'running' }),
      ...[8, 7, 6, 5, 4, 3, 2].map((id) => job({ id, state: 'done' })),
      job({ id: 1, state: 'queued' })
    ]
    expect(visibleJobs(jobs, 3).map((j) => j.id)).toEqual([9, 8, 7, 6, 1])
  })
})

describe('rowBadges', () => {
  it('flags problems alone, otherwise incomplete metadata, web pages and missing PDFs', () => {
    expect(rowBadges(row({ problem: 'conflict_markers: x', metadata_status: 'incomplete' }))).toEqual(['problem'])
    expect(rowBadges(row({ metadata_status: 'incomplete', has_pdf: false }))).toEqual(['incomplete', 'no_pdf'])
    expect(rowBadges(row({ kind: 'web', has_pdf: false }))).toEqual(['web'])
    expect(rowBadges(row({}))).toEqual([])
  })
})
