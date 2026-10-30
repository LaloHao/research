import { describe, expect, it } from 'vitest'
import { trayText } from '../../../src/main/tray/strings'

describe('tray texts', () => {
  it('come from es.json, with values and plurals', () => {
    expect(trayText('tray.quit')).toBe('Salir')
    expect(trayText('tray.project', { name: 'Tesis' })).toBe('Proyecto: Tesis')
    expect(trayText('tray.jobs', { count: 1 })).toBe('1 trabajo en curso')
    expect(trayText('tray.jobs', { count: 3 })).toBe('3 trabajos en curso')
    expect(trayText('sync.status.minutes', { count: 4 })).toBe('Sincronizado hace 4 min')
  })

  it('has every text the main process uses', () => {
    const keys = ['show', 'hide', 'no_project', 'add_clipboard', 'browse_clipboard', 'sync_line', 'sync_now', 'api_on', 'api_off', 'open_project', 'quit']
    const notify = ['no_identifier', 'no_url', 'added', 'no_project', 'open_failed', 'hint_title', 'hint_body']
    for (const key of [...keys.map((k) => `tray.${k}`), ...notify.map((k) => `tray.notify.${k}`)]) expect(trayText(key)).not.toBe(key)
    for (const key of ['tray.jobs', 'tray.failed']) expect(trayText(key, { count: 2 })).not.toBe(key)
  })
})
