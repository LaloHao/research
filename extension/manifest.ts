/** The extension's manifest (Manifest V3) for each browser: one definition, only the background and the browser's own settings differ. */

export type Browser = 'firefox' | 'chrome'

export const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }

export const FIREFOX_ID = 'research-connector@lalohao'

export function manifest(browser: Browser, version: string): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Research Connector',
    version,
    description: 'Agrega la página que estás viendo a tu biblioteca de Research (la app de escritorio), con tu sesión del navegador.',
    icons: ICONS,
    action: { default_title: 'Agregar a Research', default_popup: 'popup.html', default_icon: ICONS },
    options_ui: { page: 'options.html', open_in_tab: true },
    // The page is read only when the user clicks or presses the shortcut (activeTab), never on its own.
    permissions: ['activeTab', 'scripting', 'storage'],
    // Asked at runtime for one site, only to download a PDF the page itself can't hand over.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    commands: {
      'add-to-research': { suggested_key: { default: 'Alt+Shift+R' }, description: 'Agregar la página a Research' }
    },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
    ...(browser === 'firefox'
      ? {
          background: { scripts: ['background.js'] },
          browser_specific_settings: {
            gecko: { id: FIREFOX_ID, strict_min_version: '142.0', data_collection_permissions: { required: ['none'] } }
          }
        }
      : { background: { service_worker: 'background.js' }, minimum_chrome_version: '116' })
  }
}
