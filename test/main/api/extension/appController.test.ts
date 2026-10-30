import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppController } from '../../../../src/main/AppController'
import type { PairingRequest } from '../../../../src/shared/extension'
import type { ApiOpenPaper } from '../../../../src/shared/localApi'
import { makePdf } from '../../../helpers/pdf'
import { tmpDir } from '../../../helpers/tmp'

const FIREFOX = 'moz-extension://0b5c4a8e-6a43-4d7e-9d0f-6f1b0c6f2a11'
const html = readFileSync(new URL('../../../fixtures/web/postmortem.html', import.meta.url), 'utf8')

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { origin: FIREFOX, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('the browser extension through AppController', () => {
  it('pairs only while the API listens and the window accepts, then adds a page to the open project', async () => {
    const dir = await tmpDir()
    const asked: (PairingRequest | null)[] = []
    const opened: ApiOpenPaper[] = []
    const printed: string[] = []
    const pdf = await makePdf([['Postmortem of the database outage: the rollback took forty minutes.']])
    let c!: AppController
    c = new AppController(join(dir, 'settings.json'), () => undefined, { watch: false, autoSync: null }, undefined, undefined, {
      dir,
      openInApp: (r) => void opened.push(r),
      openChatInApp: () => undefined,
      showPairingRequest: (request) => {
        asked.push(request)
        if (request) queueMicrotask(() => c.answerExtensionPairing(request.id, true))
      },
      printReader: async (_html, url) => (printed.push(url), pdf),
      version: '1.2.3'
    })
    await c.init()
    expect(c.extensionStatus()).toEqual({ apiRunning: false, code: null, paired: [] })
    expect(() => c.startExtensionPairing()).toThrow()

    // Port 0: a free one (the settings normally hold a fixed port).
    await c.setSettings({ apiEnabled: true, apiPort: 0 })
    const base = c.apiStatus()!.url!.replace(/\/mcp$/, '/ext/v1')
    const { code } = c.startExtensionPairing()
    const paired = await post(`${base}/pair`, { code })
    expect(paired.status).toBe(200)
    const token = paired.json.token as string
    expect(asked).toEqual([expect.objectContaining({ browser: 'firefox', origin: FIREFOX }), null])
    expect(c.extensionStatus()?.paired).toEqual([expect.objectContaining({ origin: FIREFOX })])

    expect((await post(`${base}/ping`, {}, token)).json).toEqual({ ok: true, version: '1.2.3', project: null })
    expect((await post(`${base}/capture_lookup`, { url: 'https://x.test/' }, token)).json).toEqual({ error: 'no_project' })

    await c.createProject(await tmpDir(), 'Thesis')
    const url = 'https://eng.acme.test/posts/database-outage'
    const started = await post(`${base}/capture_page`, { url, html, title: 'Outage' }, token)
    expect(started.json).toMatchObject({ existing: null, task: expect.any(String) })
    let status: Record<string, unknown> = {}
    for (let i = 0; i < 200 && status.state !== 'done' && status.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      status = (await post(`${base}/capture_status`, { task: started.json.task }, token)).json
    }
    expect(status).toMatchObject({ state: 'done', key: 'roe2024database', outcome: 'added' })
    expect(printed).toEqual([url])
    expect(c.requireSession().store.resolvePdf('roe2024database')).not.toBeNull()
    expect((await post(`${base}/capture_lookup`, { url }, token)).json).toMatchObject({ existing: { key: 'roe2024database' } })
    await post(`${base}/open_in_app`, { key: 'roe2024database' }, token)
    expect(opened).toEqual([{ paper: 'roe2024database', page: null, quote: null }])

    await c.revokeExtension(c.extensionStatus()!.paired[0]!.id)
    expect((await post(`${base}/ping`, {}, token)).status).toBe(401)
    await c.shutdown()
  })
})
