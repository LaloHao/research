import { describe, expect, it } from 'vitest'
import { unverifiedCount, verifyCitations, type CitationSources } from '../../../src/main/chats/citations'
import { DRAIN_ID, DRAIN_PAGES } from '../../helpers/pair'

const sources: CitationSources = {
  paperState: (id) => (id === DRAIN_ID ? 'library' : id === 'old2019trashed' ? 'trash' : 'missing'),
  pages: () => DRAIN_PAGES.map((text, i) => ({ page: i + 1, text }))
}

describe('verifyCitations', () => {
  it('checks each quote against the paper text like the summaries, fixing the page', () => {
    const answer = [
      '[[he2017drain|p. 1|"reaches the highest accuracy"]]',
      '[[he2017drain|p. 1|"DRAIN parses  log messages online"]]',
      '[[he2017drain|p. 2|"an invented sentence that is not there"]]',
      '[[old2019trashed|p. 1|"x y z"]]',
      '[[nobody2020x|"x y z"]]'
    ].join(' ')
    const checked = verifyCitations(answer, sources)
    expect(checked).toEqual([
      { paper: DRAIN_ID, page: 2, quote: 'reaches the highest accuracy', state: 'found' },
      { paper: DRAIN_ID, page: 1, quote: 'DRAIN parses  log messages online', state: 'found' },
      { paper: DRAIN_ID, page: 2, quote: 'an invented sentence that is not there', state: 'not_found' },
      { paper: 'old2019trashed', page: 1, quote: 'x y z', state: 'paper_in_trash' },
      { paper: 'nobody2020x', page: null, quote: 'x y z', state: 'unknown_paper' }
    ])
    expect(unverifiedCount(checked)).toBe(3)
  })

  it('reads each cited paper once', () => {
    let reads = 0
    verifyCitations('[[he2017drain|p. 1|"a"]] [[he2017drain|p. 2|"b"]]', { ...sources, pages: (id) => (reads++, sources.pages(id)) })
    expect(reads).toBe(1)
  })

  it('has nothing to check in an answer without markers', () => {
    expect(verifyCitations('No citations [[here', sources)).toEqual([])
  })
})
