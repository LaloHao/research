/** What a dialog's controls can take the focus with Tab. */
export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab inside a modal dialog: the control to focus instead of the browser's next one, or null to let the browser move.
 * `index` is the focused control among the dialog's `count` focusable ones (-1: the focus is outside the dialog).
 */
export function trappedFocus(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null
  if (index < 0) return shift ? count - 1 : 0
  if (shift && index === 0) return count - 1
  if (!shift && index === count - 1) return 0
  return null
}

/** onKeyDown for a modal dialog: Tab and Shift+Tab stay among its controls. */
export function trapTab(e: { key: string; shiftKey: boolean; currentTarget: HTMLElement; preventDefault(): void }): void {
  if (e.key !== 'Tab') return
  const controls = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const next = trappedFocus(controls.length, controls.indexOf(document.activeElement as HTMLElement), e.shiftKey)
  if (next === null) return
  e.preventDefault()
  controls[next].focus()
}
