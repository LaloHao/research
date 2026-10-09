import type { ThesisContext } from '../../shared/summary'

/**
 * Id for a new research question: one more than the highest of the stored counter (`lastRq`) and any
 * id currently in use. Existing ids never change, since relations refer to them; using the counter
 * instead of just the current max keeps a deleted question's id from being handed to a new one.
 */
export function nextRqId(questions: ThesisContext['research_questions'], lastRq = 0): string {
  const maxExisting = questions.reduce((n, q) => Math.max(n, Number(/^RQ(\d+)$/.exec(q.id)?.[1] ?? 0)), 0)
  return `RQ${Math.max(lastRq, maxExisting) + 1}`
}
