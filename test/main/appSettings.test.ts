import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSettings, saveSettings } from '../../src/main/appSettings'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { tmpDir } from '../helpers/tmp'

describe('app settings', () => {
  it('returns defaults when the file is missing or corrupt', async () => {
    const dir = await tmpDir()
    expect(await loadSettings(join(dir, 'missing.json'))).toEqual(DEFAULT_SETTINGS)
    await writeFile(join(dir, 'bad.json'), '{oops')
    expect(await loadSettings(join(dir, 'bad.json'))).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips and drops fields of the wrong type', async () => {
    const file = join(await tmpDir(), 'settings.json')
    await saveSettings(file, { contactEmail: 'me@uni.test', lastProjectPath: '/tmp/thesis' })
    expect(await loadSettings(file)).toEqual({ contactEmail: 'me@uni.test', lastProjectPath: '/tmp/thesis' })
    await writeFile(file, JSON.stringify({ contactEmail: 42, lastProjectPath: '/x', extra: true }))
    expect(await loadSettings(file)).toEqual({ contactEmail: '', lastProjectPath: '/x' })
  })
})
