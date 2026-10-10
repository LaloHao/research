import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/main/ingest/http'

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('test setup', () => {
  it('disables the real network', async () => {
    await expect(fetch('https://example.org')).rejects.toThrow('network disabled in tests')
    await expect(new HttpClient({ retries: 0 }).text('https://api.openalex.org/works/x', '*/*')).rejects.toThrow('network disabled in tests')
  })

  it('lets only 127.0.0.1 through, and reaches it for real', async () => {
    await expect(fetch('http://localhost:9/')).rejects.toThrow('network disabled in tests')
    // A port just freed on 127.0.0.1 is closed: the request really went out and was refused.
    // (Not port 9: fetch blocks it as a "bad port" before connecting.)
    const port = await closedPort()
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
  })
})
