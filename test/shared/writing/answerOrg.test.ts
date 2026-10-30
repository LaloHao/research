import { describe, expect, it } from 'vitest'
import type { ChatCitation } from '../../../src/shared/chat'
import { answerToOrg } from '../../../src/shared/writing/answerOrg'

const at = (text: string, start: number, end: number): string => [...text].slice(start, end).join('')

describe('answerToOrg', () => {
  it('turns each citation marker into [key, p. N] with its code-point offsets, the checked page and state', () => {
    const md = '😀 Drain is online [[he2017drain|p. 1|"Drain parses logs"]] and fast [[zhu2019loghub|"fast"]].'
    const checks: ChatCitation[] = [
      { paper: 'he2017drain', page: 2, quote: 'Drain parses logs', state: 'found' },
      { paper: 'zhu2019loghub', page: null, quote: 'fast', state: 'not_found' }
    ]
    const out = answerToOrg(md, checks)
    expect(out.text).toBe('😀 Drain is online [he2017drain, p. 2] and fast [zhu2019loghub].')
    expect(out.citations).toEqual([
      { start: 18, end: 37, key: 'he2017drain', page: 2, quote: 'Drain parses logs', state: 'found' },
      { start: 47, end: 62, key: 'zhu2019loghub', page: null, quote: 'fast', state: 'not_found' }
    ])
    for (const c of out.citations) expect(at(out.text, c.start, c.end)).toMatch(/^\[[a-z0-9]+(?:, p\. \d+)?\]$/)
    // Without checks (an answer still being written) the page is the marker's and nothing is checked yet.
    expect(answerToOrg(md).citations.map((c) => [c.page, c.state])).toEqual([
      [1, null],
      [null, null]
    ])
  })

  it('writes Markdown as Org: headings as bold lines, lists, emphasis, code, links, quotes and tables', () => {
    const md = [
      '## What works',
      '',
      '* **Clear** claim, with *some* emphasis and `code` in a [link](https://x.org).',
      '+ snake_case_names stay',
      '1. first',
      '',
      '> a quote',
      '> goes on',
      '',
      '| a | b |',
      '|---|:-:|',
      '| 1 | 2 |',
      '',
      '---'
    ].join('\n')
    expect(answerToOrg(md).text).toBe(
      [
        '*What works*',
        '',
        '- *Clear* claim, with /some/ emphasis and ~code~ in a [[https://x.org][link]].',
        '- snake_case_names stay',
        '1. first',
        '',
        '#+begin_quote',
        'a quote',
        'goes on',
        '#+end_quote',
        '',
        '| a | b |',
        '|---+---|',
        '| 1 | 2 |',
        '',
        '-----'
      ].join('\n')
    )
  })

  it("sets Claude's proposal apart in a quote block and code in src or example blocks, escaping Org syntax inside", () => {
    const md = ['Comments.', '', 'Propuesta de Claude (no es tu texto):', '```proposal', '* Heading inside', 'Text [cite:@he2017drain].', '```', '```python', 'x = 1', '```', '```', '#+title: x', '```'].join('\n')
    expect(answerToOrg(md).text).toBe(
      [
        'Comments.',
        '',
        'Propuesta de Claude (no es tu texto):',
        '#+begin_quote',
        ',* Heading inside',
        'Text [cite:@he2017drain].',
        '#+end_quote',
        '#+begin_src python',
        'x = 1',
        '#+end_src',
        '#+begin_example',
        ',#+title: x',
        '#+end_example'
      ].join('\n')
    )
    // An unterminated fence is closed.
    expect(answerToOrg('```\ncode').text).toBe('#+begin_example\ncode\n#+end_example')
  })

  it('never leaves a line that reads as an Org heading or keyword', () => {
    expect(answerToOrg('#+include: "/etc/passwd"\n** bold start** and more').text).toBe(',#+include: "/etc/passwd"\n,** bold start** and more')
  })
})
