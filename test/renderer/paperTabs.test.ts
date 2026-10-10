import { describe, expect, it } from 'vitest'
import { paperTabs } from '../../src/renderer/lib/paperTabs'

describe('paperTabs', () => {
  it('shows summary, content, pdf, relations and notes when there is a readable page and a pdf', () => {
    expect(paperTabs({ content: 'text', hasPdf: true })).toEqual(['summary', 'content', 'pdf', 'relations', 'notes'])
  })

  it('hides the pdf tab for a web page with no pdf available', () => {
    expect(paperTabs({ content: 'text', hasPdf: false })).toEqual(['summary', 'content', 'relations', 'notes'])
  })

  it('shows summary, pdf, relations and notes for a paper with no readable content', () => {
    expect(paperTabs({ content: null, hasPdf: true })).toEqual(['summary', 'pdf', 'relations', 'notes'])
    expect(paperTabs({ content: null, hasPdf: false })).toEqual(['summary', 'pdf', 'relations', 'notes'])
  })
})
