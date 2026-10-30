import { describe, expect, it } from 'vitest'
import { FIREFOX_ID, manifest } from '../../extension/manifest'

describe('manifest', () => {
  it('asks only for activeTab, scripting and storage, with host access optional', () => {
    for (const browser of ['firefox', 'chrome'] as const) {
      const m = manifest(browser, '1.2.3')
      expect(m).toMatchObject({ manifest_version: 3, version: '1.2.3', permissions: ['activeTab', 'scripting', 'storage'] })
      expect(m).not.toHaveProperty('host_permissions')
      expect(m).not.toHaveProperty('content_scripts')
      expect(m.commands).toMatchObject({ 'add-to-research': { suggested_key: { default: 'Alt+Shift+R' } } })
    }
  })

  it('uses background scripts and a gecko id on Firefox, a service worker on Chrome', () => {
    expect(manifest('firefox', '1.0.0')).toMatchObject({ background: { scripts: ['background.js'] }, browser_specific_settings: { gecko: { id: FIREFOX_ID, data_collection_permissions: { required: ['none'] } } } })
    expect(manifest('chrome', '1.0.0')).toMatchObject({ background: { service_worker: 'background.js' } })
    expect(manifest('chrome', '1.0.0')).not.toHaveProperty('browser_specific_settings')
  })
})
