import { describe, expect, it } from 'vitest'
import { loadMode, MODE_KEY, MODE_LABELS, parseMode, saveMode } from '../../extension/src/mode'

/** The extension's storage.local, in memory. */
function storage(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = { ...initial }
  return {
    items,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]])),
    set: async (values: Record<string, unknown>) => void Object.assign(items, values)
  }
}

describe('the PDF mode of a web page', () => {
  it('is the reader view unless «page» was chosen', () => {
    expect(parseMode('page')).toBe('page')
    for (const value of ['reader', undefined, null, 'PAGE', 1, {}]) expect(parseMode(value)).toBe('reader')
    expect(MODE_LABELS).toEqual({ reader: 'Vista de lectura (recomendado)', page: 'Página tal como se ve' })
  })

  it('is remembered in the extension storage, and read back (a broken storage reads as the reader view)', async () => {
    const store = storage()
    expect(await loadMode(store)).toBe('reader')
    await saveMode(store, 'page')
    expect(store.items).toEqual({ [MODE_KEY]: 'page' })
    expect(await loadMode(store)).toBe('page')
    await saveMode(store, 'reader')
    expect(await loadMode(store)).toBe('reader')
    expect(await loadMode({ get: async () => Promise.reject(new Error('storage')) })).toBe('reader')
    expect(await loadMode(storage({ [MODE_KEY]: 'something' }))).toBe('reader')
  })
})
