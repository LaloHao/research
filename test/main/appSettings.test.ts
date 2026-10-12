import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSettings, saveSettings } from '../../src/main/appSettings'
import { tmpDir } from '../helpers/tmp'

describe('app settings', () => {
  it('returns defaults when the file is missing or corrupt', async () => {
    const dir = await tmpDir()
    expect(await loadSettings(join(dir, 'missing.json'))).toMatchObject({ contactEmail: '', lastProjectPath: null })
    await writeFile(join(dir, 'bad.json'), '{oops')
    expect(await loadSettings(join(dir, 'bad.json'))).toMatchObject({ contactEmail: '', lastProjectPath: null })
    for (const json of ['null', '42', '"text"', '[1, 2]']) {
      await writeFile(join(dir, 'odd.json'), json)
      expect(await loadSettings(join(dir, 'odd.json'))).toMatchObject({ contactEmail: '', lastProjectPath: null })
    }
  })

  it('round-trips and drops fields of the wrong type', async () => {
    const file = join(await tmpDir(), 'settings.json')
    await saveSettings(file, {
      contactEmail: 'me@uni.test',
      openalexApiKey: '',
      lastProjectPath: '/tmp/thesis',
      deviceId: 'd0d0d0d0-0000-0000-0000-000000000000',
      autoSync: true,
      autoSyncMinutes: 10
    })
    expect(await loadSettings(file)).toMatchObject({ contactEmail: 'me@uni.test', lastProjectPath: '/tmp/thesis' })
    await writeFile(file, JSON.stringify({ contactEmail: 42, lastProjectPath: '/x', extra: true }))
    expect(await loadSettings(file)).toMatchObject({ contactEmail: '', lastProjectPath: '/x' })
    await writeFile(file, JSON.stringify({ contactEmail: 'me@uni.test', lastProjectPath: 7 }))
    expect(await loadSettings(file)).toMatchObject({ contactEmail: 'me@uni.test', lastProjectPath: null })
  })

  it('generates a device id once and keeps it', async () => {
    const file = join(await tmpDir(), 'settings.json')
    const first = await loadSettings(file)
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/)
    await saveSettings(file, first)
    expect((await loadSettings(file)).deviceId).toBe(first.deviceId)
  })

  it('keeps the OpenAlex API key and defaults it to empty', async () => {
    const file = join(await tmpDir(), 'settings.json')
    expect((await loadSettings(file)).openalexApiKey).toBe('')
    await writeFile(file, JSON.stringify({ openalexApiKey: 'k-123' }))
    expect((await loadSettings(file)).openalexApiKey).toBe('k-123')
    await writeFile(file, JSON.stringify({ openalexApiKey: 7 }))
    expect((await loadSettings(file)).openalexApiKey).toBe('')
  })

  it('keeps the automatic sync settings and falls back to the defaults on invalid ones', async () => {
    const file = join(await tmpDir(), 'settings.json')
    expect(await loadSettings(file)).toMatchObject({ autoSync: true, autoSyncMinutes: 10 })
    await writeFile(file, JSON.stringify({ autoSync: false, autoSyncMinutes: 30 }))
    expect(await loadSettings(file)).toMatchObject({ autoSync: false, autoSyncMinutes: 30 })
    for (const bad of [{ autoSync: 'no', autoSyncMinutes: 4 }, { autoSyncMinutes: 121 }, { autoSyncMinutes: 7.5 }, { autoSyncMinutes: '10' }]) {
      await writeFile(file, JSON.stringify(bad))
      expect(await loadSettings(file)).toMatchObject({ autoSync: true, autoSyncMinutes: 10 })
    }
  })
})
