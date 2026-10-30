import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { appMenuTemplate, hideAction } from '../../src/main/appMenu'

const items = (menu: MenuItemConstructorOptions): MenuItemConstructorOptions[] => menu.submenu as MenuItemConstructorOptions[]
const find = (template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined =>
  template.flatMap(items).find((item) => item.id === id)
const actions = () => ({ hideWindow: vi.fn(), quit: vi.fn() })

describe('application menu', () => {
  it('has Archivo, Editar and Ver, in Spanish', () => {
    const template = appMenuTemplate({ trayAvailable: true, dev: false }, actions())
    expect(template.map((menu) => menu.label)).toEqual(['Archivo', 'Editar', 'Ver'])
    expect(items(template[0]!).map((item) => item.label ?? item.type)).toEqual(['Ocultar en la bandeja', 'separator', 'Salir'])
    expect(items(template[1]!).map((item) => item.role ?? item.type)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
    // Every item has a Spanish label (not the role's English default).
    for (const item of template.flatMap(items)) if (item.type !== 'separator') expect(item.label).toMatch(/^[A-ZÁÉÍÓÚ]/)
  })

  it('hides the window with Ctrl+W and quits with Ctrl+Q', () => {
    const acts = actions()
    const template = appMenuTemplate({ trayAvailable: true, dev: false }, acts)
    const hide = find(template, 'hide-to-tray')!
    const quit = find(template, 'quit')!
    expect(hide).toMatchObject({ accelerator: 'CmdOrCtrl+W', enabled: true })
    expect(quit.accelerator).toBe('CmdOrCtrl+Q')
    const win = { id: 1 }
    ;(hide.click as (item: unknown, win: unknown, event: unknown) => void)({}, win, {})
    expect(acts.hideWindow).toHaveBeenCalledWith(win)
    ;(quit.click as (item: unknown, win: unknown, event: unknown) => void)({}, undefined, {})
    expect(acts.quit).toHaveBeenCalledOnce()
  })

  it('disables hiding without a tray (nothing could bring the window back)', () => {
    expect(find(appMenuTemplate({ trayAvailable: false, dev: false }, actions()), 'hide-to-tray')?.enabled).toBe(false)
  })

  it('offers Recargar only in development', () => {
    const roles = (dev: boolean): unknown[] => items(appMenuTemplate({ trayAvailable: true, dev }, actions())[2]!).map((item) => item.role)
    expect(roles(true)).toContain('reload')
    expect(roles(false)).not.toContain('reload')
    expect(roles(false)).toContain('toggleDevTools')
  })

  it('has no accelerator twice', () => {
    const accelerators = appMenuTemplate({ trayAvailable: true, dev: true }, actions())
      .flatMap(items)
      .map((item) => item.accelerator)
      .filter(Boolean)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })
})

describe('hiding in the tray', () => {
  it('hides the main window, closes another one, and does nothing without a tray', () => {
    expect(hideAction({ trayAvailable: true, focusedIsMain: true, hasFocused: true })).toBe('hide-main')
    // The shortcut can arrive without a focused window (e.g. from the menu bar of a window losing focus).
    expect(hideAction({ trayAvailable: true, focusedIsMain: false, hasFocused: false })).toBe('hide-main')
    expect(hideAction({ trayAvailable: true, focusedIsMain: false, hasFocused: true })).toBe('close-focused')
    expect(hideAction({ trayAvailable: false, focusedIsMain: true, hasFocused: true })).toBe('none')
  })
})
