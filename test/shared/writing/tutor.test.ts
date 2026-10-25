import { describe, expect, it } from 'vitest'
import {
  locateExcerpt,
  looseOccurrences,
  maxAlternativeLength,
  parseAlternativesOutput,
  parseTutorOutput,
  quotesRewrite,
  validateAlternatives,
  validateTutorIssues,
  type Alternative,
  type RawTutorIssue
} from '../../../src/shared/writing/tutor'

const issue = (excerpt: string, over: Partial<RawTutorIssue> = {}): RawTutorIssue => ({
  excerpt,
  context: null,
  kind: 'ambiguity',
  explanation: '¿A qué se refiere «esto»?',
  question: '¿Qué sustantivo nombra lo que quieres señalar?',
  ...over
})

describe('locating an excerpt', () => {
  const text = 'Esto mejora el modelo.\nEsto también lo mejora, y\nmucho.'

  it('finds a unique excerpt ignoring differences in whitespace only', () => {
    expect(locateExcerpt(text, 'lo mejora, y mucho.', null)).toEqual({ start: text.indexOf('lo mejora'), end: text.length })
    expect(locateExcerpt(text, 'lo Mejora', null)).toBe('not_found')
    expect(locateExcerpt(text, '   ', null)).toBe('not_found')
  })

  it('needs a context that occurs once when the excerpt repeats', () => {
    expect(locateExcerpt(text, 'Esto', null)).toBe('ambiguous')
    expect(locateExcerpt(text, 'Esto', 'Esto también')).toEqual({ start: text.indexOf('Esto también'), end: text.indexOf('Esto también') + 4 })
    expect(locateExcerpt(text, 'Esto', 'mejora')).toBe('ambiguous')
  })

  it('counts overlapping occurrences', () => {
    expect(looseOccurrences('aaa', 'aa')).toHaveLength(2)
  })
})

describe('quotesRewrite', () => {
  const original = 'Los registros del sistema fueron analizados por el equipo durante varias semanas.'

  it('flags a long quoted span the author did not write, in any quote style', () => {
    expect(quotesRewrite('Podrías decir «el equipo analizó los registros del sistema durante varias semanas».', original)).toBe(true)
    expect(quotesRewrite('Prueba "el equipo analizó los registros del sistema durante semanas".', original)).toBe(true)
    expect(quotesRewrite('Como en “el equipo analizó los registros del sistema durante semanas”.', original)).toBe(true)
  })

  it('lets through short quotes and quotes of the author’s own words', () => {
    expect(quotesRewrite('«fueron analizados» oculta quién actúa.', original)).toBe(false)
    expect(quotesRewrite('En «Los registros del sistema fueron analizados por el equipo» no se sabe cuándo.', original)).toBe(false)
    expect(quotesRewrite('Sin comillas el equipo analizó los registros del sistema durante varias semanas.', original)).toBe(false)
  })
})

describe('tutor output', () => {
  it('is strict: a rewrite field, an unknown kind or an overlong question make it invalid', () => {
    expect(parseTutorOutput({ issues: [issue('x')] }).ok).toBe(true)
    expect(parseTutorOutput({ issues: [{ ...issue('x'), rewrite: 'y' }] }).ok).toBe(false)
    expect(parseTutorOutput({ issues: [issue('x', { kind: 'spelling' as never })] }).ok).toBe(false)
    expect(parseTutorOutput({ issues: [issue('x', { question: 'q'.repeat(201) })] }).ok).toBe(false)
    expect(parseTutorOutput({ issues: [issue('x', { explanation: 'e'.repeat(301) })] }).ok).toBe(false)
  })

  it('keeps located issues in text order, drops not found, ambiguous and rewriting ones, and counts them', () => {
    const text = 'Esto mejora el modelo. Esto también, aunque se usó la técnica sin decir quién la aplicó en los experimentos.'
    const review = validateTutorIssues(text, [
      issue('se usó la técnica', { kind: 'lost_subject' }),
      issue('Esto mejora', { kind: 'ambiguity' }),
      issue('no está en el texto'),
      issue('Esto'),
      issue('el modelo', { question: '¿Y si escribes «el equipo aplicó la técnica en todos los experimentos del capítulo»?' })
    ])
    expect(review.issues.map((i) => [i.excerpt, i.kind, text.slice(i.start, i.end)])).toEqual([
      ['Esto mejora', 'ambiguity', 'Esto mejora'],
      ['se usó la técnica', 'lost_subject', 'se usó la técnica']
    ])
    expect(review.dropped).toEqual({ not_found: 1, ambiguous: 1, rewrite: 1 })
  })

  it('answers the excerpt as the author wrote it, line breaks included', () => {
    const text = 'Una idea\nlarga aquí.'
    expect(validateTutorIssues(text, [issue('idea larga')]).issues[0].excerpt).toBe('idea\nlarga')
  })
})

describe('alternatives', () => {
  const alt = (text: string, over: Partial<Alternative> = {}): Alternative => ({ text, aspect: 'order', what_changes: 'Pone el resultado primero.', ...over })
  const sentence = 'Drain analiza los registros en línea \\cite{he2017drain} con un árbol de profundidad $d$.'

  it('wants two or three, strictly', () => {
    expect(parseAlternativesOutput({ alternatives: [alt('a')] }).ok).toBe(false)
    expect(parseAlternativesOutput({ alternatives: [alt('a'), alt('b')] }).ok).toBe(true)
    expect(parseAlternativesOutput({ alternatives: [alt('a'), alt('b'), alt('c'), alt('d')] }).ok).toBe(false)
    expect(parseAlternativesOutput({ alternatives: [alt('a'), { ...alt('b'), aspect: 'tone' }] }).ok).toBe(false)
  })

  it('keeps only those that keep the citation and the math, differ, and are not much longer', () => {
    const review = validateAlternatives(sentence, 'latex', [
      alt('Con un árbol de profundidad $d$, Drain analiza los registros en línea \\cite{he2017drain}.'),
      alt('Drain analiza los registros en línea con un árbol de profundidad $d$.'),
      alt('Drain analiza los registros en línea \\citep{he2017drain} con un árbol de profundidad $d$.'),
      alt('Drain analiza los registros en línea \\cite{he2017drain} con un árbol de profundidad $k$.'),
      alt(' Drain analiza los registros  en línea \\cite{he2017drain} con un árbol de profundidad $d$. '),
      alt('Con un árbol de profundidad $d$,  Drain analiza los registros en línea \\cite{he2017drain}.'),
      alt(`${sentence} ${'Y además añade muchas ideas nuevas que el autor nunca escribió. '.repeat(3)}`)
    ])
    expect(review.alternatives.map((a) => a.text)).toEqual(['Con un árbol de profundidad $d$, Drain analiza los registros en línea \\cite{he2017drain}.'])
    expect(review.dropped).toEqual({ unchanged: 1, protected: 3, duplicate: 1, too_long: 1 })
  })

  it('allows a little more length than the sentence', () => {
    expect(maxAlternativeLength('x'.repeat(100))).toBe(200)
  })

  it('keeps Org citations exactly', () => {
    const org = 'Los parsers en línea existen [cite:@he2017drain p. 3].'
    expect(validateAlternatives(org, 'org', [alt('Existen parsers en línea [cite:@he2017drain p. 3].'), alt('Existen parsers en línea [cite:@he2017drain].')]).alternatives).toHaveLength(1)
  })
})
