/** Views of the side rail, in order (settings stays last). */
export const VIEWS = ['library', 'map', 'mappings', 'chat', 'writing', 'trash', 'sync', 'settings'] as const
export type View = (typeof VIEWS)[number]

export const MAP_TABS = ['graph', 'charts', 'candidates'] as const
export type MapTab = (typeof MAP_TABS)[number]

export const MAPPING_TABS = ['protocol', 'searches', 'screening', 'prisma'] as const
export type MappingTab = (typeof MAPPING_TABS)[number]

/** «Redacción»'s tabs, in order. */
export const WRITING_TABS = ['draft', 'check', 'outline', 'bibtex', 'style'] as const
export type WritingTab = (typeof WRITING_TABS)[number]
