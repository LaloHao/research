import { describe, expect, it } from 'vitest'
import { startLibraryMcpServer, truncate, MAX_RESPONSE_CHARS } from '../../../src/main/mcp/LibraryMcpServer'
import { ToolError } from '../../../src/main/mcp/libraryTools'
import { callTools, listTools, stubTools } from '../../helpers/mcp'

const listRequest = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
const headers = (token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {})
})

describe('truncate', () => {
  it('keeps short texts and cuts long ones with a notice', () => {
    expect(truncate('abc', 10)).toBe('abc')
    const cut = truncate('x'.repeat(30), 10)
    expect(cut.startsWith('x'.repeat(10))).toBe(true)
    expect(cut).toContain('[truncated: 20 more characters')
  })
})

describe('startLibraryMcpServer', () => {
  it('serves the seven read-only tools on 127.0.0.1, each with a description', async () => {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12 })
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      expect(server.token).toMatch(/^[0-9a-f]{48}$/)
      const tools = await listTools(server)
      expect(tools.map((t) => t.name).sort()).toEqual(['find_in_paper', 'get_citations', 'get_neighbours', 'get_paper', 'read_pages', 'search_similar', 'search_text'])
      expect(tools.every((t) => (t.description ?? '').length > 30)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('runs a tool and answers with its result as JSON text', async () => {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12 })
    try {
      const [out] = await callTools(server, [{ name: 'search_text', arguments: { query: 'drain', paper_id: 'he2017drain', limit: 3 } }])
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toEqual([{ paper_id: 'he2017drain', page: 1, text: 'hit for drain' }])
      expect(server.calls()).toEqual([{ name: 'search_text', ok: true }])
    } finally {
      await server.close()
    }
  })

  it('refuses requests without the right token and anything but POST', async () => {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12 })
    try {
      expect((await fetch(server.url, { method: 'POST', headers: headers(), body: listRequest })).status).toBe(401)
      expect((await fetch(server.url, { method: 'POST', headers: headers('wrong'), body: listRequest })).status).toBe(401)
      expect((await fetch(server.url, { method: 'GET', headers: headers(server.token) })).status).toBe(405)
      expect((await fetch(server.url.replace('/mcp', '/other'), { method: 'POST', headers: headers(server.token), body: listRequest })).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('truncates long answers to the size cap', async () => {
    const server = await startLibraryMcpServer(stubTools({ searchText: async () => [{ paper_id: 'a1', page: 1, text: 'y'.repeat(20000) }] }), { maxToolCalls: 12 })
    try {
      const [out] = await callTools(server, [{ name: 'search_text', arguments: { query: 'y' } }])
      expect(out.text.length).toBeLessThan(MAX_RESPONSE_CHARS + 100)
      expect(out.text).toContain('[truncated:')
    } finally {
      await server.close()
    }
  })

  it('turns tool failures into error results without leaking internals', async () => {
    const server = await startLibraryMcpServer(
      stubTools({
        getPaper: async () => {
          throw new ToolError('Unknown paper id "x1".')
        },
        findInPaper: async () => {
          throw new Error('ENOENT /home/someone/project/papers/x1/paper.yaml')
        }
      }),
      { maxToolCalls: 12 }
    )
    try {
      const [unknown, broken] = await callTools(server, [
        { name: 'get_paper', arguments: { paper_id: 'x1' } },
        { name: 'find_in_paper', arguments: { paper_id: 'x1', text: 'ab' } }
      ])
      expect(unknown).toEqual({ text: 'Unknown paper id "x1".', isError: true })
      expect(broken).toEqual({ text: 'The tool failed.', isError: true })
      expect(server.calls()).toEqual([
        { name: 'get_paper', ok: false },
        { name: 'find_in_paper', ok: false }
      ])
    } finally {
      await server.close()
    }
  })

  it('stops running tools once the call budget is spent and tells the model to answer', async () => {
    let runs = 0
    const server = await startLibraryMcpServer(
      stubTools({
        searchText: async () => {
          runs++
          return []
        }
      }),
      { maxToolCalls: 2 }
    )
    try {
      const outcomes = await callTools(server, [1, 2, 3].map(() => ({ name: 'search_text', arguments: { query: 'q' } })))
      expect(outcomes.map((o) => o.isError)).toEqual([false, false, true])
      expect(outcomes[2].text).toMatch(/budget exhausted.*answer now/i)
      expect(runs).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('rejects arguments of the wrong type without running the tool', async () => {
    let runs = 0
    const server = await startLibraryMcpServer(
      stubTools({
        readPages: async (paperId) => {
          runs++
          return { paper_id: paperId, pages: [] }
        }
      }),
      { maxToolCalls: 12 }
    )
    try {
      const failed = await callTools(server, [{ name: 'read_pages', arguments: { paper_id: 'a1', from: 'one', to: 2 } }]).then(
        (out) => out[0].isError,
        () => true
      )
      expect(failed).toBe(true)
      expect(runs).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('stops listening when closed', async () => {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12 })
    await server.close()
    await expect(fetch(server.url, { method: 'POST', headers: headers(server.token), body: listRequest })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
  })

  it('counts each call before running it, so concurrent calls cannot exceed the budget', async () => {
    let runs = 0
    const server = await startLibraryMcpServer(
      stubTools({
        searchText: async () => {
          runs++
          await new Promise((r) => setTimeout(r, 50))
          return []
        }
      }),
      { maxToolCalls: 1 }
    )
    try {
      const outcomes = (await Promise.all([1, 2].map(() => callTools(server, [{ name: 'search_text', arguments: { query: 'q' } }])))).flat()
      expect(outcomes.filter((o) => o.isError)).toHaveLength(1)
      expect(runs).toBe(1)
    } finally {
      await server.close()
    }
  })
})
