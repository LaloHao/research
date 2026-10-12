import { describe, expect, it } from 'vitest'
import { paperTabs } from '../../src/renderer/lib/paperTabs'

describe('paperTabs', () => {
  it('shows summary, content, pdf, relations, chat and notes when there is a readable page and a pdf', () => {
    expect(paperTabs({ content: 'text', hasPdf: true, textStatus: 'pending' })).toEqual(['summary', 'content', 'pdf', 'relations', 'chat', 'notes'])
  })

  it('hides the pdf tab for a web page with no pdf available', () => {
    expect(paperTabs({ content: 'text', hasPdf: false, textStatus: 'ok' })).toEqual(['summary', 'content', 'relations', 'chat', 'notes'])
  })

  it('shows summary, pdf, relations, chat and notes for a paper with no readable content', () => {
    expect(paperTabs({ content: null, hasPdf: true, textStatus: 'no_text' })).toEqual(['summary', 'pdf', 'relations', 'chat', 'notes'])
    expect(paperTabs({ content: null, hasPdf: false, textStatus: 'no_source' })).toEqual(['summary', 'pdf', 'relations', 'chat', 'notes'])
  })

  it('adds the text tab right after the pdf when the paper has a pdf and its text is indexed', () => {
    expect(paperTabs({ content: null, hasPdf: true, textStatus: 'ok' })).toEqual(['summary', 'pdf', 'text', 'relations', 'chat', 'notes'])
    expect(paperTabs({ content: 'text', hasPdf: true, textStatus: 'ok' })).toEqual(['summary', 'content', 'pdf', 'text', 'relations', 'chat', 'notes'])
  })

  it('has no text tab without a pdf, or when its text is not indexed', () => {
    expect(paperTabs({ content: null, hasPdf: false, textStatus: 'ok' })).not.toContain('text')
    for (const textStatus of ['pending', 'no_text', 'error'] as const) {
      expect(paperTabs({ content: null, hasPdf: true, textStatus })).not.toContain('text')
    }
  })
})
