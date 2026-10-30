import { describe, expect, it } from 'vitest'
import { closeAction, startHidden } from '../../../src/main/tray/closeBehavior'

describe('closing the window', () => {
  it('hides to the tray when the setting is on and the tray is there', () => {
    expect(closeAction({ closeToTray: true, trayAvailable: true, quitting: false })).toBe('hide')
  })

  it('quits when the setting is off', () => {
    expect(closeAction({ closeToTray: false, trayAvailable: true, quitting: false })).toBe('close')
  })

  it('falls back to quitting without a tray, so the app is never left invisible', () => {
    expect(closeAction({ closeToTray: true, trayAvailable: false, quitting: false })).toBe('close')
  })

  it('joins a quit under way instead of hiding', () => {
    expect(closeAction({ closeToTray: true, trayAvailable: true, quitting: true })).toBe('close')
  })
})

describe('starting hidden', () => {
  it('stays hidden with --hidden, only with a tray', () => {
    expect(startHidden({ argv: ['electron', '.', '--hidden'], trayAvailable: true })).toBe(true)
    expect(startHidden({ argv: ['electron', '.', '--hidden'], trayAvailable: false })).toBe(false)
  })

  it('shows the window on a launch without --hidden (the setting only reaches the autostart entry)', () => {
    expect(startHidden({ argv: ['/home/me/Applications/research.AppImage'], trayAvailable: true })).toBe(false)
  })
})
