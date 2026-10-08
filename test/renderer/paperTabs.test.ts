import { describe, expect, it } from 'vitest'
import { paperTabs } from '../../src/renderer/lib/paperTabs'

describe('paperTabs', () => {
  it('shows content, pdf and notes when there is a readable page and a pdf', () => {
    expect(paperTabs({ content: 'text', hasPdf: true })).toEqual(['content', 'pdf', 'notes'])
  })

  it('hides the pdf tab for a web page with no pdf available', () => {
    expect(paperTabs({ content: 'text', hasPdf: false })).toEqual(['content', 'notes'])
  })

  it('shows pdf and notes for a paper with no readable content', () => {
    expect(paperTabs({ content: null, hasPdf: true })).toEqual(['pdf', 'notes'])
    expect(paperTabs({ content: null, hasPdf: false })).toEqual(['pdf', 'notes'])
  })
})
