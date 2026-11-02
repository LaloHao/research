import type { PrintToPDFOptions, WebContents } from 'electron'

/**
 * «Página tal como se ve»: the page printed the way the screen shows it, not the way its print stylesheet would (which
 * often hides images, navigation, icons or backgrounds and swaps fonts). The page's screen styles are kept by emulating
 * the screen media type through the DevTools protocol while printing, and it is laid out at the width it had on
 * screen, scaled to fit an A4 page, with backgrounds.
 */

/** A4, with narrow margins (inches, as printToPDF takes them). */
const PAGE_WIDTH_IN = 8.27
const MARGIN_IN = 0.4
/** CSS pixels per inch. */
const PX_PER_IN = 96

/** A page laid out narrower or wider than this is taken as this wide (a phone's width, a very wide monitor). */
export const VIEWPORT_LIMITS = { min: 320, max: 2560 } as const

/** The width the page is laid out at: the one it had on screen, within `VIEWPORT_LIMITS` (1280 when unknown). */
export function layoutWidth(width: unknown): number {
  const n = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : 1280
  return Math.min(VIEWPORT_LIMITS.max, Math.max(VIEWPORT_LIMITS.min, n))
}

/**
 * The print options of a page as it looks: A4, backgrounds on, links kept (Chromium keeps them in the PDF), scaled so
 * the printable width holds `width` CSS pixels, i.e. the page keeps the layout it had at that window width.
 */
export function asSeenPrintOptions(width: number): PrintToPDFOptions {
  const printable = (PAGE_WIDTH_IN - 2 * MARGIN_IN) * PX_PER_IN
  const scale = Math.round(Math.min(2, Math.max(0.1, printable / layoutWidth(width))) * 1000) / 1000
  return {
    pageSize: 'A4',
    printBackground: true,
    scale,
    margins: { top: MARGIN_IN, bottom: MARGIN_IN, left: MARGIN_IN, right: MARGIN_IN },
    generateTaggedPDF: true,
    generateDocumentOutline: true
  }
}

export type DebuggerContents = Pick<WebContents, 'debugger'>

/**
 * Runs `print` with the page's media type emulated as `screen`, then puts it back. If the protocol can't be used (the
 * DevTools are attached to the page, say), the page is printed with its print styles, as before.
 */
export async function withScreenMedia<T>(contents: DebuggerContents, print: () => Promise<T>): Promise<T> {
  const dbg = contents.debugger
  let attached = false
  let emulated = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attached = true
    }
    await dbg.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' })
    emulated = true
  } catch {
    // Printed with the page's print styles.
  }
  try {
    return await print()
  } finally {
    if (emulated) await dbg.sendCommand('Emulation.setEmulatedMedia', { media: '' }).catch(() => undefined)
    if (attached) {
      try {
        dbg.detach()
      } catch {
        // Already gone with the page.
      }
    }
  }
}
