import { describe, expect, it } from 'vitest'
import { trayHost } from '../../../src/main/tray/trayHost'

const fail = (code: string) => async (): Promise<string> => {
  throw Object.assign(new Error('failed'), { code })
}

describe('tray host', () => {
  it('asks the session bus for a StatusNotifierWatcher on Linux', async () => {
    const calls: string[][] = []
    const run = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args])
      return 'method return time=1 sender=org.freedesktop.DBus\n   boolean true\n'
    }
    expect(await trayHost('linux', run)).toBe('yes')
    expect(calls[0]).toContain('string:org.kde.StatusNotifierWatcher')
    expect(await trayHost('linux', async () => '   boolean false\n')).toBe('no')
  })

  it('says no when the bus is missing or does not answer, unknown without dbus-send', async () => {
    expect(await trayHost('linux', fail('1'))).toBe('no')
    expect(await trayHost('linux', fail('ENOENT'))).toBe('unknown')
    expect(await trayHost('linux', async () => 'garbled')).toBe('unknown')
  })

  it('trusts the other platforms', async () => {
    expect(await trayHost('win32', fail('1'))).toBe('yes')
    expect(await trayHost('darwin', fail('1'))).toBe('yes')
  })
})
