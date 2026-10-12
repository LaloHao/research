import type { z } from 'zod'
import {
  DecisionsFileSchema,
  ProtocolFileSchema,
  RecordsFileSchema,
  SearchesFileSchema,
  SuggestionsFileSchema,
  type DecisionsFile,
  type ProtocolFile,
  type RecordsFile,
  type SearchesFile,
  type SuggestionsFile
} from '../../shared/mapping'

export const MAPPINGS_DIR = 'mappings'
export const MAPPING_FILE_KINDS = ['protocol', 'searches', 'records', 'decisions', 'suggestions'] as const
export type MappingFileKind = (typeof MAPPING_FILE_KINDS)[number]

export interface MappingFiles {
  protocol: ProtocolFile
  searches: SearchesFile
  records: RecordsFile
  decisions: DecisionsFile
  suggestions: SuggestionsFile
}

export const MAPPING_FILE_NAMES: Record<MappingFileKind, string> = {
  protocol: 'protocol.yaml',
  searches: 'searches.yaml',
  records: 'records.yaml',
  decisions: 'decisions.yaml',
  suggestions: 'suggestions.yaml'
}

export const MAPPING_SCHEMAS: { [K in MappingFileKind]: z.ZodType<MappingFiles[K]> } = {
  protocol: ProtocolFileSchema,
  searches: SearchesFileSchema,
  records: RecordsFileSchema,
  decisions: DecisionsFileSchema,
  suggestions: SuggestionsFileSchema
}

/** What a missing list file reads as. */
export const EMPTY_MAPPING_LISTS: Omit<MappingFiles, 'protocol'> = {
  searches: { schema_version: 1, searches: [] },
  records: { schema_version: 1, records: [] },
  decisions: { schema_version: 1, decisions: [] },
  suggestions: { schema_version: 1, suggestions: [] }
}

const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
const byAtId = (a: { at: string; id: string }, b: { at: string; id: string }): number => compare(a.at, b.at) || compare(a.id, b.id)

/** Lists in a stable order (time, then id), so the sync merges two machines' additions entry by entry. Unknown keys are kept. */
export function sortedMappingFile<K extends MappingFileKind>(kind: K, file: MappingFiles[K]): MappingFiles[K] {
  switch (kind) {
    case 'searches': {
      const f = file as SearchesFile
      return { ...f, searches: [...f.searches].sort(byAtId) } as MappingFiles[K]
    }
    case 'records': {
      const f = file as RecordsFile
      return { ...f, records: [...f.records].sort((a, b) => compare(a.added_at, b.added_at) || compare(a.id, b.id)) } as MappingFiles[K]
    }
    case 'decisions': {
      const f = file as DecisionsFile
      return { ...f, decisions: [...f.decisions].sort(byAtId) } as MappingFiles[K]
    }
    case 'suggestions': {
      const f = file as SuggestionsFile
      return { ...f, suggestions: [...f.suggestions].sort(byAtId) } as MappingFiles[K]
    }
    default: {
      const f = file as ProtocolFile
      const history = [...(f.history ?? [])].sort((a, b) => compare(a.version, b.version) || compare(a.replaced_at, b.replaced_at))
      return { ...f, history } as MappingFiles[K]
    }
  }
}

/** `<yyyymmdd>-<hhmmss>-<4 hex>`: sorts by creation, like a conversation's id. */
export function newMappingId(now: Date, randomHex: string): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomHex.slice(0, 4).toLowerCase()}`
}
