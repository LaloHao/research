export interface PageText {
  /** 1-based page, or null for page-less text (web pages). */
  page: number | null
  text: string
}

export function pagesFromChunks(chunks: { page: number | null; text: string }[]): PageText[] {
  const pages: PageText[] = []
  for (const c of chunks) {
    const last = pages[pages.length - 1]
    if (last && last.page === c.page) last.text = `${last.text} ${c.text}`
    else pages.push({ page: c.page, text: c.text })
  }
  return pages
}

const HEADING = /(?:^|\s)(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Referencias|REFERENCIAS|Bibliografía|BIBLIOGRAFÍA)(?=\s|$)/g

/** Drops the reference list: everything from the last such heading found in the final third of the text. */
export function stripReferences(pages: PageText[]): PageText[] {
  const total = pages.reduce((n, p) => n + p.text.length, 0)
  let offset = 0
  let cut: { page: number; at: number } | null = null
  pages.forEach((p, i) => {
    for (const m of p.text.matchAll(HEADING)) {
      const at = m.index! + (m[0].length - m[1].length)
      if (offset + at >= (total * 2) / 3) cut = { page: i, at }
    }
    offset += p.text.length
  })
  if (!cut) return pages
  const { page, at } = cut as { page: number; at: number }
  const kept = pages.slice(0, page + 1).map((p) => ({ ...p }))
  kept[page].text = kept[page].text.slice(0, at).trimEnd()
  return kept.filter((p) => p.text.length > 0)
}

export function buildPaperText(
  chunks: { page: number | null; text: string }[],
  opts: { maxChars: number; force?: boolean }
): { input: string; pages: PageText[]; chars: number; tooLong: boolean; truncated: boolean } {
  const pages = stripReferences(pagesFromChunks(chunks))
  const full = pages.map((p) => (p.page === null ? p.text : `[p.${p.page}]\n${p.text}`)).join('\n\n')
  const tooLong = full.length > opts.maxChars
  const truncated = tooLong && Boolean(opts.force)
  return { input: truncated ? full.slice(0, opts.maxChars) : full, pages, chars: full.length, tooLong, truncated }
}
