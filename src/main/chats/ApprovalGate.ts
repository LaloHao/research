import { randomBytes } from 'node:crypto'
import type { DenialReason, PendingApproval } from '../../shared/chatActions'
import type { RunClock } from '../llm/RunClock'

/** The user's click on an approval card; `pdfPath` is the file they picked in the main process's dialog. */
export type ApprovalAnswer = { approve: true; pdfPath?: string } | { approve: false }
export type ApprovalOutcome = { kind: 'approved'; pdfPath?: string } | { kind: 'denied'; reason: DenialReason }

interface Waiting {
  chatId: string
  approval: PendingApproval
  settle: (outcome: ApprovalOutcome) => void
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/**
 * Actions waiting in a conversation for «Aprobar» or «Rechazar». The tool call that asked waits on `ask` (its MCP
 * response is held), with the answer's clock held meanwhile; it settles exactly once, on the user's decision, the
 * timeout, the answer being stopped, the conversation's switch being turned off or the project closing. What the user
 * sees is a frozen copy of the request, so nothing changes it while it waits. Nothing here is persisted: a restart
 * ends the answer.
 */
export class ApprovalGate {
  private readonly waiting = new Map<string, Waiting>()
  /** Every id this gate gave out: a stale «Aprobar» can never reach a newer approval that drew the same id. */
  private readonly issued = new Set<string>()

  constructor(
    private readonly opts: {
      timeoutMs: number
      changed: (chatId: string) => void
      now?: () => Date
      /** Six hex characters; tests replace it. */
      randomId?: () => string
    }
  ) {}

  /** Waits for the user's decision; rejects (holding nothing) only when the request cannot be copied. */
  ask(chatId: string, request: Omit<PendingApproval, 'id' | 'expiresAt'>, signal: AbortSignal, clock?: RunClock): Promise<ApprovalOutcome> {
    if (signal.aborted) return Promise.resolve({ kind: 'denied', reason: 'stopped' })
    let copy: Omit<PendingApproval, 'id' | 'expiresAt'>
    try {
      copy = structuredClone(request)
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.newId()
    const now = (this.opts.now ?? (() => new Date()))()
    const approval: PendingApproval = deepFreeze({
      ...copy,
      pickPdf: request.pickPdf === true,
      id,
      expiresAt: new Date(now.getTime() + this.opts.timeoutMs).toISOString()
    })
    const release = clock?.hold()
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({ kind: 'denied', reason: 'timeout' }), this.opts.timeoutMs)
      const onAbort = (): void => settle({ kind: 'denied', reason: 'stopped' })
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.waiting.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        release?.()
        resolve(outcome)
        this.notify(chatId)
      }
      this.waiting.set(id, { chatId, approval, settle })
      signal.addEventListener('abort', onAbort, { once: true })
      this.notify(chatId)
    })
  }

  pending(chatId: string): PendingApproval[] {
    return [...this.waiting.values()].filter((w) => w.chatId === chatId).map((w) => w.approval)
  }

  get(chatId: string, approvalId: string): PendingApproval | null {
    const w = this.waiting.get(approvalId)
    return w && w.chatId === chatId ? w.approval : null
  }

  /**
   * The user's answer; false when nothing of that conversation waits under that id (it settled meanwhile), or when an
   * approval that picks a PDF comes without one (the card stays pending). A path is passed on only for such an approval.
   */
  decide(chatId: string, approvalId: string, answer: ApprovalAnswer): boolean {
    const w = this.waiting.get(approvalId)
    if (!w || w.chatId !== chatId) return false
    if (answer.approve !== true) {
      w.settle({ kind: 'denied', reason: 'user' })
      return true
    }
    if (!w.approval.pickPdf) {
      w.settle({ kind: 'approved' })
      return true
    }
    if (typeof answer.pdfPath !== 'string' || answer.pdfPath === '') return false
    w.settle({ kind: 'approved', pdfPath: answer.pdfPath })
    return true
  }

  /** Denies what waits in a conversation and matches `test` (a switch turned off, the answer stopped); a test that throws denies. */
  denyWhere(chatId: string, test: (a: PendingApproval) => boolean, reason: DenialReason): void {
    for (const w of [...this.waiting.values()]) {
      if (w.chatId !== chatId) continue
      let match = true
      try {
        match = test(w.approval)
      } catch {
        // Denying is the safe side.
      }
      if (match) w.settle({ kind: 'denied', reason })
    }
  }

  /** Denies everything that waits, in every conversation (the project closing). */
  denyAll(reason: DenialReason): void {
    for (const w of [...this.waiting.values()]) w.settle({ kind: 'denied', reason })
  }

  /** A listener that throws must not leave an approval half settled. */
  private notify(chatId: string): void {
    try {
      this.opts.changed(chatId)
    } catch {
      // The listener only refreshes the window; the approval's own state is already right.
    }
  }

  private newId(): string {
    const random = this.opts.randomId ?? (() => randomBytes(3).toString('hex'))
    for (;;) {
      const id = random()
      if (!this.issued.has(id)) {
        this.issued.add(id)
        return id
      }
    }
  }
}
