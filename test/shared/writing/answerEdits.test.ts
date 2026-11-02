import { describe, expect, it } from 'vitest'
import { extractEdits } from '../../../src/shared/writing/answerEdits'

const PASSAGE = 'La IA cambia la ingenieria de software.\nLos servicios son piezas independientes.\nLos servicios fallan.'

describe('extractEdits', () => {
  it('takes the edits block out of the answer and checks each change against the passage', () => {
    const answer = [
      'Corrijo un acento y aclaro la segunda frase.',
      '',
      '```edits',
      JSON.stringify([
        { find: 'ingenieria', replace: 'ingeniería', why: 'Acento.' },
        { find: 'Los servicios', replace: 'Estos servicios', why: 'Ambiguo.' },
        { find: 'no está', replace: 'x', why: 'No existe.' },
        { find: 'piezas independientes', replace: 'piezas independientes', why: 'Igual.' }
      ]),
      '```',
      ''
    ].join('\n')
    const { text, edits } = extractEdits(answer, PASSAGE)
    expect(text).toBe('Corrijo un acento y aclaro la segunda frase.')
    expect(edits?.map((e) => e.state)).toEqual(['ok', 'ambiguous', 'not_found', 'invalid'])
    expect(edits?.[0]).toEqual({ find: 'ingenieria', replace: 'ingeniería', why: 'Acento.', state: 'ok' })
  })

  it('gives no edits without a block, none for an unreadable one, and leaves a block holding a citation marker', () => {
    expect(extractEdits('Solo comentarios.', PASSAGE)).toEqual({ text: 'Solo comentarios.', edits: null })
    expect(extractEdits('Antes.\n```edits\nnot json\n```', PASSAGE)).toEqual({ text: 'Antes.', edits: [] })
    const marked = 'X\n```edits\n[{"find":"IA","replace":"[[he2017drain|p. 1|\\"q\\"]]"}]\n```'
    expect(extractEdits(marked, PASSAGE)).toEqual({ text: marked, edits: null })
  })
})
