import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { neutralizePromptTags } from '../llm/promptTags'
import { ToolError, type LibraryTools } from './libraryTools'

export const MCP_SERVER_NAME = 'library'
/** Cap on each tool answer, to bound what one run can read (and spend). */
export const MAX_RESPONSE_CHARS = 8000
const MAX_BODY_BYTES = 1_000_000

export interface ToolCallRecord {
  name: string
  ok: boolean
}

export interface LibraryMcpOptions {
  /** Tool calls allowed in this run; later calls get an error asking the model to answer. */
  maxToolCalls: number
  maxChars?: number
  /** Wraps every answer in <library_data> tags; the chat's prompt names them as data, never instructions. */
  markData?: boolean
}

export interface LibraryMcpHandle {
  url: string
  token: string
  calls(): ToolCallRecord[]
  close(): Promise<void>
}

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
export type Run = (name: string, fn: () => Promise<unknown>) => Promise<ToolResult>
/** Registers a server's tools on a fresh McpServer; each tool's work goes through `run` (budget, data marking, errors). */
export type DefineTools = (server: McpServer, run: Run) => void

export function truncate(text: string, max = MAX_RESPONSE_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters; ask for less: fewer pages, a narrower query, a lower limit]`
}

export const DATA_OPEN = '<library_data>'
export const DATA_CLOSE = '</library_data>'

/**
 * A tool answer as tagged library data. Every prompt tag inside it (this one, `<question>`, `<turn>` and the rest,
 * with invisible or full-width variants) is neutralized by the same code as the chat's own input, so paper text can
 * neither end the block nor fake a request; the escape is valid JSON and the rest is left exactly as it was.
 */
export function markAsData(text: string): string {
  return `${DATA_OPEN}\n${neutralizePromptTags(text)}\n${DATA_CLOSE}`
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

function defineTools(server: McpServer, tools: LibraryTools, run: Run): void {
  const paperId = z.string().describe('Key of a library paper, e.g. he2017drain')
  const limit = z.number().int().min(1).max(30).optional().describe('Maximum number of results')
  server.registerTool(
    'search_text',
    {
      description: 'Full-text search over the indexed text of the library papers (all words must appear). Returns passages with their paper key and page.',
      inputSchema: { query: z.string().min(1).describe('Words to search for'), paper_id: paperId.optional(), limit }
    },
    (a) => run('search_text', () => tools.searchText(a.query, a.paper_id, a.limit))
  )
  server.registerTool(
    'search_similar',
    {
      description: 'Semantic search: library papers closest in meaning to a query, using the local embedding model. Fails when the model is not downloaded.',
      inputSchema: { query: z.string().min(1).describe('A sentence describing what to look for'), limit }
    },
    (a) => run('search_similar', () => tools.searchSimilar(a.query, a.limit))
  )
  server.registerTool(
    'find_in_paper',
    {
      description: 'Finds literal text inside one paper (not a regular expression; case and accents are ignored). Returns each occurrence as written, with its page and surrounding context.',
      inputSchema: { paper_id: paperId, text: z.string().min(2).max(200).describe('Exact words to look for'), limit }
    },
    (a) => run('find_in_paper', () => tools.findInPaper(a.paper_id, a.text, a.limit))
  )
  server.registerTool(
    'read_pages',
    {
      description: 'Text of pages from..to (at most 5) of one paper; for a web page without pages, its whole text.',
      inputSchema: { paper_id: paperId, from: z.number().int().min(1), to: z.number().int().min(1) }
    },
    (a) => run('read_pages', () => tools.readPages(a.paper_id, a.from, a.to))
  )
  server.registerTool(
    'get_paper',
    {
      description: 'Metadata of one paper (title, authors, year, venue, abstract), its summary fields and facet values when it has them, and its number of pages.',
      inputSchema: { paper_id: paperId }
    },
    (a) => run('get_paper', () => tools.getPaper(a.paper_id))
  )
  server.registerTool(
    'get_citations',
    {
      description: 'Library papers that this paper cites and library papers that cite it (citations from OpenAlex).',
      inputSchema: { paper_id: paperId }
    },
    (a) => run('get_citations', () => tools.getCitations(a.paper_id))
  )
  server.registerTool(
    'get_neighbours',
    {
      description: 'The most similar library papers to this one, with a score and the reasons (shared references, co-citations, facets, content).',
      inputSchema: { paper_id: paperId }
    },
    (a) => run('get_neighbours', () => tools.getNeighbours(a.paper_id))
  )
  server.registerTool(
    'list_papers',
    {
      description: 'Lists the library papers by key, sorted, up to 50 at a time: title, year and whether each has a summary. Use offset to page through a large library.',
      inputSchema: {
        offset: z.number().int().min(0).optional().describe('How many papers to skip'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of papers')
      }
    },
    (a) => run('list_papers', () => tools.listPapers(a.offset, a.limit))
  )
  server.registerTool(
    'get_summary',
    {
      description: "One paper's summary fields and facet values, each with its review status (generated, verified or edited), the values it proposed outside the form, and its relation to the thesis.",
      inputSchema: { paper_id: paperId }
    },
    (a) => run('get_summary', () => tools.getSummary(a.paper_id))
  )
  server.registerTool(
    'facet_overview',
    {
      description: 'How each facet of the extraction form is used across the library: the allowed values with how many papers have each, and the values papers proposed that are not in the form yet, with the papers that proposed them.',
      inputSchema: {}
    },
    () => run('facet_overview', () => tools.facetOverview())
  )
}

function authorized(header: string | undefined, token: string): boolean {
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

/**
 * An MCP server for one agent run (any set of tools): streamable HTTP on 127.0.0.1, random port and bearer token,
 * stateless (a fresh McpServer per request; the call budget lives here, across requests).
 */
export async function startMcpServer(name: string, define: DefineTools, opts: LibraryMcpOptions): Promise<LibraryMcpHandle> {
  const token = randomBytes(24).toString('hex')
  const maxChars = opts.maxChars ?? MAX_RESPONSE_CHARS
  const calls: ToolCallRecord[] = []

  const run: Run = async (name, fn) => {
    // Recorded (and counted) before anything is awaited: concurrent requests cannot both slip under the budget.
    const record: ToolCallRecord = { name, ok: false }
    const overBudget = calls.length >= opts.maxToolCalls
    calls.push(record)
    if (overBudget) return text(`Tool budget exhausted (${opts.maxToolCalls} calls in this run). Do not call more tools: answer now with the evidence you already have.`, true)
    try {
      const value = await fn()
      record.ok = true
      const body = truncate(typeof value === 'string' ? value : JSON.stringify(value), maxChars)
      return text(opts.markData ? markAsData(body) : body)
    } catch (error) {
      // Only a ToolError's message reaches the model; anything else (a broken model, a file error) stays opaque.
      return text(error instanceof ToolError ? error.message : 'The tool failed.', true)
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req.headers.authorization, token)) return void res.writeHead(401).end()
    if (req.url !== '/mcp') return void res.writeHead(404).end()
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end()
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      return void res.writeHead(400).end()
    }
    const server = new McpServer({ name, version: '1.0.0' })
    define(server, run)
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
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls: () => [...calls],
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      })
  }
}

/** The read-only library server of the agent runs and the chat. */
export function startLibraryMcpServer(tools: LibraryTools, opts: LibraryMcpOptions): Promise<LibraryMcpHandle> {
  return startMcpServer(MCP_SERVER_NAME, (server, run) => defineTools(server, tools, run), opts)
}
