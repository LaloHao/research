import type { PendingApproval } from '../../shared/chatActions'
import { UserFacingError } from '../library/UserFacingError'
import type { ApprovalAnswer } from './ApprovalGate'

/** What a decision from the window needs of the chat service. */
export interface DecisionTarget {
  approval(chatId: string, approvalId: string): PendingApproval | null
  decide(chatId: string, approvalId: string, answer: ApprovalAnswer): void
}

/**
 * «Aprobar» / «Rechazar» from the window. The decision is only the user's click; an approval that needs a PDF
 * (attach_pdf) gets its file from the app's own dialog, opened here in the main process: no path ever comes from the
 * window or the model. A cancelled dialog leaves the card waiting, and a second click while the dialog is open does
 * not open another one.
 */
export class WindowDecisions {
  private readonly picking = new Set<string>()

  constructor(private readonly choosePdf: () => Promise<string | null>) {}

  async decide(service: DecisionTarget, chatId: string, approvalId: string, approve: boolean): Promise<void> {
    if (approve !== true) {
      service.decide(chatId, approvalId, { approve: false })
      return
    }
    const pending = service.approval(chatId, approvalId)
    if (!pending) throw new UserFacingError('approval_gone')
    if (!pending.pickPdf) {
      service.decide(chatId, approvalId, { approve: true })
      return
    }
    const key = `${chatId}/${approvalId}`
    if (this.picking.has(key)) return
    this.picking.add(key)
    let path: string | null
    try {
      path = await this.choosePdf()
    } finally {
      this.picking.delete(key)
    }
    // Cancelled: the card keeps waiting. Denied, timed out or stopped meanwhile: decide() says it is gone.
    if (path) service.decide(chatId, approvalId, { approve: true, pdfPath: path })
  }
}
