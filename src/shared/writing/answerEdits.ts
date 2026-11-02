/**
 * The changes Claude gives in an answer to a question that allowed editing the file (mode `edit`): one fenced block
 * ```edits holding a JSON array of {find, replace, why}. Each is checked against the passage it was given: `find` must
 * occur in it exactly once, so the editor can apply it to that same text and nowhere else.
 */

export const MAX_ANSWER_EDITS = 20
export const MAX_EDIT_FIND = 1000

export type AnswerEditState = 'ok' | 'not_found' | 'ambiguous' | 'invalid'

export interface AnswerEdit {
  find: string
  replace: string
  why: string
  state: AnswerEditState
}

export interface AnswerWithEdits {
  /** The answer without its edits block. */
  text: string
  /** null when the answer has no edits block. */
  edits: AnswerEdit[] | null
}

const EDITS_BLOCK = /(^|\n)[ \t]*```+[ \t]*edits[ \t]*\n([\s\S]*?)\n[ \t]*```+[ \t]*(?=\n|$)/

const occurrences = (haystack: string, needle: string): number => {
  let count = 0
  for (let at = haystack.indexOf(needle); at >= 0 && count < 2; at = haystack.indexOf(needle, at + 1)) count++
  return count
}

function checkEdit(raw: unknown, passage: string): AnswerEdit {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const find = typeof o.find === 'string' ? o.find : ''
  const replace = typeof o.replace === 'string' ? o.replace : ''
  const why = typeof o.why === 'string' ? o.why.trim() : ''
  if (!find || find.length > MAX_EDIT_FIND || typeof o.replace !== 'string' || find === replace) return { find, replace, why, state: 'invalid' }
  const n = occurrences(passage, find)
  return { find, replace, why, state: n === 1 ? 'ok' : n === 0 ? 'not_found' : 'ambiguous' }
}

/**
 * Takes the edits block out of the answer's Markdown and checks its changes against `passage`. A block with a citation
 * marker in it is left in the text (the citations' order must not change); an unreadable block gives no edits.
 */
export function extractEdits(markdown: string, passage: string): AnswerWithEdits {
  const m = markdown.match(EDITS_BLOCK)
  if (!m || m.index === undefined || m[2].includes('[[')) return { text: markdown, edits: null }
  const text = (markdown.slice(0, m.index) + m[1] + markdown.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trimEnd()
  let parsed: unknown
  try {
    parsed = JSON.parse(m[2])
  } catch {
    return { text, edits: [] }
  }
  const list = Array.isArray(parsed) ? parsed.slice(0, MAX_ANSWER_EDITS) : []
  return { text, edits: list.map((e) => checkEdit(e, passage)) }
}
