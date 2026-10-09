import type { ThesisContext } from '../../shared/summary'

/** Reassigns `id` to `RQ1..n` in order; the server does the same on save, but the UI needs stable, unique ids before that round-trip (e.g. for list keys right after an add or a remove). */
export function renumberRQs(questions: ThesisContext['research_questions']): ThesisContext['research_questions'] {
  return questions.map((q, i) => ({ ...q, id: `RQ${i + 1}` }))
}
