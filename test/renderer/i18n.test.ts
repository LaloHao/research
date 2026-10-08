import { describe, expect, it } from 'vitest'
import es from '../../src/renderer/i18n/es.json'
import type { JobState } from '../../src/shared/jobs'
import { FILE_PROBLEM_KINDS, INGEST_STATUSES, TEXT_STATUSES, USER_ERROR_CODES } from '../../src/shared/library'
import { PDF_POLICIES } from '../../src/shared/schemas'

const lookup = (path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], es)
const JOB_STATES: JobState[] = ['queued', 'running', 'done', 'failed', 'cancelled']

// Every code the main process can send must have a Spanish string; a missing one would show the raw code.
describe('es.json covers every code the UI can receive', () => {
  it.each([
    ...USER_ERROR_CODES.map((c) => `errors.${c}`),
    ...TEXT_STATUSES.map((s) => `text_status.${s}`),
    ...INGEST_STATUSES.map((s) => `jobs.outcome.${s}`),
    ...JOB_STATES.map((s) => `jobs.state.${s}`),
    ...PDF_POLICIES.map((p) => `settings.pdf_policy.${p}`),
    ...FILE_PROBLEM_KINDS.map((k) => `paper.problem_kinds.${k}`),
    ...['problem', 'incomplete', 'web', 'no_pdf'].map((b) => `badges.${b}`)
  ])('%s', (path) => {
    expect(typeof lookup(path)).toBe('string')
  })
})
