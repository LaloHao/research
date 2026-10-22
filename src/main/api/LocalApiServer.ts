import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { LlmError } from '../llm/LlmProvider'
import { defineLibraryTools, type Run, type ToolResult } from '../mcp/LibraryMcpServer'
import { ToolError, type LibraryTools } from '../mcp/libraryTools'
import { ApiError, callApiTool, noProject, toolInput, type ApiContext, type ApiTool } from './registry'
import { WRITING_API_TOOLS } from './writingTools'

export const API_SERVER_NAME = 'research'
/** Chapters with their includes can be long: bigger than the agent servers' limit, still bounded. */
const MAX_BODY_BYTES = 8_000_000
const MAX_ANSWER_CHARS = 20_000_000

/**
 * The tools beyond the library's: the free writing tools, then the costly ones (none yet). A costly tool is added here
 * with `costlyTool` (see registry.ts); the gate, the plan and the cap come with it.
 */
export const API_TOOLS: ApiTool[] = [...WRITING_API_TOOLS]

export interface LocalApiServerOptions {
  /** 0 picks a free port (tests). */
  port: number
  /** Read on every request, so a regenerated token applies at once. */
  token: () => string
  /** The open project's context; null when none is open (every tool then answers `no_project`). */
  context: () => ApiContext | null
  /** Settings' «Permitir operaciones con costo desde la API», read on every call. */
  allowCostly: () => boolean
  tools?: ApiTool[]
  /** One line per tool call (name, outcome, duration): never its arguments, never the token. */
  onCall?: (tool: string, ok: boolean, ms: number) => void
}

export interface LocalApiServerHandle {
  port: number
  url: string
  close(): Promise<void>
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/

export const isLoopbackAddress = (address: string | undefined): boolean => Boolean(address && LOOPBACK.test(address))

/** The Host header names this server on loopback (a DNS-rebinding page would send its own name). */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

/** No Origin (an editor, curl) or a loopback one of this port; a web page elsewhere is refused. */
export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase())
}

function authorized(header: string | undefined, token: string): boolean {
  if (!token) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const given = Buffer.from(header ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('Request too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The library tools while no project is open: each call answers `no_project`. */
const NO_PROJECT_LIBRARY = new Proxy({} as LibraryTools, {
  get: () => async () => {
    throw noProject()
  }
})

/** An error as the caller reads it: `<code>: <message>`. Only the API's own messages (and the library's) get through. */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  if (error instanceof ToolError) return `invalid: ${error.message}`
  if (error instanceof LlmError) return `${error.code}: The Claude operation did not finish (${error.code}).`
  return 'failed: The tool failed.'
}

/**
 * The local API: MCP over streamable HTTP (JSON responses, stateless, so a plain POST of a JSON-RPC `tools/call`
 * works) on 127.0.0.1 only. Refuses non-loopback peers, a Host or Origin that is not this server on loopback
 * (DNS rebinding), and any request without the bearer token. Tools: the read-only library tools of src/main/mcp and
 * `API_TOOLS`.
 */
export async function startLocalApiServer(opts: LocalApiServerOptions): Promise<LocalApiServerHandle> {
  const tools = opts.tools ?? API_TOOLS
  let port = opts.port

  const run: Run = async (tool, fn) => {
    const started = Date.now()
    try {
      const value = await fn()
      const body = typeof value === 'string' ? value : JSON.stringify(value)
      if (body.length > MAX_ANSWER_CHARS) throw new ApiError('too_large', 'The answer is too large: ask for less.')
      opts.onCall?.(tool, true, Date.now() - started)
      return text(body)
    } catch (error) {
      opts.onCall?.(tool, false, Date.now() - started)
      return text(errorText(error), true)
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return void res.writeHead(403).end()
    if (!allowedHost(req.headers.host, port) || !allowedOrigin(req.headers.origin, port)) return void res.writeHead(403).end()
    if (!authorized(req.headers.authorization, opts.token())) return void res.writeHead(401).end()
    if (req.url !== '/mcp') return void res.writeHead(404).end()
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end()
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      return void res.writeHead(400).end()
    }
    const ctx = opts.context()
    const server = new McpServer({ name: API_SERVER_NAME, version: '1.0.0' })
    defineLibraryTools(server, ctx?.library ?? NO_PROJECT_LIBRARY, run)
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: toolInput(tool) }, (args: Record<string, unknown>) =>
        run(tool.name, () => {
          if (!ctx) throw noProject()
          return callApiTool(tool, ctx, args, { allowCostly: opts.allowCostly() })
        })
      )
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(opts.port, '127.0.0.1', () => {
      http.removeListener('error', reject)
      resolve()
    })
  })
  port = (http.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      })
  }
}
