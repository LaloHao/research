import es from '../../renderer/i18n/es.json'

/**
 * The tray's texts, from the window's own es.json (`tray.*`, and `sync.status.*` for the sync line): the main process
 * has no i18next, so this is the small part of it the tray needs — `{{name}}` values and `_one`/`_other` by `count`.
 */
export function trayText(key: string, values: Record<string, string | number> = {}): string {
  const base = lookup(key)
  let template = typeof base === 'string' ? base : null
  if (template === null && typeof values.count === 'number') {
    const plural = lookup(`${key}_${values.count === 1 ? 'one' : 'other'}`)
    template = typeof plural === 'string' ? plural : null
  }
  if (template === null) return key
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''))
}

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es)
}
