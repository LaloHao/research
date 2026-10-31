/**
 * Cookie-consent overlays, shared by the app (hidden with CSS before the live page is printed) and the browser
 * extension (removed from a page serialized «tal como se ve»). No runtime imports: the extension bundles it.
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
