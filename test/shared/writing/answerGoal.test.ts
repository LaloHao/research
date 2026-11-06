import { describe, expect, it } from 'vitest'
import { extractGoal } from '../../../src/shared/writing/answerGoal'

describe('extractGoal', () => {
  it('takes the goal block out of the answer and reads its verdict', () => {
    const out = extractGoal('Bien.\n\n```goal\n{"met": false, "pending": ["  Falta  el paso 3. ", "", 4]}\n```\n')
    expect(out).toEqual({ text: 'Bien.', goal: { met: false, pending: ['Falta el paso 3.'] } })
  })

  it('met: no pending; no block, an unreadable one or one without met: no verdict', () => {
    expect(extractGoal('Listo.\n```goal\n{"met": true, "pending": ["opcional"]}\n```').goal).toEqual({ met: true, pending: [] })
    expect(extractGoal('Sin bloque.')).toEqual({ text: 'Sin bloque.', goal: null })
    expect(extractGoal('A\n```goal\nnot json\n```')).toEqual({ text: 'A', goal: null })
    expect(extractGoal('A\n```goal\n{"pending": []}\n```').goal).toBeNull()
  })

  it('leaves a block with a citation marker in the text', () => {
    const md = 'A\n```goal\n{"met": false, "pending": ["[[a, p. 1: \\"q\\"]]"]}\n```'
    expect(extractGoal(md)).toEqual({ text: md, goal: null })
  })
})
