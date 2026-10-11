import { describe, expect, it } from 'vitest'
import { afterPick, droppedPdf, isFileDrag } from '../../src/renderer/lib/attachPdf'

const file = (name: string): { name: string } => ({ name })

describe('droppedPdf', () => {
  it('takes a single file ending in .pdf, in any case', () => {
    const one = file('Paper.PDF')
    expect(droppedPdf([one])).toBe(one)
    expect(droppedPdf([file('drain.pdf')])?.name).toBe('drain.pdf')
  })

  it('ignores drops with no file, several files or something else than a PDF', () => {
    expect(droppedPdf([])).toBeNull()
    expect(droppedPdf([file('a.pdf'), file('b.pdf')])).toBeNull()
    expect(droppedPdf([file('notes.txt')])).toBeNull()
    expect(droppedPdf([file('pdf')])).toBeNull()
  })
})

describe('isFileDrag', () => {
  it('is true only when the drag carries files', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true)
    expect(isFileDrag(['text/plain'])).toBe(false)
    expect(isFileDrag([])).toBe(false)
  })
})

describe('afterPick', () => {
  it('does nothing when the user cancelled the picker', () => {
    expect(afterPick(null, false)).toEqual({ kind: 'idle' })
    expect(afterPick(null, true)).toEqual({ kind: 'idle' })
  })

  it('attaches right away when the paper has no PDF', () => {
    expect(afterPick('/home/me/drain.pdf', false)).toEqual({ kind: 'send', path: '/home/me/drain.pdf', replace: false })
  })

  it('asks before replacing an existing PDF', () => {
    expect(afterPick('/home/me/drain.pdf', true)).toEqual({ kind: 'confirm', path: '/home/me/drain.pdf' })
  })
})
