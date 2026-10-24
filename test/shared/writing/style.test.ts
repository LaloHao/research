import { describe, expect, it } from 'vitest'
import type { CiteFormat } from '../../../src/shared/writing/citations'
import {
  applyStyleSuggestions,
  droppedCount,
  locateOriginal,
  MAX_STYLE_SUGGESTIONS,
  parseStyleOutput,
  protectedSpans,
  styleSegments,
  validateStyleSuggestions,
  type RawStyleSuggestion
} from '../../../src/shared/writing/style'

const raw = (original: string, suggestion: string, over: Partial<RawStyleSuggestion> = {}): RawStyleSuggestion => ({
  original,
  suggestion,
  reason: 'r',
  category: 'clarity',
  context: null,
  ...over
})

/** Whether one suggestion survives validation. */
const kept = (text: string, original: string, suggestion: string, format: CiteFormat = 'latex'): boolean =>
  validateStyleSuggestions(text, format, [raw(original, suggestion)]).suggestions.length === 1

describe('parseStyleOutput', () => {
  it('accepts a well-formed answer and trims reasons', () => {
    const r = parseStyleOutput({ suggestions: [{ original: 'a', suggestion: 'b', reason: ' why ', category: 'grammar', context: null }] })
    expect(r).toEqual({ ok: true, suggestions: [{ original: 'a', suggestion: 'b', reason: 'why', category: 'grammar', context: null }] })
  })

  it('rejects extra fields, unknown categories, empty originals, missing context and too many suggestions', () => {
    const one = { original: 'a', suggestion: 'b', reason: 'r', category: 'clarity', context: null }
    expect(parseStyleOutput({ suggestions: [{ ...one, extra: 1 }] }).ok).toBe(false)
    expect(parseStyleOutput({ suggestions: [{ ...one, category: 'tone' }] }).ok).toBe(false)
    expect(parseStyleOutput({ suggestions: [{ ...one, original: '' }] }).ok).toBe(false)
    const { context: _c, ...withoutContext } = one
    expect(parseStyleOutput({ suggestions: [withoutContext] }).ok).toBe(false)
    expect(parseStyleOutput({ suggestions: Array.from({ length: MAX_STYLE_SUGGESTIONS + 1 }, () => one) }).ok).toBe(false)
    expect(parseStyleOutput({ suggestions: [], more: true }).ok).toBe(false)
    expect(parseStyleOutput('nope').ok).toBe(false)
  })
})

describe('locateOriginal', () => {
  const text = 'The model is good. The model is fast. It is good.'

  it('finds a unique fragment verbatim, and nothing that differs in a character', () => {
    expect(locateOriginal(text, 'is fast', null)).toEqual({ start: 29, end: 36 })
    expect(locateOriginal(text, 'is  fast', null)).toBe('not_found')
    expect(locateOriginal(text, 'Is fast', null)).toBe('not_found')
  })

  it('needs a context that occurs once and contains the fragment once when the fragment repeats', () => {
    expect(locateOriginal(text, 'The model', null)).toBe('ambiguous')
    expect(locateOriginal(text, 'The model', 'The model is fast')).toEqual({ start: 19, end: 28 })
    // The context repeats, or holds the fragment twice, or is not in the text.
    expect(locateOriginal(text, 'is', 'The model is')).toBe('ambiguous')
    expect(locateOriginal(text, 'is', 'is fast. It is')).toBe('ambiguous')
    expect(locateOriginal(text, 'The model', 'The model is slow')).toBe('ambiguous')
  })

  it('counts overlapping occurrences as repeated', () => {
    expect(locateOriginal('aaa', 'aa', null)).toBe('ambiguous')
  })
})

describe('protected constructs', () => {
  const text = 'As shown by \\citet{smith2020} the method works.'

  it('keeps an edit that leaves the citation as written', () => {
    expect(kept(text, 'the method works', 'the method is effective')).toBe(true)
    expect(kept(text, 'As shown by \\citet{smith2020} the', 'As \\citet{smith2020} showed, the')).toBe(true)
  })

  it('drops an edit that changes a LaTeX citation key or command', () => {
    expect(kept(text, 'As shown by \\citet{smith2020}', 'As shown by \\citet{smith2021}')).toBe(false)
    expect(kept(text, 'As shown by \\citet{smith2020}', 'As shown by \\citep{smith2020}')).toBe(false)
  })

  it('drops an edit that removes or adds a citation', () => {
    expect(kept(text, 'As shown by \\citet{smith2020} the', 'The')).toBe(false)
    expect(kept(text, 'the method works', 'the method works \\cite{doe2019}')).toBe(false)
  })

  it('protects pandoc citations in Markdown', () => {
    const md = 'Logs are noisy [@he2017drain, p. 3] and long.'
    expect(kept(md, 'noisy [@he2017drain, p. 3] and', 'noisy [@he2017drain, p. 4] and', 'markdown')).toBe(false)
    expect(kept(md, 'and long', 'and lengthy', 'markdown')).toBe(true)
  })

  it('protects org-cite citations in Org', () => {
    const org = 'Logs are noisy [cite:@he2017drain] and long.'
    expect(kept(org, 'noisy [cite:@he2017drain]', 'noisy [cite/t:@he2017drain]', 'org')).toBe(false)
    expect(kept(org, 'noisy [cite:@he2017drain]', 'very noisy [cite:@he2017drain]', 'org')).toBe(true)
  })

  it('protects inline $…$ math', () => {
    const t = 'The cost is $O(n^2)$ in the worst case.'
    expect(kept(t, 'is $O(n^2)$ in', 'is $O(n \\log n)$ in')).toBe(false)
    expect(kept(t, 'in the worst case', 'at worst')).toBe(true)
    // A price is not math: `$5 and $` closes after a space.
    expect(protectedSpans('It costs $5 and $10.', 'markdown')).toEqual([])
  })

  it('protects display $$…$$ math', () => {
    const t = 'We minimize $$\\sum_i x_i$$ over all inputs.'
    expect(kept(t, 'minimize $$\\sum_i x_i$$', 'minimize $$\\sum_j x_j$$')).toBe(false)
  })

  it('protects \\(…\\) math, in LaTeX and in Org', () => {
    expect(kept('Let \\(x > 0\\) hold.', 'Let \\(x > 0\\) hold', 'Let \\(x \\geq 0\\) hold')).toBe(false)
    expect(kept('Let \\(x > 0\\) hold.', 'Let \\(x > 0\\) hold', 'Assume \\(x > 0\\) holds', 'org')).toBe(true)
    expect(kept('Let \\(x > 0\\) hold.', 'Let \\(x > 0\\)', 'Let x be positive', 'org')).toBe(false)
  })

  it('protects \\[…\\] display math', () => {
    expect(kept('Then \\[a = b\\] follows.', 'Then \\[a = b\\]', 'Then \\[a = c\\]')).toBe(false)
  })

  it('protects math environments', () => {
    const t = 'We get\n\\begin{equation}\ny = mx\n\\end{equation}\nas expected.'
    expect(kept(t, 'y = mx', 'y = mx + b')).toBe(false)
    expect(kept(t, 'as expected', 'as we expected')).toBe(true)
  })

  it('protects LaTeX commands and escapes', () => {
    const t = 'This is \\emph{very} important and costs 5\\% more.'
    expect(kept(t, 'is \\emph{very} important', 'is very important')).toBe(false)
    expect(kept(t, 'is \\emph{very} important', 'is \\emph{really} important')).toBe(true)
    expect(kept(t, 'costs 5\\% more', 'costs 5 percent more')).toBe(false)
  })

  it('protects \\ref and its argument', () => {
    const t = 'See Section~\\ref{sec:method} for details.'
    expect(kept(t, 'See Section~\\ref{sec:method}', 'See Section~\\ref{sec:methods}')).toBe(false)
    expect(kept(t, 'See Section~\\ref{sec:method} for details', 'Section~\\ref{sec:method} gives the details')).toBe(true)
  })

  it('protects \\label and its argument', () => {
    const t = '\\section{Method}\\label{sec:method} We parse logs.'
    expect(kept(t, '\\label{sec:method} We parse', '\\label{sec:meth} We parse')).toBe(false)
    expect(kept(t, '\\label{sec:method} We parse', 'We parse')).toBe(false)
  })

  it('protects Org links, with or without a description', () => {
    const org = 'Read [[https://example.org][the docs]] and [[file:notes.org]] first.'
    expect(kept(org, '[[https://example.org][the docs]]', '[[https://example.org][the documentation]]', 'org')).toBe(false)
    expect(kept(org, 'and [[file:notes.org]] first', 'first', 'org')).toBe(false)
    expect(kept(org, 'first', 'beforehand', 'org')).toBe(true)
  })

  it('protects Org macros', () => {
    const org = 'The tool {{{version(2)}}} is fast.'
    expect(kept(org, 'tool {{{version(2)}}} is', 'tool {{{version(3)}}} is', 'org')).toBe(false)
  })

  it('protects Org keyword lines', () => {
    const org = '#+TITLE: My thesis\nThis are the intro.'
    expect(kept(org, '#+TITLE: My thesis', '#+TITLE: My Thesis', 'org')).toBe(false)
    expect(kept(org, 'This are', 'This is', 'org')).toBe(true)
  })

  it('protects the app’s citation markers', () => {
    const t = 'Drain is fast [[he2017drain|p. 2|"Drain reaches the highest accuracy"]] overall.'
    expect(kept(t, '[[he2017drain|p. 2|"Drain reaches the highest accuracy"]]', '[[he2017drain|p. 3|"Drain reaches the highest accuracy"]]', 'markdown')).toBe(false)
    expect(kept(t, 'is fast', 'is quick', 'markdown')).toBe(true)
  })

  it('judges the result: an edit that breaks a construct after it is dropped', () => {
    // A `%` would comment out the citation that follows on the line.
    const latex = 'Accuracy rose by 50 percent \\cite{he2017drain} on average.'
    expect(kept(latex, '50 percent', '50%')).toBe(false)
    expect(kept(latex, '50 percent', 'fifty percent')).toBe(true)
    // A `$` would open math that swallows the `$x$` after it.
    const md = 'Cost is high when $x$ grows.'
    expect(kept(md, 'Cost is high', 'Cost is $high', 'markdown')).toBe(false)
    expect(kept(md, 'Cost is high', 'The cost is high', 'markdown')).toBe(true)
    // Braces inside \emph{} would close it early and open a stray group.
    const emph = 'We stress \\emph{this point} here.'
    expect(kept(emph, 'this', 'this} and {that')).toBe(false)
    expect(kept(emph, 'this', 'that')).toBe(true)
    expect(kept('Org text {{{x}}}.', 'Org text', 'Org {text', 'org')).toBe(false)
  })

  it('drops an original that cuts through a protected construct, even if the suggestion is plain', () => {
    const t = 'As shown by \\citet{smith2020} the method works.'
    expect(kept(t, 'by \\citet{smi', 'by \\citet{smi')).toBe(false)
    expect(kept(t, 'smith2020} the', 'smith2020} this')).toBe(false)
  })
})

describe('validateStyleSuggestions', () => {
  const text = 'One two three four five six.'

  it('keeps disjoint suggestions in text order, numbered', () => {
    const r = validateStyleSuggestions(text, 'markdown', [raw('five', '5'), raw('One two', 'Uno dos')])
    expect(r.suggestions.map((s) => [s.id, s.original, s.start])).toEqual([
      [0, 'One two', 0],
      [1, 'five', 19]
    ])
    expect(droppedCount(r.dropped)).toBe(0)
  })

  it('keeps the suggestion that starts first when two overlap, and the one listed first on a tie', () => {
    const r = validateStyleSuggestions(text, 'markdown', [raw('three four', 'x'), raw('two three', 'y'), raw('two', 'z'), raw('six', 'seis')])
    expect(r.suggestions.map((s) => s.suggestion)).toEqual(['y', 'seis'])
    expect(r.dropped.overlap).toBe(2)
    // Adjacent ranges do not overlap.
    expect(validateStyleSuggestions(text, 'markdown', [raw('One', 'A'), raw(' two', ' B')]).suggestions).toHaveLength(2)
  })

  it('counts the dropped by reason', () => {
    const r = validateStyleSuggestions('a b a b c $x$', 'markdown', [
      raw('zzz', 'y'),
      raw('a b', 'A B'),
      raw('$x$', '$y$'),
      raw('c', 'c'),
      raw('c', 'C')
    ])
    expect(r.dropped).toEqual({ not_found: 1, ambiguous: 1, protected: 1, overlap: 0, unchanged: 1 })
    expect(r.suggestions.map((s) => s.suggestion)).toEqual(['C'])
  })
})

describe('applying suggestions', () => {
  const text = 'One two three four.'
  const { suggestions } = validateStyleSuggestions(text, 'markdown', [raw('One', '1'), raw('three', '3'), raw('four', '4')])

  it('applies only the accepted ones, in any order', () => {
    expect(applyStyleSuggestions(text, suggestions, new Set())).toBe(text)
    expect(applyStyleSuggestions(text, suggestions, new Set([2, 0]))).toBe('1 two three 4.')
    expect(applyStyleSuggestions(text, suggestions, new Set([0, 1, 2]))).toBe('1 two 3 4.')
  })

  it('cuts the text into unchanged stretches and changes for the diff', () => {
    expect(styleSegments(text, suggestions, new Set([1]))).toEqual([
      { kind: 'change', id: 0, original: 'One', suggestion: '1', accepted: false },
      { kind: 'text', text: ' two ' },
      { kind: 'change', id: 1, original: 'three', suggestion: '3', accepted: true },
      { kind: 'text', text: ' ' },
      { kind: 'change', id: 2, original: 'four', suggestion: '4', accepted: false },
      { kind: 'text', text: '.' }
    ])
  })

  it('ignores a suggestion that no longer matches the text', () => {
    expect(applyStyleSuggestions('Uno two three four.', suggestions, new Set([0, 1]))).toBe('Uno two 3 four.')
  })
})
