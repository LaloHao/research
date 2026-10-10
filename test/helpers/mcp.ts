import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LibraryTools } from '../../src/main/mcp/libraryTools'

/** Tools with fixed, small answers; override any of them per test. */
export function stubTools(over: Partial<LibraryTools> = {}): LibraryTools {
  return {
    searchText: async (query) => [{ paper_id: 'he2017drain', page: 1, text: `hit for ${query}` }],
    searchSimilar: async () => [],
    findInPaper: async () => [],
    readPages: async (paperId, from) => ({ paper_id: paperId, pages: [{ page: from, text: 'page text' }] }),
    getPaper: async (paperId) => ({ paper_id: paperId, title: 'T', authors: 'A', year: 2020, venue: null, abstract: null, summary: null, facets: {}, pages: 1 }),
    getCitations: async (paperId) => ({ paper_id: paperId, cites: [], cited_by: [] }),
    getNeighbours: async (paperId) => ({ paper_id: paperId, similar: [] }),
    ...over
  }
}

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolOutcome {
  text: string
  isError: boolean
}

async function connect(endpoint: { url: string; token: string }): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }))
  return client
}

/** Connects the way the Claude CLI does (bearer token header) and runs the calls in order. */
export async function callTools(endpoint: { url: string; token: string }, calls: ToolCall[]): Promise<ToolOutcome[]> {
  const client = await connect(endpoint)
  try {
    const out: ToolOutcome[] = []
    for (const call of calls) {
      const result = await client.callTool(call)
      const content = result.content as { type: string; text?: string }[]
      out.push({ text: content.map((c) => c.text ?? '').join(''), isError: result.isError === true })
    }
    return out
  } finally {
    await client.close()
  }
}

export async function listTools(endpoint: { url: string; token: string }): Promise<{ name: string; description?: string }[]> {
  const client = await connect(endpoint)
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
  }
}
