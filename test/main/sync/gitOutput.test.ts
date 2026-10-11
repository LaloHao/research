import { describe, expect, it } from 'vitest'
import { groupConflicts, looksBinary, parseLsTree, parseMergeTree, parseNameStatus, parseStatus, splitNul } from '../../../src/main/sync/gitOutput'

const OID = (c: string): string => c.repeat(40)

describe('git output', () => {
  it('reads merge-tree -z --no-messages: the tree, then every stage of every conflicted path', () => {
    const out = [
      OID('f'),
      `100644 ${OID('1')} 1\toutside.txt`,
      `100644 ${OID('2')} 2\toutside.txt`,
      `100644 ${OID('3')} 3\toutside.txt`,
      `100644 ${OID('4')} 1\tproj/papers/d/notes.md`,
      `100644 ${OID('5')} 3\tproj/papers/d/notes.md`,
      ''
    ].join('\0')
    const parsed = parseMergeTree(out)
    expect(parsed.tree).toBe(OID('f'))
    expect(parsed.entries).toHaveLength(5)
    expect(groupConflicts(parsed.entries)).toEqual([
      { path: 'outside.txt', base: { mode: '100644', oid: OID('1') }, ours: { mode: '100644', oid: OID('2') }, theirs: { mode: '100644', oid: OID('3') } },
      { path: 'proj/papers/d/notes.md', base: { mode: '100644', oid: OID('4') }, ours: null, theirs: { mode: '100644', oid: OID('5') } }
    ])
    expect(parseMergeTree(`${OID('a')}\0`)).toEqual({ tree: OID('a'), entries: [] })
  })

  it('reads porcelain status -z, with both paths of a rename and ignored entries', () => {
    expect(parseStatus(' M thesis.tex\0A  staged.tex\0R  new.md\0old.md\0?? research/x.md\0!! .cache/\0')).toEqual([
      'thesis.tex',
      'staged.tex',
      'new.md',
      'old.md',
      'research/x.md',
      '.cache/'
    ])
    expect(parseStatus('')).toEqual([])
  })

  it('reads diff --name-status -z and ls-tree -z', () => {
    expect(parseNameStatus('D\0papers/k/paper.yaml\0A\0.trash/k/paper.yaml\0M\0papers/j/notes.md\0')).toEqual([
      { status: 'D', path: 'papers/k/paper.yaml' },
      { status: 'A', path: '.trash/k/paper.yaml' },
      { status: 'M', path: 'papers/j/notes.md' }
    ])
    expect(parseLsTree([`100644 blob ${OID('a')}\tpapers/k/notes.md`, `100755 blob ${OID('b')}\trun.sh`, ''].join('\0'))).toEqual([
      { mode: '100644', type: 'blob', oid: OID('a'), path: 'papers/k/notes.md' },
      { mode: '100755', type: 'blob', oid: OID('b'), path: 'run.sh' }
    ])
    expect(splitNul('a\0b\0')).toEqual(['a', 'b'])
  })

  it('tells binary content by a NUL byte near the start', () => {
    expect(looksBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
    expect(looksBinary(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toBe(true)
  })
})
