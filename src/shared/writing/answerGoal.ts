/**
 * The verdict Claude gives about a conversation's goal (what the author is working toward, e.g. «a direct problem
 * statement that follows my advisor's ten steps»): one fenced block ```goal holding a JSON object {met, pending}.
 * The editor shows it after each answer, so the author sees how far the passage is from the goal.
 */

export const MAX_GOAL_PENDING = 10
const MAX_PENDING_CHARS = 300

export interface GoalVerdict {
  met: boolean
  /** What is still missing, most important first; empty when met. */
  pending: string[]
}

export interface AnswerWithGoal {
  /** The answer without its goal block. */
  text: string
  /** null when the answer has no readable goal block. */
  goal: GoalVerdict | null
}

const GOAL_BLOCK = /(^|\n)[ \t]*```+[ \t]*goal[ \t]*\n([\s\S]*?)\n[ \t]*```+[ \t]*(?=\n|$)/

/** Takes the goal block out of the answer's Markdown. A block with a citation marker in it is left in the text. */
export function extractGoal(markdown: string): AnswerWithGoal {
  const m = markdown.match(GOAL_BLOCK)
  if (!m || m.index === undefined || m[2].includes('[[')) return { text: markdown, goal: null }
  const text = (markdown.slice(0, m.index) + m[1] + markdown.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trimEnd()
  let parsed: unknown
  try {
    parsed = JSON.parse(m[2])
  } catch {
    return { text, goal: null }
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  if (typeof o.met !== 'boolean') return { text, goal: null }
  const pending = (Array.isArray(o.pending) ? o.pending : [])
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .slice(0, MAX_GOAL_PENDING)
    .map((p) => p.replace(/\s+/g, ' ').trim().slice(0, MAX_PENDING_CHARS))
  return { text, goal: { met: o.met, pending: o.met ? [] : pending } }
}
