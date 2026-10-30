import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutostartStatus } from '../../shared/desktop'
import { atomicWrite } from '../project/atomicWrite'

/** How the running app was launched, as Electron reports it. */
export interface LaunchInfo {
  platform: NodeJS.Platform
  /** `app.isPackaged`: false under `pnpm dev` (and `electron .`). */
  isPackaged: boolean
  /** `process.execPath`: the packaged executable, or the development Electron binary. */
  execPath: string
  /** `app.getAppPath()`: in development, the repository. */
  appPath: string
  /** `$APPIMAGE` when running from an AppImage: execPath then points inside its temporary mount. */
  appImage?: string
  /** `$XDG_CONFIG_HOME` (falls back to `~/.config`). */
  configHome?: string
  home: string
}

export const AUTOSTART_FILE_NAME = 'research.desktop'

export function autostartFile(info: LaunchInfo): string | null {
  if (info.platform !== 'linux') return null
  return join(info.configHome || join(info.home, '.config'), 'autostart', AUTOSTART_FILE_NAME)
}

/**
 * One Exec argument as the Desktop Entry spec asks: double-quoted when needed (`"`, `` ` ``, `$` and `\` escaped), then
 * the string-level escape of `\` (so a literal backslash ends up as four), and `%` doubled (it starts field codes).
 */
export function execArg(arg: string): string {
  const quoted = /^[\w@+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

/** One argument of a shell command line (for the user to copy). */
export function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * What the entry launches. A packaged build launches its own executable (the AppImage when there is one). In
 * development there is nothing stable: the entry is never written; the user gets the command that runs the last
 * `pnpm build` with the repository's Electron, to add by hand if they want.
 */
export function launchCommand(info: LaunchInfo): { kind: 'packaged'; exec: string } | { kind: 'dev'; command: string } {
  if (info.isPackaged) return { kind: 'packaged', exec: execArg(info.appImage || info.execPath) }
  return { kind: 'dev', command: `${shellArg(info.execPath)} ${shellArg(info.appPath)}` }
}

/** The XDG autostart entry for a packaged build's `exec`. */
export function autostartEntry(exec: string, icon: string | null): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=research',
    'Comment=Paper library and thesis research',
    `Exec=${exec}`,
    ...(icon ? [`Icon=${icon}`] : []),
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ]
  return `${lines.join('\n')}\n`
}

export function autostartStatus(info: LaunchInfo): AutostartStatus {
  const file = autostartFile(info)
  const launch = launchCommand(info)
  return {
    supported: file !== null,
    packaged: launch.kind === 'packaged',
    enabled: file !== null && existsSync(file),
    file,
    devCommand: launch.kind === 'dev' ? launch.command : null
  }
}

/**
 * «Iniciar con la sesión»: writes or removes the entry. Turning it on is refused where it could not work (not Linux,
 * or a development run); turning it off always removes the file.
 */
export async function setAutostart(info: LaunchInfo, enabled: boolean, icon: string | null): Promise<AutostartStatus> {
  const file = autostartFile(info)
  if (!file) throw new Error('Autostart is only supported on Linux')
  if (!enabled) {
    await rm(file, { force: true })
    return autostartStatus(info)
  }
  const launch = launchCommand(info)
  if (launch.kind !== 'packaged') throw new Error('Autostart needs a packaged build')
  // An icon inside the app's archive cannot be read by the desktop.
  await atomicWrite(file, autostartEntry(launch.exec, icon && !icon.includes('.asar') ? icon : null))
  return autostartStatus(info)
}
