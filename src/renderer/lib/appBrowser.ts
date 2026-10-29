import type { JobRecord } from '../../shared/jobs'
import { parseUserError } from '../../shared/library'

/** An http(s) address: what the app's browser window opens. */
export function isWebAddress(text: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(text.trim()).protocol)
  } catch {
    return false
  }
}

/** Failures of «Agregar» that a browser gets past: the site refused the app, or its page needs scripts to show the article. */
const BROWSER_FIXES = new Set(['site_blocked', 'unreadable_page', 'access_denied'])

/** The address of a failed «Agregar» the user can open in the app's browser instead; null for any other job. */
export function browserRetryUrl(job: JobRecord): string | null {
  if (job.state !== 'failed' || job.spec.type !== 'ingest_identifier' || !job.message) return null
  const code = parseUserError(job.message)?.code
  return code && BROWSER_FIXES.has(code) && isWebAddress(job.spec.input) ? job.spec.input.trim() : null
}
