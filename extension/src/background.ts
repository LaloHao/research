/**
 * The keyboard shortcut («Agregar a Research» without the popup): the same capture, with the result on the toolbar
 * icon (✓ or !, the message in its tooltip). A page already in the library is left as it is.
 */
import { ConnectorError } from './api'
import { ext, type Tab } from './browser'
import { errorMessage, outcomeMessage } from './errors'
import { capture, connection, inspect, lookup } from './flow'


async function badge(tabId: number | undefined, text: string, color: string, title: string): Promise<void> {
  const api = ext()
  await api.action.setBadgeBackgroundColor({ color, tabId }).catch(() => undefined)
  await api.action.setBadgeText({ text, tabId }).catch(() => undefined)
  await api.action.setTitle({ title, tabId }).catch(() => undefined)
}

async function addFromShortcut(tab: Tab | undefined): Promise<void> {
  const tabId = tab?.id
  await badge(tabId, '…', '#666666', 'Agregando a Research…')
  try {
    if (!tab) throw new ConnectorError('restricted')
    const conn = await connection()
    const inspected = await inspect(tab)
    const existing = await lookup(conn, inspected)
    if (existing) return await badge(tabId, '=', '#2457c5', `Ya está en tu biblioteca como ${existing.key}.`)
    const result = await capture(conn, inspected, () => undefined, () => void ext().action.setBadgeText({ text: '…', tabId }).catch(() => undefined))
    if ('existing' in result) return await badge(tabId, '=', '#2457c5', `Ya está en tu biblioteca como ${result.existing.key}.`)
    await badge(tabId, '✓', '#1e7b34', outcomeMessage(result.status.outcome, result.status.key ?? ''))
  } catch (error) {
    await badge(tabId, '!', '#b3261e', errorMessage(error instanceof ConnectorError ? error.code : 'failed'))
  }
  // The tooltip keeps the message until the tab changes page; the mark goes after a while.
  setTimeout(() => void ext().action.setBadgeText({ text: '', tabId }).catch(() => undefined), 15_000)
}

ext().commands.onCommand.addListener((command, tab) => {
  if (command !== 'add-to-research') return
  if (tab) return void addFromShortcut(tab)
  void ext()
    .tabs.query({ active: true, currentWindow: true })
    .then(([active]) => addFromShortcut(active))
})
