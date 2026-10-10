import { describe, expect, it } from 'vitest'
import { formatBytes } from '../../src/renderer/lib/bytes'

describe('formatBytes', () => {
  it('uses the largest unit that keeps the number readable', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(470 * 1024 * 1024)).toBe('470 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})
