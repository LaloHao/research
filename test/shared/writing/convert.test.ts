import { describe, expect, it } from 'vitest'
import { commentLine, convertMarkers, escapeLatex, formatCitation } from '../../../src/shared/writing/convert'

const found = (page: number | null = null) => ({ state: 'found' as const, page })

describe('formatCitation', () => {
  it('writes each syntax with and without a page', () => {
    expect(formatCitation({ key: 'a', page: 3 }, 'latex')).toBe('\\cite[p.~3]{a}')
    expect(formatCitation({ key: 'a', page: null }, 'latex', 'parencite')).toBe('\\parencite{a}')
    expect(formatCitation({ key: 'a', page: 3 }, 'latex', 'autocite')).toBe('\\autocite[p.~3]{a}')
    expect(formatCitation({ key: 'a', page: 3 }, 'markdown')).toBe('[@a, p. 3]')
    expect(formatCitation({ key: 'a', page: null }, 'markdown')).toBe('[@a]')
    expect(formatCitation({ key: 'a', page: 3 }, 'org')).toBe('[cite:@a p. 3]')
    expect(formatCitation({ key: 'a', page: null }, 'org')).toBe('[cite:@a]')
  })
})

describe('escapeLatex', () => {
  it('escapes every special character', () => {
    expect(escapeLatex('50% & #1 a_b $5 {x} ~ ^ \\')).toBe('50\\% \\& \\#1 a\\_b \\$5 \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}')
    expect(escapeLatex('canción ñandú')).toBe('canción ñandú')
  })
})

describe('commentLine', () => {
  it('uses each format’s comment, never breaking a Markdown comment', () => {
    expect(commentLine('a\nb', 'latex')).toBe('% a b')
    expect(commentLine('x', 'org')).toBe('# x')
    expect(commentLine('a --> b', 'markdown')).toBe('<!-- a - -> b -->')
  })
})

describe('convertMarkers', () => {
  const text = 'Logs vary 50% [[he2017drain|p. 3|"logs vary"]]. Parsing_works [[zhu2019tools|"tools"]].'

  it('converts verified markers to LaTeX and escapes only the prose', () => {
    const r = convertMarkers(text, { format: 'latex', checks: [found(3), found(null)] })
    expect(r).toEqual({ text: 'Logs vary 50\\% \\cite[p.~3]{he2017drain}. Parsing\\_works \\cite{zhu2019tools}.', converted: 2, unverified: 0 })
  })

  it('uses the chosen command and the page where the quote was found', () => {
    const r = convertMarkers('A [[a|p. 3|"q"]].', { format: 'latex', latexCommand: 'parencite', checks: [found(4)] })
    expect(r.text).toBe('A \\parencite[p.~4]{a}.')
  })

  it('converts to Markdown and Org without touching the prose', () => {
    expect(convertMarkers(text, { format: 'markdown', checks: [found(3), found(null)] }).text).toBe('Logs vary 50% [@he2017drain, p. 3]. Parsing_works [@zhu2019tools].')
    expect(convertMarkers(text, { format: 'org', checks: [found(3), found(null)] }).text).toBe('Logs vary 50% [cite:@he2017drain p. 3]. Parsing_works [cite:@zhu2019tools].')
  })

  it('flags unverified markers instead of converting them silently', () => {
    const para = 'One [[a|p. 3|"q"]].\n\nTwo [[b|"r"]].'
    const latex = convertMarkers(para, { format: 'latex', checks: [{ state: 'not_found', page: 3 }, found()] })
    expect(latex).toEqual({ text: '% NO VERIFICADA: a, p. 3\nOne \\cite[p.~3]{a}.\n\nTwo \\cite{b}.', converted: 2, unverified: 1 })
    const org = convertMarkers(para, { format: 'org', checks: [found(3)] })
    expect(org.text).toBe('One [cite:@a p. 3].\n\n# NO VERIFICADA: b\nTwo [cite:@b].')
    expect(org.unverified).toBe(1)
    const md = convertMarkers(para, { format: 'markdown' })
    expect(md.text).toBe('One [@a, p. 3] <!-- no verificada -->.\n\nTwo [@b] <!-- no verificada -->.')
    expect(md.unverified).toBe(2)
  })

  it('keeps quotes as comments when asked', () => {
    const para = 'Intro line\nclaim [[a|p. 3|"logs vary"]].'
    expect(convertMarkers(para, { format: 'latex', quotes: true, checks: [found(3)] }).text).toBe('% a, p. 3: "logs vary"\nIntro line\nclaim \\cite[p.~3]{a}.')
    expect(convertMarkers(para, { format: 'org', quotes: true, checks: [found(3)] }).text).toBe('# a, p. 3: "logs vary"\nIntro line\nclaim [cite:@a p. 3].')
    expect(convertMarkers(para, { format: 'markdown', quotes: true, checks: [found(3)] }).text).toBe('Intro line\nclaim [@a, p. 3] <!-- "logs vary" -->.')
  })

  it('leaves text without markers as it is (escaped in LaTeX)', () => {
    expect(convertMarkers('No citations & such.', { format: 'latex' })).toEqual({ text: 'No citations \\& such.', converted: 0, unverified: 0 })
    expect(convertMarkers('Keep [[a broken marker.', { format: 'org' }).text).toBe('Keep [[a broken marker.')
  })
})
