import type { TextStatus } from '../../shared/library'

export type Tab = 'summary' | 'pdf' | 'text' | 'content' | 'relations' | 'chat' | 'notes'

/**
 * Which tabs to show for a paper's detail view; the summary always comes first, then the reading tabs, then relations,
 * chat and notes.
 * - A web page with readable content but no PDF (local or downloadable): no PDF tab.
 * - A web page with readable content and a PDF: all of them.
 * - Everything else (no readable content, e.g. a regular paper): summary, PDF, relations, chat and notes.
 * The text tab (the PDF's extracted text, reflowed) goes right after the PDF when there is a PDF and its text is indexed.
 */
export function paperTabs(detail: { content: string | null; hasPdf: boolean; textStatus: TextStatus }): Tab[] {
  const tail: Tab[] = ['relations', 'chat', 'notes']
  if (detail.content !== null && !detail.hasPdf) return ['summary', 'content', ...tail]
  const pdf: Tab[] = detail.hasPdf && detail.textStatus === 'ok' ? ['pdf', 'text'] : ['pdf']
  if (detail.content !== null) return ['summary', 'content', ...pdf, ...tail]
  return ['summary', ...pdf, ...tail]
}
