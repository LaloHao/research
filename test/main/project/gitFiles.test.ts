import { describe, expect, it } from 'vitest'
import { gitattributesLines, gitignoreLines, withManagedBlock } from '../../../src/main/project/gitFiles'

describe('withManagedBlock', () => {
  it('appends a block to a file without one, keeping user lines', () => {
    const out = withManagedBlock('node_modules/\n', ['.cache/'])
    expect(out).toBe('node_modules/\n\n# >>> research-app managed >>>\n.cache/\n# <<< research-app managed <<<\n')
  })

  it('replaces only the block when it exists', () => {
    const first = withManagedBlock('mine\n', ['.cache/', 'papers/*/paper.pdf'])
    const second = withManagedBlock(first, ['.cache/'])
    expect(second).toContain('mine\n')
    expect(second).not.toContain('papers/*/paper.pdf')
    expect(second.match(/research-app managed >>>/g)).toHaveLength(1)
  })

  it('creates a file from scratch', () => {
    expect(withManagedBlock('', ['.cache/'])).toBe('# >>> research-app managed >>>\n.cache/\n# <<< research-app managed <<<\n')
  })
})

describe('policy lines', () => {
  it('ignores the cache always and PDFs only when untracked', () => {
    expect(gitignoreLines('track')).toEqual(['.cache/'])
    expect(gitignoreLines('untracked')).toEqual(['.cache/', 'papers/*/paper.pdf'])
  })

  it('routes PDFs through LFS only for the lfs policy', () => {
    expect(gitattributesLines('lfs')).toEqual(['papers/*/paper.pdf filter=lfs diff=lfs merge=lfs -text'])
    expect(gitattributesLines('track')).toEqual([])
  })
})
