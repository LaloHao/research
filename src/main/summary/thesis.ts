import type { ExtractionFile, ThesisContext, ThesisRelation } from '../../shared/summary'
import { sha256 } from '../project/atomicWrite'
import { sortKeys } from './extractionForm'
import { InvalidEdit } from './merge'

export type ThesisPatch = { text?: string; research_questions?: string[]; score?: number; justification?: string }

/** A thesis needs at least a title or a description to be worth relating papers to. */
export function hasThesisContext(t: ThesisContext): boolean {
  return Boolean(t.title.trim() || t.description.trim())
}

// `last_rq` is a bookkeeping counter, not thesis content: bumping it alone must not stale summaries.
export function thesisHash(t: ThesisContext): string {
  const { title, description, research_questions } = t
  return sha256(JSON.stringify(sortKeys({ title, description, research_questions })))
}

export function thesisPromptBlock(t: ThesisContext): string {
  const lines = ['The user is writing this thesis:']
  if (t.title.trim()) lines.push(`Title: ${t.title.trim()}`)
  if (t.description.trim()) lines.push(`Description: ${t.description.trim()}`)
  if (t.research_questions.length) {
    lines.push('Research questions:', ...t.research_questions.map((q) => `- ${q.id}: ${q.text}`))
  }
  return lines.join('\n')
}

/** The user's own version of the relation; questions must exist in the thesis and the score must be 1–5. */
export function editThesisRelation(ext: ExtractionFile, t: ThesisContext, patch: ThesisPatch): ExtractionFile {
  const current: Omit<ThesisRelation, 'score'> & { score?: number } = ext.thesis_relation ?? {
    text: '',
    research_questions: [],
    justification: '',
    status: 'generated',
    evidence: []
  }
  const ids = new Set(t.research_questions.map((q) => q.id))
  if (patch.text !== undefined && typeof patch.text !== 'string') throw new InvalidEdit('Invalid text for the thesis relation')
  if (patch.justification !== undefined && typeof patch.justification !== 'string') throw new InvalidEdit('Invalid justification for the thesis relation')
  if (patch.research_questions !== undefined) {
    if (!Array.isArray(patch.research_questions) || patch.research_questions.some((q) => typeof q !== 'string' || !ids.has(q))) {
      throw new InvalidEdit('Unknown research question')
    }
  }
  const score = patch.score ?? current.score
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) throw new InvalidEdit('Invalid score for the thesis relation')
  const next: ThesisRelation = {
    ...current,
    text: patch.text ?? current.text,
    research_questions: patch.research_questions ? [...new Set(patch.research_questions)] : current.research_questions,
    score,
    justification: patch.justification ?? current.justification,
    status: 'edited'
  }
  return { ...ext, thesis_relation: next }
}
