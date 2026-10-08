import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/main/ingest/http'

describe('test setup', () => {
  it('disables the real network', async () => {
    await expect(fetch('https://example.org')).rejects.toThrow('network disabled in tests')
    await expect(new HttpClient({ retries: 0 }).text('https://api.openalex.org/works/x', '*/*')).rejects.toThrow('network disabled in tests')
  })
})
