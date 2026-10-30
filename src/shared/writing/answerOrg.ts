import type { ChatCitation, CitationState } from '../chat'
import { citationLabel, parseCitations } from '../chatCitations'

/** One citation of an answer converted to Org: where its `[key, p. N]` is (code points) and what it cites. */
export interface OrgCitation {
  start: number
  end: number
  key: string
  page: number | null
  quote: string
  /** How it checked against the paper's text; null while the answer is being written (not checked yet). */
  state: CitationState | null
}

export interface OrgAnswer {
  text: string
  citations: OrgCitation[]
}

// Private-use characters hold what must not be touched by the inline rules: citations, code and links.
const CITE_OPEN = String.fromCharCode(0xe000)
const CITE_CLOSE = String.fromCharCode(0xe001)
const KEEP_OPEN = String.fromCharCode(0xe002)
const KEEP_CLOSE = String.fromCharCode(0xe003)
const CITE_TOKEN = new RegExp(`${CITE_OPEN}(\\d+)${CITE_CLOSE}`, 'g')
const KEEP_TOKEN = new RegExp(`${KEEP_OPEN}(\\d+)${KEEP_CLOSE}`, 'g')

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

/** A line inside a block, escaped as Org wants it: a leading `*` or `#+` (comma-escaped already or not) gets a comma. */
const escapeBlockLine = (line: string): string => (/^(?:,*\*|,*#\+)/.test(line) ? `,${line}` : line)

/** Inline Markdown as Org: `code` → ~code~, [text](url) → [[url][text]], **bold** → *bold*, *it* / _it_ → /it/. */
function inline(line: string): string {
  const kept: string[] = []
  const keep = (s: string): string => `${KEEP_OPEN}${kept.push(s) - 1}${KEEP_CLOSE}`
  let out = line
    .replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`~${code}~`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => keep(`[[${url}][${text}]]`))
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, (_m, s: string) => keep(`*${s}*`))
    .replace(/(?<![\p{L}\p{N}_])__(?!\s)([^_\n]+?)(?<!\s)__(?![\p{L}\p{N}_])/gu, (_m, s: string) => keep(`*${s}*`))
    .replace(/(?<![\p{L}\p{N}*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}*])/gu, (_m, s: string) => `/${s}/`)
    .replace(/(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, (_m, s: string) => `/${s}/`)
  // Kept parts may hold other kept parts (a link's text with code): restore until none is left.
  while (out.includes(KEEP_OPEN)) out = out.replace(KEEP_TOKEN, (_m, i: string) => kept[Number(i)])
  return out
}

/**
 * One of Claude's answers (Markdown with citation markers) as plain Org text for an editor buffer: each marker becomes
 * `[key, p. N]` (the page where the app found the quote, when `checks` says so), headings become bold lines, lists
 * use `-`, fenced blocks become `#+begin_src`/`#+begin_example` (a ```proposal block, Claude's proposed rewrite, a
 * quote block) and quotes `#+begin_quote`. `checks` is `verifyCitations` of the same text (aligned by index); without
 * it the citations' state is null. Offsets count code points, as an editor counts characters.
 */
export function answerToOrg(markdown: string, checks?: ChatCitation[]): OrgAnswer {
  const markers = parseCitations(markdown)
  let text = ''
  let at = 0
  markers.forEach((m, i) => {
    text += markdown.slice(at, m.start) + `${CITE_OPEN}${i}${CITE_CLOSE}`
    at = m.end
  })
  text += markdown.slice(at)

  const out: string[] = []
  let fence: { mark: string; end: string } | null = null
  let quoting = false
  const closeQuote = (): void => {
    if (quoting) out.push('#+end_quote')
    quoting = false
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (line.trim().startsWith(fence.mark) && line.trim().replace(/[`~]/g, '') === '') {
        out.push(fence.end)
        fence = null
      } else out.push(escapeBlockLine(line))
      continue
    }
    const f = FENCE.exec(line)
    if (f) {
      closeQuote()
      const lang = f[2].toLowerCase()
      const [begin, end] = lang === 'proposal' ? ['#+begin_quote', '#+end_quote'] : lang ? [`#+begin_src ${f[2]}`, '#+end_src'] : ['#+begin_example', '#+end_example']
      out.push(begin)
      fence = { mark: f[1], end }
      continue
    }
    const q = QUOTE.exec(line)
    if (q) {
      if (!quoting) out.push('#+begin_quote')
      quoting = true
      out.push(escapeBlockLine(inline(q[1])))
      continue
    }
    closeQuote()
    const h = HEADING.exec(line)
    if (h) {
      const title = inline(h[1].replace(/^\*\*(.*)\*\*$/, '$1'))
      out.push(title ? `*${title}*` : '')
    } else if (RULE.test(line)) out.push('-----')
    else if (TABLE_SEPARATOR.test(line)) out.push(line.trim().replace(/-\s*\|\s*(?=:?-)/g, '-+').replace(/:/g, '-'))
    else {
      const converted = inline(line.replace(/^(\s*)[*+](\s+)/, '$1-$2'))
      // A line that would read as an Org heading or keyword stays text.
      out.push(/^(?:\*+\s|#\+)/.test(converted) ? `,${converted}` : converted)
    }
  }
  if (fence) out.push(fence.end)
  closeQuote()
  const org = out.join('\n')

  const citations: OrgCitation[] = []
  let result = ''
  let points = 0
  let last = 0
  for (const m of org.matchAll(CITE_TOKEN)) {
    const before = org.slice(last, m.index)
    result += before
    points += [...before].length
    const i = Number(m[1])
    const marker = markers[i]
    const check = checks?.[i]
    const page = check ? check.page : marker.page
    const label = `[${citationLabel({ paper: marker.paper, page })}]`
    citations.push({ start: points, end: points + label.length, key: marker.paper, page, quote: marker.quote, state: check ? check.state : null })
    result += label
    points += label.length
    last = m.index + m[0].length
  }
  result += org.slice(last)
  return { text: result, citations }
}
