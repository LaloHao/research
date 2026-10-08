export type Tab = 'pdf' | 'content' | 'notes'

/**
 * Which tabs to show for a paper's detail view.
 * - A web page with readable content but no PDF (local or downloadable): no PDF tab.
 * - A web page with readable content and a PDF: all three.
 * - Everything else (no readable content, e.g. a regular paper): PDF and notes only.
 */
export function paperTabs(detail: { content: string | null; hasPdf: boolean }): Tab[] {
  if (detail.content !== null && !detail.hasPdf) return ['content', 'notes']
  if (detail.content !== null) return ['content', 'pdf', 'notes']
  return ['pdf', 'notes']
}
