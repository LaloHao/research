import { describe, expect, it } from 'vitest'
import { InvalidEdit } from '../../../src/main/summary/merge'
import { editThesisRelation, hasThesisContext, thesisHash, thesisPromptBlock } from '../../../src/main/summary/thesis'
import { sampleExtraction, sampleThesis as thesis } from '../../helpers/summaries'

describe('hasThesisContext', () => {
  it('needs a title or a description', () => {
    expect(hasThesisContext({ title: '', description: '', research_questions: [] })).toBe(false)
    expect(hasThesisContext({ title: '  ', description: '', research_questions: [{ id: 'RQ1', text: 'q' }] })).toBe(false)
    expect(hasThesisContext({ title: 'T', description: '', research_questions: [] })).toBe(true)
    expect(hasThesisContext({ title: '', description: 'D', research_questions: [] })).toBe(true)
  })
})

describe('thesisHash', () => {
  it('does not depend on key order', () => {
    const reordered = {
      research_questions: thesis.research_questions.map((q) => ({ text: q.text, id: q.id })),
      description: thesis.description,
      title: thesis.title
    }
    expect(thesisHash(reordered)).toBe(thesisHash(thesis))
  })

  it('changes when a research question changes', () => {
    const changed = { ...thesis, research_questions: [thesis.research_questions[0], { id: 'RQ2', text: 'Something else?' }] }
    expect(thesisHash(changed)).not.toBe(thesisHash(thesis))
  })

  it('does not depend on last_rq: bumping the id counter alone must not stale existing summaries', () => {
    expect(thesisHash({ ...thesis, last_rq: 2 })).toBe(thesisHash({ ...thesis, last_rq: 99 }))
  })
})

describe('thesisPromptBlock', () => {
  it('lists title, description and questions with their ids', () => {
    const block = thesisPromptBlock(thesis)
    expect(block).toContain('Privacy-preserving log analysis')
    expect(block).toContain('Sanitizing operational logs')
    expect(block).toContain('RQ1: Which sanitization techniques preserve utility?')
    expect(block).toContain('RQ2: How can outputs be traced back to evidence?')
  })
})

describe('editThesisRelation', () => {
  const ext = {
    ...sampleExtraction(),
    thesis_relation: { text: 't', research_questions: ['RQ1'], score: 3, justification: 'j', status: 'generated' as const, evidence: [] }
  }

  it('applies the patch and marks the relation edited', () => {
    const next = editThesisRelation(ext, thesis, { research_questions: ['RQ2', 'RQ2'], score: 5, justification: 'addresses RQ2' })
    expect(next.thesis_relation).toMatchObject({ text: 't', research_questions: ['RQ2'], score: 5, justification: 'addresses RQ2', status: 'edited' })
  })

  it('rejects a research question that does not exist', () => {
    expect(() => editThesisRelation(ext, thesis, { research_questions: ['RQ9'] })).toThrow(InvalidEdit)
  })

  it('rejects a score outside 1–5', () => {
    expect(() => editThesisRelation(ext, thesis, { score: 0 })).toThrow(InvalidEdit)
    expect(() => editThesisRelation(ext, thesis, { score: 6 })).toThrow(InvalidEdit)
    expect(() => editThesisRelation(ext, thesis, { score: 2.5 })).toThrow(InvalidEdit)
  })
})
