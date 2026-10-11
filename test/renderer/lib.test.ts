import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { filterByIds, filterByModel, filterBySummary, reviewCount, rowBadges } from '../../src/renderer/lib/badges'
import { errorText } from '../../src/renderer/lib/errorText'
import { jobDetail, jobLabel, jobProgress, visibleJobs } from '../../src/renderer/lib/jobLabel'
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
  progress: null,
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
  citations_status: 'none',
  relations_pending: 0,
  ...over
})

describe('jobLabel', () => {
  it('describes each job type', () => {
    expect(jobLabel(t, job({}))).toBe('jobs.ingest_identifier {"input":"10.1/x"}')
    expect(jobLabel(t, job({ spec: { type: 'ingest_pdf', path: '/home/me/Downloads/paper.pdf' } }))).toBe('jobs.ingest_pdf {"file":"paper.pdf"}')
    expect(jobLabel(t, job({ spec: { type: 'update_metadata', paperId: 'he2017drain' } }))).toBe('jobs.update_metadata {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'attach_pdf', paperId: 'he2017drain', path: '/x/a.pdf', replace: true } }))).toBe('jobs.attach_pdf {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'summarize', paperId: 'he2017drain' } }))).toBe('jobs.summarize {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'citations', paperId: 'he2017drain' } }))).toBe('jobs.citations {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'cited_by', paperId: 'he2017drain' } }))).toBe('jobs.cited_by {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'embed', paperId: 'he2017drain' } }))).toBe('jobs.embed {"id":"he2017drain"}')
    expect(jobLabel(t, job({ spec: { type: 'model_download' } }))).toBe('jobs.model_download')
    expect(jobLabel(t, job({ spec: { type: 'suggest_relations', paperId: 'he2017drain' } }))).toBe('jobs.suggest_relations {"id":"he2017drain"}')
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

describe('relations to review', () => {
  it('counts suggested relations in "Por revisar" and shows the badge for them too', () => {
    expect(reviewCount(row({ pending_review: 3, relations_pending: 2 }))).toBe(5)
    expect(rowBadges(row({ summary_status: 'reviewed', relations_pending: 1 }))).toEqual(['reviewed', 'to_review'])
    expect(rowBadges(row({ summary_status: 'generated', relations_pending: 1 }))).toEqual(['to_review'])
  })

  it('filters the papers with relations to review', () => {
    const rows = [row({ id: 'a', relations_pending: 0 }), row({ id: 'b', relations_pending: 2 })]
    expect(filterBySummary(rows, 'relations_to_review').map((r) => r.id)).toEqual(['b'])
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

describe('citation badges and id filter', () => {
  it('marks papers whose citations could not be resolved', () => {
    expect(rowBadges(row({ citations_status: 'unresolved' }))).toContain('no_citations')
    expect(rowBadges(row({ citations_status: 'ok' }))).not.toContain('no_citations')
  })

  it('keeps only the given ids, or everything without a set', () => {
    expect(filterByIds([row({ id: 'a' }), row({ id: 'b' })], new Set(['b'])).map((r) => r.id)).toEqual(['b'])
    expect(filterByIds([row({ id: 'a' })], null)).toHaveLength(1)
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

describe('jobProgress', () => {
  it('shows the percentage of a running job that reports one', () => {
    expect(jobProgress(job({ state: 'running', progress: 0.426 }))).toBe('43 %')
    expect(jobProgress(job({ state: 'running' }))).toBeNull()
    expect(jobProgress(job({ state: 'done', progress: 1 }))).toBeNull()
  })
})
