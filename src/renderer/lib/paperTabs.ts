export type Tab = 'summary' | 'pdf' | 'content' | 'relations' | 'notes'

/**
 * Which tabs to show for a paper's detail view; the summary always comes first and relations right before notes.
 * - A web page with readable content but no PDF (local or downloadable): no PDF tab.
 * - A web page with readable content and a PDF: all of them.
 * - Everything else (no readable content, e.g. a regular paper): summary, PDF, relations and notes.
 */
export function paperTabs(detail: { content: string | null; hasPdf: boolean }): Tab[] {
  if (detail.content !== null && !detail.hasPdf) return ['summary', 'content', 'relations', 'notes']
  if (detail.content !== null) return ['summary', 'content', 'pdf', 'relations', 'notes']
  return ['summary', 'pdf', 'relations', 'notes']
}
