import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseYamlFile, toYaml } from '../../../src/main/project/yamlFile'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { PaperSchema } from '../../../src/shared/schemas'
import { samplePaper } from '../../helpers/papers'

describe('parseYamlFile', () => {
  it('parses a valid file and returns its hash', () => {
    const text = toYaml(samplePaper())
    const r = parseYamlFile(text, PaperSchema)
    expect(r.ok).toBe(true)
    expect(r.hash).toBe(sha256(text))
  })

  it('reports git conflict markers before trying to parse', () => {
    const text = 'id: a\n<<<<<<< HEAD\ntitle: x\n=======\ntitle: y\n>>>>>>> other\n'
    const r = parseYamlFile(text, PaperSchema)
    expect(r).toMatchObject({ ok: false, problem: { kind: 'conflict_markers' } })
  })

  it('reports invalid yaml', () => {
    const r = parseYamlFile('title: [unclosed', PaperSchema)
    expect(r).toMatchObject({ ok: false, problem: { kind: 'invalid_yaml' } })
  })

  it('reports schema violations with the field path', () => {
    const r = parseYamlFile(toYaml({ ...samplePaper(), year: 'soon' }), PaperSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.kind).toBe('invalid_schema')
      expect(r.problem.message).toContain('year')
    }
  })
})

describe('toYaml', () => {
  it('omits undefined values and writes multi-line strings as block scalars', () => {
    const text = toYaml({ a: 1, b: undefined, bib: '@misc{k,\n  t = {v}\n}' })
    expect(text).not.toContain('b:')
    expect(text).toContain('bib: |-')
    expect(parse(text)).toEqual({ a: 1, bib: '@misc{k,\n  t = {v}\n}' })
  })
})
