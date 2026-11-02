import { describe, expect, it } from 'vitest'
import { newKeyProblem } from '../../src/renderer/lib/changeKey'

describe('newKeyProblem', () => {
  it('takes lowercase ASCII letters and digits starting with a letter, spaces around ignored', () => {
    expect(newKeyProblem('beyer2016site', 'old')).toBeNull()
    expect(newKeyProblem('  beyer2016site ', 'old')).toBeNull()
  })

  it('refuses anything else, and the key the paper already has', () => {
    for (const typed of ['', 'Beyer2016', '2016beyer', 'beyer-2016', 'beyer 2016', 'béyer2016']) expect(newKeyProblem(typed, 'old')).toBe('invalid_key')
    expect(newKeyProblem(' old ', 'old')).toBe('key_unchanged')
  })
})
