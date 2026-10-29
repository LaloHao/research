import type { WebContents } from 'electron'

/**
 * «Página tal como se ve»: before the live page is printed, cookie-consent dialogs and other overlays are hidden with
 * CSS and the page may scroll again. Nothing is clicked (no «Accept»): the user's choice on the site stays whatever
 * it was. Afterwards the inserted style and marks are removed, so the page the user sees is unchanged.
 */

/** The consent platforms sites embed most, by their own containers and backdrops. */
export const CONSENT_SELECTORS = [
  // OneTrust
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk', '.onetrust-pc-dark-filter', '.ot-sdk-container.ot-fade-in',
  // Cookiebot
  '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#cookiebanner',
  // Didomi
  '#didomi-host', '#didomi-popup', '.didomi-popup-backdrop', '.didomi-notice',
  // Quantcast Choice (QC CMP)
  '#qc-cmp2-container', '.qc-cmp2-container', '#qcCmpUi', '.qc-cmp-ui-container', '.qc-cmp2-main',
  // TrustArc
  '#truste-consent-track', '#consent_blackbar', '#truste-consent-content', '.truste_overlay', '.truste_box_overlay', '.truste_popframe',
  // Usercentrics
  '#usercentrics-root', '#usercentrics-cmp-ui', '#uc-banner-modal', '#uc-center-container',
  // Sourcepoint
  '[id^="sp_message_container"]', '.sp_veil', '.message-overlay',
  // Osano
  '.osano-cm-window', '.osano-cm-dialog', '.osano-cm-dialog--type_bar',
  // Termly
  '#termly-code-snippet-support', '[class^="termly-styles-root"]', '#termly-consent-banner',
  // Complianz
  '#cmplz-cookiebanner-container', '.cmplz-cookiebanner', '.cmplz-soft-cookiewall',
  // CookieYes / Cookie Law Info
  '.cky-consent-container', '.cky-overlay', '.cky-modal', '#cookie-law-info-bar', '.cli-modal-backdrop'
] as const

/** Marks the elements found by `MARK_FIXED_OVERLAYS`; the inserted style hides them. */
export const HIDE_ATTRIBUTE = 'data-research-capture-hide'

/** An id, class or aria-label that names a consent or privacy banner. */
export const OVERLAY_NAME = /cookie|consent|gdpr|privacy[-_]?banner/i

/** The style inserted before printing: known consent containers and marked overlays hidden, scrolling restored. */
export const CONSENT_CSS = `${CONSENT_SELECTORS.join(',\n')},
[${HIDE_ATTRIBUTE}] { display: none !important; visibility: hidden !important; }
html, body { overflow: visible !important; overflow-y: visible !important; height: auto !important; max-height: none !important; }
body { position: static !important; }
`

/**
 * Run in an isolated world (the page's scripts can't see or change it): marks every fixed or sticky element whose
 * id, class or aria-label names a cookie, consent, GDPR or privacy banner. Only marks; returns how many.
 */
export const MARK_FIXED_OVERLAYS = `(() => {
  const name = ${OVERLAY_NAME.toString()};
  let marked = 0;
  for (const el of document.querySelectorAll('body *')) {
    const label = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') || ''].join(' ');
    if (!name.test(label)) continue;
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
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
