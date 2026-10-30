/**
 * The WebExtension APIs the extension uses, under one name: Firefox's `browser` or Chrome's `chrome` (both return
 * promises in Manifest V3). Typed here for just what is called, so no polyfill or type package is needed.
 */

export interface Tab {
  id?: number
  url?: string
  title?: string
}

type Listener<A extends unknown[]> = { addListener(callback: (...args: A) => void): void }

export interface ExtensionApi {
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]>
    get(tabId: number): Promise<Tab>
  }
  scripting: {
    executeScript(details: { target: { tabId: number }; files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[] }): Promise<{ result?: unknown }[]>
  }
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string[]): Promise<void>
    }
  }
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>
    request(permissions: { origins: string[] }): Promise<boolean>
  }
  runtime: {
    getURL(path: string): string
    getManifest(): { version: string }
    openOptionsPage(): Promise<void>
  }
  action: {
    setBadgeText(details: { text: string; tabId?: number }): Promise<void>
    setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>
    setTitle(details: { title: string; tabId?: number }): Promise<void>
  }
  commands: {
    onCommand: Listener<[command: string, tab?: Tab]>
  }
}

const scope = globalThis as unknown as { browser?: ExtensionApi; chrome?: ExtensionApi }

export const ext = (): ExtensionApi => {
  const api = scope.browser ?? scope.chrome
  if (!api) throw new Error('Not running as a browser extension')
  return api
}

/** The extension's own origin (moz-extension://<uuid> or chrome-extension://<id>): what its token is bound to. */
export const ownOrigin = (): string => new URL(ext().runtime.getURL('/')).origin

export const isFirefox = (): boolean => ext().runtime.getURL('/').startsWith('moz-extension:')
