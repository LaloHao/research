import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionCapture, type CaptureLibrary, type ReaderPrinter } from '../../../../src/main/api/extension/capture'
import { ExtensionPairing } from '../../../../src/main/api/extension/pairing'
import { EXTENSION_LIMITS } from '../../../../src/main/api/extension/payload'
import { extensionRoutes } from '../../../../src/main/api/extension/routes'
import { startLocalApiServer, type LocalApiServerHandle } from '../../../../src/main/api/LocalApiServer'
import type { CaptureInput, IngestOutcome } from '../../../../src/main/library/LibraryService'
import { UserFacingError } from '../../../../src/main/library/UserFacingError'
import type { JobRecord } from '../../../../src/shared/jobs'
import { tmpDir } from '../../../helpers/tmp'

const FIREFOX = 'moz-extension://0b5c4a8e-6a43-4d7e-9d0f-6f1b0c6f2a11'
const CHROME = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const API_TOKEN = 'api-token-0123456789abcdef0123456789abcdef'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const ARTICLE = `<!DOCTYPE html><html><head><title>A long read</title></head><body><article><h1>A long read</h1>${'<p>Plenty of text about the subject, long enough for Readability to keep it as the article.</p>'.repeat(8)}<img src="https://cdn.example.org/fig1.png"><img src="https://cdn.example.org/missing.png"></article></body></html>`

interface Fake {
  papers: Map<string, { title: string; doi?: string; url?: string }>
  ingested: CaptureInput[]
  pdfs: { name: string; url: string }[]
  replaced: { key: string; pdf: Uint8Array }[]
  jobs: string[]
  opened: string[]
  printed: { html: string; url: string; fig1: Uint8Array | null; missing: Uint8Array | null }[]
  jobResult: JobRecord | null
}

function fakeLibrary(fake: Fake): CaptureLibrary {
  const outcome = (key: string): IngestOutcome => {
    fake.papers.set(key, { title: 'New paper' })
    return { status: 'added', paperId: key }
  }
  return {
    dedupeEntries: () => [...fake.papers].map(([id, p]) => ({ id, doi: p.doi ?? null, arxiv: null, title: p.title })),
    title: (key) => fake.papers.get(key)?.title ?? null,
    findByUrl: async (url) => [...fake.papers].find(([, p]) => p.url === url)?.[0] ?? null,
    enqueueIdentifier: (input) => fake.jobs.push(input),
    whenDone: async () => fake.jobResult,
    ingestCapture: async (capture) => {
      fake.ingested.push(capture)
      return outcome('page2026')
    },
    ingestPdf: async (_bytes, name, url) => {
      fake.pdfs.push({ name, url })
      return outcome('pdf2026')
    },
    replacePdf: async (key, pdf) => void fake.replaced.push({ key, pdf }),
    open: (key) => void fake.opened.push(key)
  }
}

const servers: LocalApiServerHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(opts: { project?: boolean; answer?: boolean } = {}) {
  const fake: Fake = {
    papers: new Map([['smith2020deep', { title: 'Deep things', doi: '10.1234/deep', url: 'https://blog.example.org/known' }]]),
    ingested: [],
    pdfs: [],
    replaced: [],
    jobs: [],
    opened: [],
    printed: [],
    jobResult: null
  }
  const pairing: ExtensionPairing = new ExtensionPairing({
    file: join(await tmpDir(), 'extensions.json'),
    ask: (req) => queueMicrotask(() => pairing.answer(req.id, opts.answer ?? true))
  })
  await pairing.load()
  const printReader: ReaderPrinter = async (html, url, fetchImage) => {
    fake.printed.push({ html, url, fig1: await fetchImage('https://cdn.example.org/fig1.png#x', 1e7), missing: await fetchImage('https://cdn.example.org/missing.png', 1e7) })
    return new Uint8Array(PDF)
  }
  const capture = new ExtensionCapture({ library: () => (opts.project === false ? null : fakeLibrary(fake)), printReader })
  const server = await startLocalApiServer({
    port: 0,
    token: () => API_TOKEN,
    context: () => null,
    allowCostly: () => false,
    extension: extensionRoutes({ pairing, capture, projectName: () => 'Thesis', version: '9.9.9' })
  })
  servers.push(server)
  return { server, pairing, fake }
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  json: Record<string, unknown> | null
}

function send(port: number, path: string, opts: { method?: string; origin?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.origin) headers.origin = opts.origin
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body)
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        let json: Record<string, unknown> | null = null
        try {
          json = data ? (JSON.parse(data) as Record<string, unknown>) : null
        } catch {
          json = null
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function paired(origin = FIREFOX) {
  const ctx = await serve()
  const { code } = ctx.pairing.start()
  const res = await send(ctx.server.port, '/ext/v1/pair', { origin, body: { code } })
  expect(res.status).toBe(200)
  const token = res.json!.token as string
  const call = (name: string, body: unknown, extra: { origin?: string; token?: string } = {}) =>
    send(ctx.server.port, `/ext/v1/${name}`, { origin: extra.origin ?? origin, token: extra.token ?? token, body })
  const settle = async (task: string) => {
    for (let i = 0; i < 50; i++) {
      const res = await call('capture_status', { task })
      if (res.json?.state !== 'running') return res.json!
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('task did not finish')
  }
  return { ...ctx, token, call, settle }
}

const b64 = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64')

describe('extension pairing over HTTP', () => {
  it('pairs from an extension origin with the code, answering CORS for it', async () => {
    const { server, pairing } = await serve()
    const pre = await send(server.port, '/ext/v1/pair', { method: 'OPTIONS', origin: CHROME, headers: { 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe(CHROME)
    expect(pre.headers['access-control-allow-headers']).toContain('authorization')
    const res = await send(server.port, '/ext/v1/pair', { origin: CHROME, body: { code: pairing.start().code } })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(CHROME)
    expect(res.json).toEqual({ token: expect.any(String), browser: 'chrome' })
  })

  it('refuses a wrong code, a web page origin and a rejected request', async () => {
    const { server, pairing } = await serve({ answer: false })
    const { code } = pairing.start()
    expect((await send(server.port, '/ext/v1/pair', { origin: FIREFOX, body: { code: 'WRONG123' } })).json).toEqual({ error: 'invalid_code' })
    const page = await send(server.port, '/ext/v1/pair', { origin: 'https://evil.example', body: { code } })
    expect(page.status).toBe(403)
    expect(page.headers['access-control-allow-origin']).toBeUndefined()
    const pre = await send(server.port, '/ext/v1/pair', { method: 'OPTIONS', origin: 'https://evil.example' })
    expect(pre.status).toBe(403)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    expect((await send(server.port, '/ext/v1/pair', { origin: FIREFOX, body: { code } })).json).toEqual({ error: 'rejected' })
  })
})

describe('extension CORS and tokens', () => {
  it('answers preflights only for paired origins and only on the extension endpoints', async () => {
    const { server } = await paired(FIREFOX)
    const ask = (path: string, origin: string) => send(server.port, path, { method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })
    const ok = await ask('/ext/v1/capture_page', FIREFOX)
    expect(ok.status).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe(FIREFOX)
    expect(ok.headers['access-control-allow-methods']).toBe('POST')
    for (const res of [await ask('/ext/v1/capture_page', CHROME), await ask('/ext/v1/nonexistent', FIREFOX), await ask('/mcp', FIREFOX)]) {
      expect(res.status).toBe(403)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('keeps refusing extension origins on the MCP endpoint, even with the API token', async () => {
    const { server } = await paired(FIREFOX)
    const res = await send(server.port, '/mcp', { origin: FIREFOX, token: API_TOKEN, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(res.status).toBe(403)
  })

  it('needs the extension token from its own origin; the API token does not work there', async () => {
    const { call, token } = await paired(FIREFOX)
    expect((await call('ping', {})).json).toEqual({ ok: true, version: '9.9.9', project: 'Thesis' })
    expect((await call('ping', {}, { token: API_TOKEN })).status).toBe(401)
    expect((await call('ping', {}, { token: 'x'.repeat(43) })).json).toEqual({ error: 'not_paired' })
    // The token from another origin, or from no extension at all.
    expect((await call('ping', {}, { origin: CHROME, token })).status).toBe(401)
    expect((await call('ping', {}, { origin: 'https://evil.example', token })).status).toBe(403)
  })

  it('stops a revoked extension at once', async () => {
    const { call, pairing } = await paired(FIREFOX)
    await pairing.revoke(pairing.list()[0]!.id)
    const res = await call('ping', {})
    expect(res.status).toBe(401)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers an opaque GET ping (the app is there) without CORS', async () => {
    const { server } = await serve()
    const res = await send(server.port, '/ext/v1/ping', { method: 'GET', origin: FIREFOX })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('refuses a foreign Host (DNS rebinding) before anything else', async () => {
    const { server } = await serve()
    const res = await send(server.port, '/ext/v1/pair', { origin: FIREFOX, body: { code: 'X' }, headers: { host: 'evil.example' } })
    expect(res.status).toBe(403)
  })
})

describe('capture payload validation', () => {
  it('refuses unknown fields, non-web URLs and non-JSON', async () => {
    const { call, server, token } = await paired()
    expect((await call('capture_page', { url: 'file:///etc/passwd', html: '' })).status).toBe(400)
    expect((await call('capture_page', { url: 'https://a.example/', html: '', extra: 1 })).status).toBe(400)
    expect((await call('capture_lookup', {})).json).toMatchObject({ error: 'invalid' })
    const text = await send(server.port, '/ext/v1/ping', { origin: FIREFOX, token, headers: { 'content-type': 'text/plain' } })
    expect(text.status).toBe(415)
  })

  it('refuses images that are too many, too big, or not what they claim', async () => {
    const { call, fake } = await paired()
    const page = { url: 'https://blog.example.org/new', html: ARTICLE }
    const image = { url: 'https://cdn.example.org/fig1.png', data: b64(PNG), type: 'png' }
    const many = Array.from({ length: EXTENSION_LIMITS.images + 1 }, () => image)
    expect((await call('capture_page', { ...page, images: many })).status).toBe(413)
    const big = Buffer.concat([PNG, Buffer.alloc(EXTENSION_LIMITS.imageBytes)])
    expect((await call('capture_page', { ...page, images: [{ ...image, data: b64(big) }] })).status).toBe(413)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect((await call('capture_page', { ...page, images: [{ ...image, data: b64(svg) }] })).json).toMatchObject({ error: 'invalid' })
    expect((await call('capture_page', { ...page, images: [{ ...image, type: 'jpeg' }] })).json).toMatchObject({ error: 'invalid' })
    expect((await call('capture_page', { ...page, images: [{ ...image, data: '***' }] })).status).toBe(400)
    expect((await call('capture_page', { ...page, images: [{ ...image, type: 'svg' }] })).status).toBe(400)
    expect(fake.ingested).toEqual([])
  })

  it('refuses a PDF that is not one, and an HTML page past its limit', async () => {
    const { call, fake } = await paired()
    expect((await call('capture_page', { url: 'https://a.example/x.pdf', html: '', pdf: b64(Buffer.from('<html>not a pdf</html>')) })).json).toMatchObject({ error: 'not_a_pdf' })
    expect((await call('capture_page', { url: 'https://a.example/', html: 'x'.repeat(EXTENSION_LIMITS.html + 1) })).status).toBe(413)
    expect(fake.ingested).toEqual([])
  })

  it('says no project is open', async () => {
    const ctx = await serve({ project: false })
    const { code } = ctx.pairing.start()
    const { token } = (await send(ctx.server.port, '/ext/v1/pair', { origin: FIREFOX, body: { code } })).json as { token: string }
    const res = await send(ctx.server.port, '/ext/v1/capture_lookup', { origin: FIREFOX, token, body: { url: 'https://a.example/' } })
    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'no_project' })
  })
})

describe('capture routing', () => {
  it('takes the identifier path for a page with a DOI in its meta, with the PDF it brought and no reader print', async () => {
    const { call, settle, fake } = await paired()
    const res = await call('capture_page', { url: 'https://journal.example.org/article/7', html: '<html><body>landing</body></html>', meta: { citation_doi: ['https://doi.org/10.5555/ABC.7'] }, pdf: b64(PDF) })
    expect(res.json).toEqual({ task: expect.any(String), existing: null })
    expect(await settle(res.json!.task as string)).toMatchObject({ state: 'done', key: 'page2026', outcome: 'added', title: 'New paper' })
    expect(fake.ingested).toHaveLength(1)
    expect(fake.ingested[0]).toMatchObject({ url: 'https://journal.example.org/article/7', ids: { doi: '10.5555/abc.7' } })
    expect(Buffer.from(fake.ingested[0]!.pdf!)).toEqual(PDF)
    expect(fake.printed).toEqual([])
  })

  it('prints the reader PDF of a web article with the images the extension sent, never fetching any', async () => {
    const { call, settle, fake } = await paired()
    const res = await call('capture_page', {
      url: 'https://blog.example.org/new?utm_source=x',
      final_url: 'https://blog.example.org/new',
      title: 'A long read',
      html: ARTICLE,
      images: [{ url: 'https://cdn.example.org/fig1.png', data: b64(PNG), type: 'png' }]
    })
    await settle(res.json!.task as string)
    expect(fake.printed).toHaveLength(1)
    expect(fake.printed[0]!.url).toBe('https://blog.example.org/new')
    expect(Buffer.from(fake.printed[0]!.fig1!)).toEqual(PNG)
    expect(fake.printed[0]!.missing).toBeNull()
    expect(fake.ingested[0]).toMatchObject({ url: 'https://blog.example.org/new', html: ARTICLE })
    expect(fake.ingested[0]!.ids).toBeUndefined()
    expect(Buffer.from(fake.ingested[0]!.pdf!)).toEqual(PDF)
  })

  it('ingests a PDF tab as a PDF, and an arXiv PDF by its id', async () => {
    const { call, settle, fake } = await paired()
    const tab = await call('capture_page', { url: 'https://files.example.org/papers/Some%20Paper', html: '', pdf: b64(PDF) })
    expect(await settle(tab.json!.task as string)).toMatchObject({ state: 'done', key: 'pdf2026' })
    expect(fake.pdfs).toEqual([{ name: 'Some Paper.pdf', url: 'https://files.example.org/papers/Some%20Paper' }])
    const arxiv = await call('capture_page', { url: 'https://arxiv.org/pdf/2401.01234v2', html: '', pdf: b64(PDF) })
    await settle(arxiv.json!.task as string)
    expect(fake.ingested[0]).toMatchObject({ ids: { arxiv: '2401.01234' } })
  })

  it('answers a page already in the library instead of adding it again', async () => {
    const { call, fake } = await paired()
    const byUrl = await call('capture_page', { url: 'https://blog.example.org/known', html: ARTICLE })
    expect(byUrl.json).toEqual({ task: null, existing: { key: 'smith2020deep', title: 'Deep things' } })
    const byDoi = await call('capture_page', { url: 'https://other.example/x', html: '', meta: { 'dc.identifier': 'doi:10.1234/DEEP' } })
    expect(byDoi.json).toMatchObject({ existing: { key: 'smith2020deep' } })
    expect(fake.ingested).toEqual([])
  })

  it('keeps a task running while its job is, and knows no other task', async () => {
    const { call } = await paired()
    const res = await call('capture_identifier', { identifier: '10.9999/slow' })
    expect((await call('capture_status', { task: res.json!.task })).json).toMatchObject({ state: 'running', job: 1 })
    expect((await call('capture_status', { task: 'unknown' })).status).toBe(404)
  })
})

describe('capture_identifier', () => {
  it('queues the «Agregar» job and says when the paper is already there', async () => {
    const { call, fake } = await paired()
    fake.jobResult = { id: 1, spec: { type: 'ingest_identifier', input: 'x' }, state: 'done', message: 'merged', progress: null, paperId: 'smith2020deep', createdAt: '', updatedAt: '' }
    const res = await call('capture_identifier', { identifier: 'https://doi.org/10.1234/deep', page_url: 'https://journal.example.org/x' })
    expect(fake.jobs).toEqual(['https://doi.org/10.1234/deep'])
    expect(res.json).toEqual({ task: expect.any(String), job: 1, existing: { key: 'smith2020deep', title: 'Deep things' } })
    await new Promise((r) => setTimeout(r, 5))
    expect((await call('capture_status', { task: res.json!.task })).json).toEqual({ state: 'done', key: 'smith2020deep', title: 'Deep things', outcome: 'merged', error: null, job: 1 })
  })

  it('reports a failed job by its error code, and refuses what is not an identifier', async () => {
    const { call, fake } = await paired()
    fake.jobResult = { id: 1, spec: { type: 'ingest_identifier', input: 'x' }, state: 'failed', message: 'site_blocked: HTTP 403', progress: null, paperId: null, createdAt: '', updatedAt: '' }
    const res = await call('capture_identifier', { identifier: '10.1111/x' })
    await new Promise((r) => setTimeout(r, 5))
    expect((await call('capture_status', { task: res.json!.task })).json).toMatchObject({ state: 'failed', error: 'site_blocked' })
    expect((await call('capture_identifier', { identifier: 'not an id' })).json).toEqual({ error: 'invalid' })
  })
})

describe('capture_lookup', () => {
  it('finds a paper by DOI, arXiv or URL', async () => {
    const { call } = await paired()
    expect((await call('capture_lookup', { url: 'https://x.example/', doi: '10.1234/Deep' })).json).toEqual({ existing: { key: 'smith2020deep', title: 'Deep things' } })
    expect((await call('capture_lookup', { url: 'https://x.example/', final_url: 'https://blog.example.org/known' })).json).toMatchObject({ existing: { key: 'smith2020deep' } })
    expect((await call('capture_lookup', { url: 'https://x.example/' })).json).toEqual({ existing: null })
  })
})

describe('capture_update_pdf', () => {
  it('replaces the PDF of the paper this page is, from the PDF sent or the reader print', async () => {
    const { call, settle, fake } = await paired()
    const sent = await call('capture_update_pdf', { key: 'smith2020deep', url: 'https://blog.example.org/known', html: '', pdf: b64(PDF) })
    expect(await settle(sent.json!.task as string)).toMatchObject({ state: 'done', key: 'smith2020deep', outcome: 'pdf_updated' })
    const printed = await call('capture_update_pdf', { key: 'smith2020deep', url: 'https://blog.example.org/known', html: ARTICLE })
    await settle(printed.json!.task as string)
    expect(fake.replaced.map((r) => r.key)).toEqual(['smith2020deep', 'smith2020deep'])
    expect(fake.printed).toHaveLength(1)
  })

  it('refuses another paper than the page, an unknown key, and a page without a PDF', async () => {
    const { call, settle, fake } = await paired()
    fake.papers.set('other2021', { title: 'Other' })
    expect((await call('capture_update_pdf', { key: 'other2021', url: 'https://blog.example.org/known', html: '', pdf: b64(PDF) })).json).toEqual({ error: 'mismatch' })
    expect((await call('capture_update_pdf', { key: 'nobody', url: 'https://blog.example.org/known', html: '', pdf: b64(PDF) })).status).toBe(404)
    const empty = await call('capture_update_pdf', { key: 'smith2020deep', url: 'https://blog.example.org/known', html: '' })
    expect(await settle(empty.json!.task as string)).toMatchObject({ state: 'failed', error: 'capture_no_pdf' })
    expect(fake.replaced).toEqual([])
  })
})

describe('open_in_app', () => {
  it('shows a library paper in the window; an unknown key is not found', async () => {
    const { call, fake } = await paired()
    expect((await call('open_in_app', { key: 'smith2020deep' })).json).toEqual({ ok: true })
    expect(fake.opened).toEqual(['smith2020deep'])
    expect((await call('open_in_app', { key: 'nobody' })).status).toBe(404)
  })
})

describe('UserFacingError from a capture', () => {
  it('fails the task with the code', async () => {
    const ctx = await paired()
    const lib = fakeLibrary(ctx.fake)
    lib.ingestCapture = async () => {
      throw new UserFacingError('unreadable_page')
    }
    const capture = new ExtensionCapture({ library: () => lib, printReader: async () => null })
    const { task } = await capture.page({ url: 'https://n.example/', title: '', html: '<p>x</p>', meta: {}, images: [], pdf: null }, 'https://n.example/')
    await new Promise((r) => setTimeout(r, 5))
    expect(capture.status(task!)).toMatchObject({ state: 'failed', error: 'unreadable_page' })
  })
})
