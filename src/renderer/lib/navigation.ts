/** Views of the side rail, in order (settings stays last). */
export const VIEWS = ['library', 'map', 'trash', 'settings'] as const
export type View = (typeof VIEWS)[number]

export const MAP_TABS = ['graph', 'charts', 'candidates'] as const
export type MapTab = (typeof MAP_TABS)[number]
