import { describe, expect, it } from 'vitest'
import { authorsLabel } from '../../src/shared/format'

describe('authorsLabel', () => {
  it('formats zero, one, two and many authors', () => {
    expect(authorsLabel([])).toBe('')
    expect(authorsLabel([{ family: 'He', given: 'Pinjia' }])).toBe('He')
    expect(authorsLabel([{ family: 'He' }, { family: 'Zhu' }])).toBe('He & Zhu')
    expect(authorsLabel([{ family: 'He' }, { family: 'Zhu' }, { family: 'Zheng' }])).toBe('He et al.')
  })
})
