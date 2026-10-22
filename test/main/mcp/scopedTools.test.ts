import { describe, expect, it } from 'vitest'
import { ToolError } from '../../../src/main/mcp/libraryTools'
import { scopeLibraryTools } from '../../../src/main/mcp/scopedTools'
import { stubTools } from '../../helpers/mcp'

const link = (id: string) => ({ paper_id: id, title: id, year: 2020 })

describe('scopeLibraryTools', () => {
  const base = stubTools({
    searchText: async (query, paperId) =>
      paperId ? [{ paper_id: paperId, page: 1, text: `own ${query}` }] : [{ paper_id: 'out', page: 1, text: 'x' }, { paper_id: 'a', page: 2, text: 'y' }],
    searchSimilar: async () => [{ ...link('out'), score: 0.9 }, { ...link('b'), score: 0.5 }],
    getCitations: async (id) => ({ paper_id: id, cites: [link('b'), link('out')], cited_by: [link('out')] }),
    getNeighbours: async (id) => ({ paper_id: id, similar: [{ ...link('out'), score: 1, reasons: [] }, { ...link('a'), score: 0.4, reasons: [] }] }),
    listPapers: async (offset = 0) => {
      const all = Array.from({ length: 120 }, (_v, i) => ({ paper_id: i === 7 ? 'a' : i === 99 ? 'b' : `p${i}`, title: 't', year: null, has_summary: false }))
      return { total: all.length, offset, papers: all.slice(offset, offset + 50) }
    }
  })
  const tools = scopeLibraryTools(base, ['a', 'b'])

  it('refuses a paper outside the scope in every per-paper tool', async () => {
    for (const call of [
      () => tools.findInPaper('out', 'x'),
      () => tools.readPages('out', 1, 1),
      () => tools.getPaper('out'),
      () => tools.getSummary('out'),
      () => tools.getCitations('out'),
      () => tools.getNeighbours('out'),
      () => tools.searchText('x', 'out')
    ])
      await expect(call()).rejects.toBeInstanceOf(ToolError)
    await expect(tools.getPaper('a')).resolves.toMatchObject({ paper_id: 'a' })
  })

  it('returns only papers of the scope from searches, lists, citations and neighbours', async () => {
    expect((await tools.searchText('logs')).map((h) => [h.paper_id, h.text])).toEqual([
      ['a', 'y'],
      ['b', 'own logs']
    ])
    expect((await tools.searchSimilar('logs')).map((h) => h.paper_id)).toEqual(['b'])
    expect(await tools.getCitations('a')).toEqual({ paper_id: 'a', cites: [link('b')], cited_by: [] })
    expect((await tools.getNeighbours('a')).similar.map((n) => n.paper_id)).toEqual(['a'])
    expect(await tools.listPapers()).toMatchObject({ total: 2, offset: 0, papers: [{ paper_id: 'a' }, { paper_id: 'b' }] })
  })
})
