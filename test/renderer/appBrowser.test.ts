import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../../src/shared/jobs'
import { browserRetryUrl, isWebAddress } from '../../src/renderer/lib/appBrowser'

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 1,
  spec: { type: 'ingest_identifier', input: 'https://towardsdatascience.com/how-to-validate-298978fea764/' },
  state: 'failed',
  message: 'site_blocked: HTTP 403',
  progress: null,
  paperId: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  ...over
})

describe('app browser in the renderer', () => {
  it('knows a web address', () => {
    expect(isWebAddress(' https://acme.test/a ')).toBe(true)
    expect(isWebAddress('10.1109/icws.2017.13')).toBe(false)
    expect(isWebAddress('file:///etc/passwd')).toBe(false)
  })

  it('offers the app browser for a web page «Agregar» could not get, and nothing else', () => {
    expect(browserRetryUrl(job({}))).toBe('https://towardsdatascience.com/how-to-validate-298978fea764/')
    expect(browserRetryUrl(job({ message: 'unreadable_page' }))).not.toBeNull()
    expect(browserRetryUrl(job({ message: 'not_found' }))).toBeNull()
    expect(browserRetryUrl(job({ state: 'done', message: 'added' }))).toBeNull()
    expect(browserRetryUrl(job({ spec: { type: 'ingest_identifier', input: '10.1109/icws.2017.13' } }))).toBeNull()
    expect(browserRetryUrl(job({ spec: { type: 'ingest_pdf', path: '/a.pdf' } }))).toBeNull()
  })
})
