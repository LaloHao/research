/** Why a number typed in Settings was rejected; each has a message under `settings.invalid`. */
export const NUMBER_ISSUES = ['required', 'not_number', 'not_positive', 'cap_not_positive', 'not_integer', 'too_large'] as const
export type NumberIssue = (typeof NUMBER_ISSUES)[number]
export type Parsed<T> = { ok: true; value: T } | { ok: false; issue: NumberIssue }

function toNumber(raw: string): number | null {
  const text = raw.trim().replace(',', '.')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null
  return Number(text)
}

/** A required amount in USD, greater than zero. */
export function parseUsd(raw: string): Parsed<number> {
  if (raw.trim() === '') return { ok: false, issue: 'required' }
  const value = toNumber(raw)
  if (value === null) return { ok: false, issue: 'not_number' }
  return value > 0 ? { ok: true, value } : { ok: false, issue: 'not_positive' }
}

/** An optional cap in USD: empty means no cap. */
export function parseCap(raw: string): Parsed<number | null> {
  if (raw.trim() === '') return { ok: true, value: null }
  const parsed = parseUsd(raw)
  return !parsed.ok && parsed.issue === 'not_positive' ? { ok: false, issue: 'cap_not_positive' } : parsed
}

/** A required whole count greater than zero (and at most `max`, when given). */
export function parseCount(raw: string, max?: number): Parsed<number> {
  if (raw.trim() === '') return { ok: false, issue: 'required' }
  const value = toNumber(raw)
  if (value === null) return { ok: false, issue: 'not_number' }
  if (!Number.isInteger(value)) return { ok: false, issue: 'not_integer' }
  if (value <= 0) return { ok: false, issue: 'not_positive' }
  return max !== undefined && value > max ? { ok: false, issue: 'too_large' } : { ok: true, value }
}

/** A required whole number that may be negative or zero — e.g. a scale facet's min/max bound. */
export function parseInteger(raw: string): Parsed<number> {
  if (raw.trim() === '') return { ok: false, issue: 'required' }
  const value = toNumber(raw)
  if (value === null) return { ok: false, issue: 'not_number' }
  return Number.isInteger(value) ? { ok: true, value } : { ok: false, issue: 'not_integer' }
}
