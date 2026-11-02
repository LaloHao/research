import type { WebContents } from 'electron'
import { CONSENT_CSS, HIDE_ATTRIBUTE, OVERLAY_NAME } from '../../shared/pageCapture/consent'

export { CONSENT_CSS, CONSENT_SELECTORS, HIDE_ATTRIBUTE, OVERLAY_NAME } from '../../shared/pageCapture/consent'

/**
 * «Página tal como se ve»: before the live page is printed, cookie-consent dialogs and other overlays are hidden with
 * CSS and the page may scroll again. Nothing is clicked (no «Accept»): the user's choice on the site stays whatever
 * it was. Afterwards the inserted style and marks are removed, so the page the user sees is unchanged.
 */

/**
 * Run in an isolated world (the page's scripts can't see or change it): marks every fixed or sticky element whose
 * id, class or aria-label names a cookie, consent, GDPR or privacy banner, and every fixed element without text that
 * covers most of the window (the dimmed backdrop such a dialog lays over the page). Only marks; returns how many.
 */
export const MARK_FIXED_OVERLAYS = `(() => {
  const name = ${OVERLAY_NAME.toString()};
  const area = window.innerWidth * window.innerHeight;
  let marked = 0;
  for (const el of document.querySelectorAll('body *')) {
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const label = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') || ''].join(' ');
    const box = el.getBoundingClientRect();
    const backdrop = position === 'fixed' && area > 0 && box.width * box.height >= 0.8 * area && (el.textContent || '').trim().length === 0;
    if (!name.test(label) && !backdrop) continue;
    el.setAttribute('${HIDE_ATTRIBUTE}', '');
    marked++;
  }
  return marked;
})()`

/** Run in the same isolated world after printing: the marks go. */
export const UNMARK_OVERLAYS = `(() => { for (const el of document.querySelectorAll('[${HIDE_ATTRIBUTE}]')) el.removeAttribute('${HIDE_ATTRIBUTE}'); return true; })()`

export type OverlayContents = Pick<WebContents, 'insertCSS' | 'removeInsertedCSS' | 'executeJavaScriptInIsolatedWorld'>

/** Runs `print` with consent overlays hidden in the page, and puts the page back as it was afterwards. */
export async function withoutOverlays<T>(contents: OverlayContents, worldId: number, print: () => Promise<T>): Promise<T> {
  // A page that refuses the marks still gets the known containers hidden.
  await contents.executeJavaScriptInIsolatedWorld(worldId, [{ code: MARK_FIXED_OVERLAYS }]).catch(() => 0)
  const key = await contents.insertCSS(CONSENT_CSS, { cssOrigin: 'user' }).catch(() => null)
  try {
    return await print()
  } finally {
    if (key) await contents.removeInsertedCSS(key).catch(() => undefined)
    await contents.executeJavaScriptInIsolatedWorld(worldId, [{ code: UNMARK_OVERLAYS }]).catch(() => undefined)
  }
}
