import type { ChatCitation, PaperState } from '../../shared/chat'
import { parseCitations } from '../../shared/chatCitations'
import type { IndexCache } from '../cache/IndexCache'
import { locateQuote } from '../summary/evidence'
import { pagesFromChunks, type PageText } from '../summary/paperText'

export interface CitationSources {
  /** Where a cited key is: a library paper (its text can be checked), in the trash, or nowhere. */
  paperState(id: string): PaperState
  /** The indexed text of a library paper, page by page. */
  pages(id: string): PageText[]
}

/** Where a key is and its text, as the index knows them now. */
export function indexSources(cache: IndexCache): CitationSources {
  return {
    paperState: (id) => (cache.getPaper(id) ? 'library' : cache.isTrashed(id) ? 'trash' : 'missing'),
    pages: (id) => pagesFromChunks(cache.chunksFor(id))
  }
}

/** Each marker of an answer checked against the cited paper's text, with the normalization of the summaries' evidence. */
export function verifyCitations(markdown: string, sources: CitationSources): ChatCitation[] {
  const pages = new Map<string, PageText[]>()
  return parseCitations(markdown).map(({ paper, page, quote }): ChatCitation => {
    const state = sources.paperState(paper)
    if (state !== 'library') return { paper, page, quote, state: state === 'trash' ? 'paper_in_trash' : 'unknown_paper' }
    let text = pages.get(paper)
    if (!text) {
      text = sources.pages(paper)
      pages.set(paper, text)
    }
    const located = locateQuote(quote, text, page)
    return { paper, page: located.page, quote, state: located.found ? 'found' : 'not_found' }
  })
}

/** Citations that did not check out («N citas sin verificar»). */
export function unverifiedCount(citations: ChatCitation[]): number {
  return citations.filter((c) => c.state !== 'found').length
}
