import { describe, expect, it } from 'vitest'
import { citationLabel, citationMarker, citationsToText, citedPapers, parseCitations } from '../../src/shared/chatCitations'

const ANSWER = 'Drain uses a fixed-depth tree [[he2017drain|p. 1|"Drain parses log messages online"]]; Loghub collects datasets [[zhu2020loghub|"a large collection of system log datasets"]].'

describe('parseCitations', () => {
  it('reads markers with and without a page, with their position', () => {
    const found = parseCitations(ANSWER)
    expect(found.map(({ paper, page, quote }) => ({ paper, page, quote }))).toEqual([
      { paper: 'he2017drain', page: 1, quote: 'Drain parses log messages online' },
      { paper: 'zhu2020loghub', page: null, quote: 'a large collection of system log datasets' }
    ])
    expect(ANSWER.slice(found[0].start, found[0].end)).toBe('[[he2017drain|p. 1|"Drain parses log messages online"]]')
  })

  it('keeps quotes with quotes inside and ignores malformed markers', () => {
    expect(parseCitations('[[he2017drain|p. 2|"the "best" parser"]]')[0].quote).toBe('the "best" parser')
    expect(parseCitations('[[he2017drain|p.12|"no space"]]')[0].page).toBe(12)
    for (const bad of [
      '[[He2017drain|p. 1|"x"]]',
      '[[he2017drain|p. 0|"x"]]',
      '[[he2017drain|p. 1|x]]',
      '[[he2017drain|p. 1|""]]',
      '[[he2017drain|p. 1|"two\nlines"]]',
      '[[he2017drain|p.\n1|"x"]]',
      `[[he2017drain|"${'x'.repeat(1001)}"]]`
    ]) {
      expect(parseCitations(bad)).toEqual([])
    }
  })

  it('never lets an unterminated marker swallow the next one', () => {
    const found = parseCitations('see [[he2017drain|p. 1|"broken]] and [[zhu2020loghub|p. 2|"good quote"]]')
    expect(found.map(({ paper, quote }) => ({ paper, quote }))).toEqual([{ paper: 'zhu2020loghub', quote: 'good quote' }])
  })

  it('does not throw on any malformed model output', () => {
    for (const junk of ['', '[[', ']]', '[["]]', '[[a|', '[[a|p. |"x"]]', '[[a|p. 999999|"x"]]', '[[a|"x"]'.repeat(5000), `[[a|"${'"'.repeat(5000)}`, '\u0000[[a|"\ud800"]]']) {
      expect(() => parseCitations(junk)).not.toThrow()
      expect(() => citationsToText(junk)).not.toThrow()
      expect(() => citedPapers(junk)).not.toThrow()
    }
  })
})

describe('marker text', () => {
  it('prints a marker that parses back, collapsing whitespace and breaking up "]]', () => {
    const marker = citationMarker({ paper: 'he2017drain', page: 3, quote: '  a  "x"]] tree\n' })
    expect(marker).toBe('[[he2017drain|p. 3|"a "x" ]] tree"]]')
    expect(parseCitations(marker)[0]).toMatchObject({ paper: 'he2017drain', page: 3, quote: 'a "x" ]] tree' })
    expect(citationMarker({ paper: 'zhu2020loghub', page: null, quote: 'q' })).toBe('[[zhu2020loghub|"q"]]')
    expect(parseCitations(citationMarker({ paper: 'zhu2020loghub', page: null, quote: 'see [[1]]' }))[0].quote).toBe('see [ [1]]')
  })

  it('reads as text for copying and notes, and lists the cited papers once each', () => {
    expect(citationLabel({ paper: 'he2017drain', page: 1 })).toBe('he2017drain, p. 1')
    expect(citationLabel({ paper: 'zhu2020loghub', page: null })).toBe('zhu2020loghub')
    expect(citationsToText(ANSWER)).toBe(
      'Drain uses a fixed-depth tree "Drain parses log messages online" [he2017drain, p. 1]; Loghub collects datasets "a large collection of system log datasets" [zhu2020loghub].'
    )
    expect(citedPapers(`${ANSWER} again [[he2017drain|p. 2|"y"]]`)).toEqual(['he2017drain', 'zhu2020loghub'])
  })
})
