import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderLibraryBib, writeLibraryBib } from '../../../src/main/export/BibExporter'
import { tmpDir } from '../../helpers/tmp'

const papers = [
  { id: 'zhu2020loghub', bibtex: '@misc{whatever,\n  title = {Loghub}\n}' },
  { id: 'he2017drain', bibtex: '@inproceedings{he2017drain,\n  title = {Drain}\n}' }
]

describe('renderLibraryBib', () => {
  it('sorts by key, forces each key to the paper id and adds a header', () => {
    const text = renderLibraryBib(papers)
    expect(text.startsWith('% Generated from papers/*/paper.yaml')).toBe(true)
    expect(text.indexOf('@inproceedings{he2017drain,')).toBeLessThan(text.indexOf('@misc{zhu2020loghub,'))
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('keeps going when one entry is broken', () => {
    const text = renderLibraryBib([...papers, { id: 'broken2020x', bibtex: 'oops' }])
    expect(text).toContain('% skipped broken2020x: invalid BibTeX')
    expect(text).toContain('@misc{zhu2020loghub,')
  })
})

describe('writeLibraryBib', () => {
  it('writes only when the content changes', async () => {
    const path = join(await tmpDir(), 'exports', 'library.bib')
    expect(await writeLibraryBib(path, papers)).toBe(true)
    expect(await writeLibraryBib(path, papers)).toBe(false)
    expect(await readFile(path, 'utf8')).toContain('@misc{zhu2020loghub,')
  })
})
