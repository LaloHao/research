import { execFile } from 'node:child_process'

/** Runs a command and resolves its stdout; rejects when it is missing, fails or times out. */
export type RunCommand = (file: string, args: string[]) => Promise<string>

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

/**
 * Whether a desktop shows tray icons. On Linux, Electron's tray is a StatusNotifierItem: it shows only when the
 * session runs a `org.kde.StatusNotifierWatcher` (Plasma does; a bare window manager may not). `unknown` when there is
 * no dbus-send to ask with: the tray is created and trusted. Other platforms always have one.
 */
export async function trayHost(platform: NodeJS.Platform, run: RunCommand = runCommand): Promise<'yes' | 'no' | 'unknown'> {
  if (platform !== 'linux') return 'yes'
  let out: string
  try {
    out = await run('dbus-send', [
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner',
      'string:org.kde.StatusNotifierWatcher'
    ])
  } catch (error) {
    // Without dbus-send nothing can be told; a session bus that is missing or does not answer has no watcher either.
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'unknown' : 'no'
  }
  if (/boolean true/.test(out)) return 'yes'
  return /boolean false/.test(out) ? 'no' : 'unknown'
}
