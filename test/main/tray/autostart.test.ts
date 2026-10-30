import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autostartEntry, autostartFile, autostartStatus, entryIcon, execArg, launchCommand, setAutostart, shellArg, type LaunchInfo } from '../../../src/main/tray/autostart'
import { tmpDir } from '../../helpers/tmp'

const info = (over: Partial<LaunchInfo> = {}): LaunchInfo => ({
  platform: 'linux',
  isPackaged: true,
  execPath: '/opt/research/research',
  appPath: '/opt/research/resources/app.asar',
  home: '/home/me',
  ...over
})

describe('autostart entry', () => {
  it('lives in the XDG config folder', () => {
    expect(autostartFile(info())).toBe('/home/me/.config/autostart/research.desktop')
    expect(autostartFile(info({ configHome: '/cfg' }))).toBe('/cfg/autostart/research.desktop')
    expect(autostartFile(info({ platform: 'darwin' }))).toBeNull()
  })

  it('launches the packaged executable, or the AppImage it runs from', () => {
    expect(launchCommand(info())).toEqual({ kind: 'packaged', exec: '/opt/research/research' })
    expect(launchCommand(info({ appImage: '/home/me/Apps/research.AppImage' }))).toEqual({ kind: 'packaged', exec: '/home/me/Apps/research.AppImage' })
  })

  it('offers a command line (never an entry) in development', () => {
    const dev = info({ isPackaged: false, execPath: '/home/me/research/node_modules/electron/dist/electron', appPath: "/home/me/my research" })
    expect(launchCommand(dev)).toEqual({ kind: 'dev', command: "/home/me/research/node_modules/electron/dist/electron '/home/me/my research'" })
    expect(launchCommand({ ...dev, devElectron: '/r/node_modules/electron/dist/electron' })).toMatchObject({ command: "/r/node_modules/electron/dist/electron '/home/me/my research'" })
    expect(shellArg("it's")).toBe(`'it'\\''s'`)
  })

  it('quotes Exec arguments as the Desktop Entry spec asks', () => {
    expect(execArg('/opt/research/research')).toBe('/opt/research/research')
    expect(execArg('/home/me/My Apps/research')).toBe('"/home/me/My Apps/research"')
    expect(execArg('/x/$HOME "q"')).toBe('"/x/\\\\$HOME \\\\"q\\\\""')
    expect(execArg('/x/100%')).toBe('"/x/100%%"')
  })

  it('writes a plain application entry', () => {
    expect(autostartEntry('/opt/research/research', '/opt/research/icon.png')).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=research',
        'Comment=Paper library and thesis research',
        'Exec=/opt/research/research',
        'Icon=/opt/research/icon.png',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        ''
      ].join('\n')
    )
    expect(autostartEntry('/opt/r', null)).not.toContain('Icon=')
  })

  it('writes and removes the file of a packaged build', async () => {
    const launch = info({ configHome: await tmpDir() })
    const file = join(launch.configHome!, 'autostart', 'research.desktop')
    expect(autostartStatus(launch)).toEqual({ supported: true, packaged: true, enabled: false, file, devCommand: null })
    expect((await setAutostart(launch, true, '/opt/research/icon.png')).enabled).toBe(true)
    expect(await readFile(file, 'utf8')).toContain('Exec=/opt/research/research\nIcon=/opt/research/icon.png\n')
    expect((await setAutostart(launch, false, null)).enabled).toBe(false)
    expect(existsSync(file)).toBe(false)
    // Removing it again is fine.
    expect((await setAutostart(launch, false, null)).enabled).toBe(false)
  })

  it('leaves out an icon the desktop could not read (inside the app archive)', async () => {
    const launch = info({ configHome: await tmpDir() })
    await setAutostart(launch, true, '/opt/research/resources/app.asar/resources/icons/icon-256.png')
    expect(await readFile(join(launch.configHome!, 'autostart', 'research.desktop'), 'utf8')).not.toContain('Icon=')
  })

  it('names the theme icon when running from an AppImage (its files go away with its mount)', async () => {
    const launch = info({ configHome: await tmpDir(), appImage: '/home/me/Applications/research.AppImage', execPath: '/tmp/.mount_researXYZ/research' })
    await setAutostart(launch, true, '/tmp/.mount_researXYZ/resources/resources/icons/icon-256.png')
    expect(await readFile(join(launch.configHome!, 'autostart', 'research.desktop'), 'utf8')).toContain(
      'Exec=/home/me/Applications/research.AppImage\nIcon=research\n'
    )
    expect(entryIcon(info({ isPackaged: false, appImage: '/x.AppImage' }), '/repo/resources/icons/icon-256.png')).toBe('/repo/resources/icons/icon-256.png')
  })

  it('refuses to write an entry in development or off Linux, but still removes one', async () => {
    const dev = info({ isPackaged: false, configHome: await tmpDir() })
    await expect(setAutostart(dev, true, null)).rejects.toThrow(/packaged/)
    expect(existsSync(join(dev.configHome!, 'autostart', 'research.desktop'))).toBe(false)
    expect(autostartStatus(dev)).toMatchObject({ supported: true, packaged: false, enabled: false, devCommand: '/opt/research/research /opt/research/resources/app.asar' })
    await setAutostart({ ...dev, isPackaged: true }, true, null)
    expect((await setAutostart(dev, false, null)).enabled).toBe(false)
    await expect(setAutostart(info({ platform: 'win32' }), true, null)).rejects.toThrow(/Linux/)
  })
})
