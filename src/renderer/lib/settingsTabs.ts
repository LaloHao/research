/** Settings tabs, in display order. */
export const SETTINGS_TABS = ['project', 'claude', 'thesis', 'form', 'app'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/**
 * Where keyboard navigation moves the active tab to from `current` for a given key (as in `KeyboardEvent.key`):
 * Left/Right wrap around the ends, Home/End jump to the first/last tab. Any other key is a no-op.
 */
export function nextTab(current: SettingsTab, key: string): SettingsTab {
  const index = SETTINGS_TABS.indexOf(current)
  const last = SETTINGS_TABS.length - 1
  switch (key) {
    case 'ArrowLeft':
      return SETTINGS_TABS[index === 0 ? last : index - 1]
    case 'ArrowRight':
      return SETTINGS_TABS[index === last ? 0 : index + 1]
    case 'Home':
      return SETTINGS_TABS[0]
    case 'End':
      return SETTINGS_TABS[last]
    default:
      return current
  }
}
