import type { ThesisContext } from '../../shared/summary'

/** Id for a new research question: one more than the highest id in use. Existing ids never change, since relations refer to them. */
export function nextRqId(questions: ThesisContext['research_questions']): string {
  const max = questions.reduce((n, q) => Math.max(n, Number(/^RQ(\d+)$/.exec(q.id)?.[1] ?? 0)), 0)
  return `RQ${max + 1}`
}
