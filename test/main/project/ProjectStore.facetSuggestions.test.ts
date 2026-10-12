import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ConflictError } from '../../../src/main/project/errors'
import { FACET_SUGGESTIONS_FILE } from '../../../src/main/project/facetSuggestionsFile'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { aliasSuggestion, newFacetSuggestion, newValueSuggestion } from '../../helpers/facets'
import { tmpDir } from '../../helpers/tmp'

describe('ProjectStore facet suggestions', () => {
  it('reads null before the file exists, then writes it sorted by id and reads it back', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    expect(await store.readFacetSuggestions()).toBeNull()
    const hash = await store.writeFacetSuggestions({ schema_version: 1, suggestions: [newValueSuggestion(), newFacetSuggestion(), aliasSuggestion()] }, null)
    const raw = parse(await readFile(join(store.root, FACET_SUGGESTIONS_FILE), 'utf8')) as { suggestions: { id: string }[] }
    expect(raw.suggestions.map((s) => s.id)).toEqual(['alias__sanitization_technique__rules_regex', 'new_facet__data_source', 'new_value__data_type__metrics'])
    expect(await store.readFacetSuggestions()).toMatchObject({ ok: true, hash, value: { suggestions: [{ kind: 'alias' }, { kind: 'new_facet' }, { kind: 'new_value' }] } })
  })

  it('refuses a write over a version it did not read, and reports conflict markers', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writeFacetSuggestions({ schema_version: 1, suggestions: [] }, null)
    await expect(store.writeFacetSuggestions({ schema_version: 1, suggestions: [] }, null)).rejects.toBeInstanceOf(ConflictError)
    await writeFile(join(store.root, FACET_SUGGESTIONS_FILE), 'schema_version: 1\n<<<<<<< HEAD\nsuggestions: []\n=======\nsuggestions: []\n>>>>>>> other\n')
    expect(await store.readFacetSuggestions()).toMatchObject({ ok: false, problem: { kind: 'conflict_markers' } })
  })

  it('never writes over a file with conflict markers, even with its hash', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await writeFile(join(store.root, FACET_SUGGESTIONS_FILE), 'schema_version: 1\n<<<<<<< HEAD\nsuggestions: []\n=======\nsuggestions: []\n>>>>>>> other\n')
    const read = await store.readFacetSuggestions()
    await expect(store.writeFacetSuggestions({ schema_version: 1, suggestions: [] }, read?.hash ?? null)).rejects.toBeInstanceOf(ConflictError)
  })

  it('holds the write while the sync has the folder', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const sync = store.exclusive(() => held)
    let wrote = false
    const write = store.writeFacetSuggestions({ schema_version: 1, suggestions: [] }, null).then(() => (wrote = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(wrote).toBe(false)
    release()
    await sync
    await write
    expect(wrote).toBe(true)
  })
})
