import { describe, expect, it } from 'vitest'
import type { ApprovalAnswer } from '../../../src/main/chats/ApprovalGate'
import { WindowDecisions, type DecisionTarget } from '../../../src/main/chats/windowDecisions'
import type { PendingApproval } from '../../../src/shared/chatActions'

function target(pickPdf: boolean | null): DecisionTarget & { answers: ApprovalAnswer[]; gone: boolean } {
  const t = {
    answers: [] as ApprovalAnswer[],
    gone: false,
    approval: (): PendingApproval | null => (pickPdf === null || t.gone ? null : ({ id: 'a0b1c2', pickPdf } as PendingApproval)),
    decide: (_c: string, _a: string, answer: ApprovalAnswer): void => {
      if (pickPdf === null || t.gone) throw Object.assign(new Error('approval_gone'), { code: 'approval_gone' })
      t.answers.push(answer)
    }
  }
  return t
}

describe('WindowDecisions', () => {
  it('denies and approves without a dialog when no file is needed', async () => {
    let dialogs = 0
    const w = new WindowDecisions(async () => {
      dialogs++
      return '/tmp/x.pdf'
    })
    const t = target(false)
    await w.decide(t, 'c', 'a0b1c2', false)
    await w.decide(t, 'c', 'a0b1c2', true)
    expect(t.answers).toEqual([{ approve: false }, { approve: true }])
    expect(dialogs).toBe(0)
  })

  it('approves attach_pdf only with the file picked in the dialog; a cancelled dialog leaves it waiting', async () => {
    const picks: (string | null)[] = [null, '/home/u/paper.pdf']
    const w = new WindowDecisions(async () => picks.shift() ?? null)
    const t = target(true)
    await w.decide(t, 'c', 'a0b1c2', true)
    expect(t.answers).toEqual([])
    await w.decide(t, 'c', 'a0b1c2', true)
    expect(t.answers).toEqual([{ approve: true, pdfPath: '/home/u/paper.pdf' }])
  })

  it('rejecting attach_pdf never opens the dialog', async () => {
    let dialogs = 0
    const w = new WindowDecisions(async () => {
      dialogs++
      return null
    })
    const t = target(true)
    await w.decide(t, 'c', 'a0b1c2', false)
    expect(t.answers).toEqual([{ approve: false }])
    expect(dialogs).toBe(0)
  })

  it('opens one dialog at a time per approval, and an approval gone meanwhile is reported', async () => {
    let release: (p: string) => void = () => undefined
    let dialogs = 0
    const w = new WindowDecisions(
      () =>
        new Promise<string>((r) => {
          dialogs++
          release = r
        })
    )
    const t = target(true)
    const first = w.decide(t, 'c', 'a0b1c2', true)
    await w.decide(t, 'c', 'a0b1c2', true)
    expect(dialogs).toBe(1)
    t.gone = true
    release('/home/u/paper.pdf')
    await expect(first).rejects.toMatchObject({ code: 'approval_gone' })
    expect(t.answers).toEqual([])
  })

  it('an approval that is not waiting is gone', async () => {
    const w = new WindowDecisions(async () => null)
    await expect(w.decide(target(null), 'c', 'a0b1c2', true)).rejects.toMatchObject({ code: 'approval_gone' })
  })
})
