import { describe, expect, it } from 'vitest'
import { nextTab, SETTINGS_TABS } from '../../src/renderer/lib/settingsTabs'

describe('nextTab', () => {
  it('moves right and wraps at the end', () => {
    expect(nextTab('project', 'ArrowRight')).toBe('claude')
    expect(nextTab('app', 'ArrowRight')).toBe('project')
  })

  it('moves left and wraps at the start', () => {
    expect(nextTab('claude', 'ArrowLeft')).toBe('project')
    expect(nextTab('project', 'ArrowLeft')).toBe('app')
  })

  it('jumps to the first or last tab on Home/End', () => {
    expect(nextTab('thesis', 'Home')).toBe(SETTINGS_TABS[0])
    expect(nextTab('thesis', 'End')).toBe(SETTINGS_TABS[SETTINGS_TABS.length - 1])
  })

  it('ignores unrelated keys', () => {
    expect(nextTab('claude', 'Enter')).toBe('claude')
    expect(nextTab('claude', 'a')).toBe('claude')
  })
})
