import { describe, expect, it } from 'vitest'
import { trappedFocus } from '../../src/renderer/lib/focusTrap'

describe('trappedFocus', () => {
  it('wraps Tab from the last control to the first and Shift+Tab from the first to the last', () => {
    expect(trappedFocus(3, 2, false)).toBe(0)
    expect(trappedFocus(3, 0, true)).toBe(2)
  })
  it('leaves Tab between inner controls to the browser', () => {
    expect(trappedFocus(3, 0, false)).toBeNull()
    expect(trappedFocus(3, 2, true)).toBeNull()
  })
  it('brings a focus outside the dialog back in', () => {
    expect(trappedFocus(3, -1, false)).toBe(0)
    expect(trappedFocus(3, -1, true)).toBe(2)
  })
  it('does nothing without focusable controls', () => {
    expect(trappedFocus(0, -1, false)).toBeNull()
  })
})
