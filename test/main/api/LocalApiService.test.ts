import { readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalApiService } from '../../../src/main/api/LocalApiService'
import { AppController } from '../../../src/main/AppController'
import { appLog, MemorySink, redact } from '../../../src/main/log/appLog'
import { tmpDir } from '../../helpers/tmp'

const services: LocalApiService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()))
})

async function service() {
  const dir = await tmpDir()
  const tokens: string[] = []
  const api = new LocalApiService({ dir, context: () => null, allowCostly: () => false, onToken: (t) => void tokens.push(t) })
  services.push(api)
  return { dir, api, tokens }
}

/** A free port: opened, read, closed. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

const post = (url: string, token: string): Promise<number> =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }).then((r) => r.status)

describe('LocalApiService', () => {
  it('is off until turned on; then writes api.json (0600) with the URL and a token it keeps across restarts', async () => {
    const { dir, api, tokens } = await service()
    const port = await freePort()
    expect(api.status()).toMatchObject({ enabled: false, running: false, url: null })
    expect(api.currentToken()).toBeNull()

    await api.apply({ enabled: true, port, allowCostly: false })
    const file = join(dir, 'api.json')
    expect(api.status()).toMatchObject({ enabled: true, running: true, port, url: `http://127.0.0.1:${port}/mcp`, file, error: null })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved).toEqual({ url: `http://127.0.0.1:${port}/mcp`, token: api.currentToken() })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(tokens).toEqual([saved.token])
    expect(await post(saved.url, saved.token)).toBe(200)

    await api.apply({ enabled: false, port, allowCostly: false })
    expect(api.status().running).toBe(false)
    await expect(post(saved.url, saved.token)).rejects.toThrow()

    // A new launch reads the same token back.
    const again = new LocalApiService({ dir, context: () => null, allowCostly: () => false, onToken: () => undefined })
    services.push(again)
    await again.apply({ enabled: true, port, allowCostly: false })
    expect(again.currentToken()).toBe(saved.token)
  })

  it('regenerates the token: the old one stops working at once', async () => {
    const { dir, api } = await service()
    await api.apply({ enabled: true, port: await freePort(), allowCostly: false })
    const old = api.currentToken()!
    const url = api.status().url!
    await api.regenerateToken()
    const fresh = api.currentToken()!
    expect(fresh).not.toBe(old)
    expect(JSON.parse(await readFile(join(dir, 'api.json'), 'utf8')).token).toBe(fresh)
    expect(await post(url, old)).toBe(401)
    expect(await post(url, fresh)).toBe(200)
  })

  it('reports a port in use, and moves when the port changes', async () => {
    const { api } = await service()
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r))
    const taken = (busy.address() as AddressInfo).port
    try {
      await api.apply({ enabled: true, port: taken, allowCostly: false })
      expect(api.status()).toMatchObject({ enabled: true, running: false, error: 'port_in_use' })
      const port = await freePort()
      await api.apply({ enabled: true, port, allowCostly: false })
      expect(api.status()).toMatchObject({ running: true, port, error: null })
    } finally {
      await new Promise<void>((r) => busy.close(() => r()))
    }
  })

  it('ignores a token in api.json that is too short to be one of its own', async () => {
    const { dir, api } = await service()
    await writeFile(join(dir, 'api.json'), JSON.stringify({ url: 'x', token: 'short' }))
    await api.apply({ enabled: true, port: await freePort(), allowCostly: false })
    expect(api.currentToken()).not.toBe('short')
    expect(api.currentToken()!.length).toBeGreaterThanOrEqual(32)
  })
})

describe('AppController and the local API', () => {
  it('follows the settings, redacts the token in the log and says no_project with no project open', async () => {
    const sink = new MemorySink()
    appLog.setSink(sink)
    const dir = await tmpDir()
    const c = new AppController(join(dir, 'settings.json'), () => undefined, { watch: false, autoSync: null }, () => undefined, () => undefined, { dir, openInApp: () => undefined })
    try {
      await c.init()
      expect(c.apiStatus()).toMatchObject({ enabled: false, running: false, allowCostly: false })
      await c.setSettings({ apiEnabled: true, apiPort: await freePort() })
      const status = c.apiStatus()!
      expect(status.running).toBe(true)
      const token = c.apiCurrentToken()!
      expect(redact(`header Bearer-less ${token} here`)).not.toContain(token)
      appLog.info('probe', { note: `token ${token}` })
      expect(sink.lines.join('\n')).not.toContain(token)

      const res = await fetch(status.url!, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_papers_for_citation', arguments: {} } })
      })
      const json = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } }
      expect(json.result.isError).toBe(true)
      expect(json.result.content[0].text).toMatch(/^no_project: /)

      await c.setSettings({ apiEnabled: false })
      expect(c.apiStatus()?.running).toBe(false)
    } finally {
      await c.shutdown()
      appLog.setSink(null)
    }
  })
})
