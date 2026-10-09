import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { filterByModel, filterBySummary, rowBadges } from '../../src/renderer/lib/badges'
import { errorText } from '../../src/renderer/lib/errorText'
import { jobDetail, jobLabel, visibleJobs } from '../../src/renderer/lib/jobLabel'
import { nextRqId } from '../../src/renderer/lib/thesis'
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
  summary_status: 'none',
  pending_review: 0,
  summary_model: null,
  ...over
})

describe('jobLabel', () => {
  it('describes each job type', () => {
    expect(jobLabel(t, job({}))).toBe('jobs.ingest_identifier {"input":"10.1/x"}')
    expect(jobLabel(t, job({ spec: { type: 'ingest_pdf', path: '/home/me/Downloads/paper.pdf' } }))).toBe('jobs.ingest_pdf {"file":"paper.pdf"}')
    expect(jobLabel(t, job({ spec: { type: 'update_metadata', paperId: 'he2017drain' } }))).toBe('jobs.update_metadata {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'summarize', paperId: 'he2017drain' } }))).toBe('jobs.summarize {"id":"he2017drain"}')
  })
})

describe('jobDetail', () => {
  it('translates outcomes and errors, nothing for active jobs', () => {
    expect(jobDetail(t, job({ state: 'done', message: 'added' }))).toBe('jobs.outcome.added {"defaultValue":"added"}')
    expect(jobDetail(t, job({ state: 'done', message: 'summarized' }))).toBe('jobs.outcome.summarized {"defaultValue":"summarized"}')
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
    expect(rowBadges(row({ metadata_status: 'incomplete', has_pdf: false }))).toEqual(['incomplete', 'no_pdf', 'summary_none'])
    expect(rowBadges(row({ kind: 'web', has_pdf: false }))).toEqual(['web', 'summary_none'])
    expect(rowBadges(row({}))).toEqual(['summary_none'])
  })

  it('adds a summary badge for each summary_status', () => {
    expect(rowBadges(row({ summary_status: 'none' }))).toEqual(['summary_none'])
    expect(rowBadges(row({ summary_status: 'none', text_status: 'pending' }))).toEqual([])
    expect(rowBadges(row({ summary_status: 'generated' }))).toEqual(['to_review'])
    expect(rowBadges(row({ summary_status: 'reviewed' }))).toEqual(['reviewed'])
    expect(rowBadges(row({ summary_status: 'stale' }))).toEqual(['stale'])
    expect(rowBadges(row({ summary_status: 'failed' }))).toEqual(['summary_failed'])
    expect(rowBadges(row({ summary_status: 'too_long' }))).toEqual([])
    expect(rowBadges(row({ metadata_status: 'incomplete', summary_status: 'stale' }))).toEqual(['incomplete', 'stale'])
  })
})

describe('filterBySummary', () => {
  const rows = [
    row({ id: 'a', summary_status: 'none' }),
    row({ id: 'b', summary_status: 'generated' }),
    row({ id: 'c', summary_status: 'reviewed' }),
    row({ id: 'd', summary_status: 'stale' }),
    row({ id: 'e', summary_status: 'failed' })
  ]

  it('filters rows by the badge each summary_status maps to', () => {
    expect(filterBySummary(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(filterBySummary(rows, 'none').map((r) => r.id)).toEqual(['a'])
    expect(filterBySummary(rows, 'to_review').map((r) => r.id)).toEqual(['b'])
    expect(filterBySummary(rows, 'reviewed').map((r) => r.id)).toEqual(['c'])
    expect(filterBySummary(rows, 'stale').map((r) => r.id)).toEqual(['d'])
    expect(filterBySummary(rows, 'failed').map((r) => r.id)).toEqual(['e'])
  })
})

describe('filterByModel', () => {
  const rows = [
    row({ id: 'a', summary_model: 'claude-sonnet-4-5' }),
    row({ id: 'b', summary_model: 'claude-haiku-4-5' }),
    row({ id: 'c', summary_model: null })
  ]

  it('matches summary_model by family, substring of the model id', () => {
    expect(filterByModel(rows, 'any').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(filterByModel(rows, 'sonnet').map((r) => r.id)).toEqual(['a'])
    expect(filterByModel(rows, 'haiku').map((r) => r.id)).toEqual(['b'])
    expect(filterByModel(rows, 'opus').map((r) => r.id)).toEqual([])
  })
})

describe('nextRqId', () => {
  it('gives the next number after the highest id, never reusing a gap', () => {
    expect(nextRqId([])).toBe('RQ1')
    expect(nextRqId([{ id: 'RQ1', text: 'a' }, { id: 'RQ2', text: 'b' }])).toBe('RQ3')
    expect(nextRqId([{ id: 'RQ1', text: 'a' }, { id: 'RQ4', text: 'd' }])).toBe('RQ5')
    expect(nextRqId([{ id: 'RQ10', text: 'j' }, { id: 'RQ9', text: 'i' }])).toBe('RQ11')
  })

  it('never reuses an id below the stored counter, even after the question that used it was deleted', () => {
    // RQ3 was deleted (the highest id currently in use is RQ1), but the counter still remembers it was handed out.
    expect(nextRqId([{ id: 'RQ1', text: 'a' }], 3)).toBe('RQ4')
    // The counter itself can lag behind the current questions (e.g. right after loading); the higher of the two wins.
    expect(nextRqId([{ id: 'RQ1', text: 'a' }, { id: 'RQ5', text: 'e' }], 2)).toBe('RQ6')
  })
})
