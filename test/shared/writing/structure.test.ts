import { describe, expect, it } from 'vitest'
import { buildReverseOutline, buildRqCoverage, parseReverseOutline, parseRqCoverage, splitSections } from '../../../src/shared/writing/structure'

const ORG = [
  '#+title: Capítulo',
  'Antes del primer encabezado.',
  '* TODO Introducción :borrador:',
  ':PROPERTIES:',
  ':ID: x',
  ':END:',
  'Primer párrafo,',
  'en dos líneas.',
  '',
  '#+begin_src python',
  'print("no es prosa")',
  '#+end_src',
  '| tabla | x |',
  '# comentario',
  'Segundo párrafo.',
  '- un elemento',
  '- otro elemento',
  '** Métodos',
  '\\begin{equation}',
  'x = 1',
  '\\end{equation}',
  'Tercer párrafo.'
].join('\n')

describe('splitSections', () => {
  it('splits Org into headings and prose paragraphs with their offsets', () => {
    const sections = splitSections(ORG, 'org')
    expect(sections.map((s) => [s.id, s.heading, s.level])).toEqual([
      ['S1', null, 0],
      ['S2', 'Introducción', 1],
      ['S3', 'Métodos', 2]
    ])
    expect(sections.flatMap((s) => s.paragraphs.map((p) => [p.index, p.text]))).toEqual([
      [1, 'Antes del primer encabezado.'],
      [2, 'Primer párrafo,\nen dos líneas.'],
      [3, 'Segundo párrafo.'],
      [4, '- un elemento'],
      [5, '- otro elemento'],
      [6, 'Tercer párrafo.']
    ])
    for (const p of sections.flatMap((s) => s.paragraphs)) expect(ORG.slice(p.start, p.end)).toBe(p.text)
    expect(ORG.slice(sections[1].start, sections[1].end)).toMatch(/^\* TODO Introducción[\s\S]*otro elemento\n$/)
  })

  it('reads LaTeX and Markdown headings', () => {
    const latex = '\\section{Trabajo previo}\nUno.\n\n% nota\n\\subsection*{Parsers}\nDos.\n\\label{sec:x}\nTres.'
    expect(splitSections(latex, 'latex').map((s) => [s.heading, s.level, s.paragraphs.map((p) => p.text)])).toEqual([
      ['Trabajo previo', 2, ['Uno.']],
      ['Parsers', 3, ['Dos.', 'Tres.']]
    ])
    const md = '# Título\n\nTexto.\n\n```\ncódigo\n```\n## Sub\nMás.'
    expect(splitSections(md, 'markdown').map((s) => [s.heading, s.paragraphs.map((p) => p.text)])).toEqual([
      ['Título', ['Texto.']],
      ['Sub', ['Más.']]
    ])
  })
})

describe('reverse outline', () => {
  const ok = (n: number, flags: unknown[] = []) => ({ n, main_idea: 'Una idea en pocas palabras.', flags })

  it('wants every paragraph sent, once, with short main ideas', () => {
    expect(parseReverseOutline({ paragraphs: [ok(1), ok(2)] }, 2).ok).toBe(true)
    expect(parseReverseOutline({ paragraphs: [ok(1)] }, 2)).toEqual({ ok: false, error: 'Missing paragraphs: 2.' })
    expect(parseReverseOutline({ paragraphs: [ok(1), ok(1), ok(2)] }, 2).ok).toBe(false)
    expect(parseReverseOutline({ paragraphs: [ok(1), ok(3)] }, 2).ok).toBe(false)
    const long = { n: 1, main_idea: Array.from({ length: 21 }, (_, i) => `p${i}`).join(' '), flags: [] }
    expect(parseReverseOutline({ paragraphs: [long] }, 1)).toMatchObject({ ok: false })
    expect(parseReverseOutline({ paragraphs: [{ ...ok(1), flags: [{ flag: 'too_short', note: 'x' }] }] }, 1).ok).toBe(false)
    expect(parseReverseOutline({ paragraphs: [{ ...ok(1), rewrite: 'x' }] }, 1).ok).toBe(false)
  })

  it('answers in paragraph order with the app offsets and drops off_topic without a heading', () => {
    const sections = splitSections(ORG, 'org')
    const parsed = parseReverseOutline(
      {
        paragraphs: [6, 5, 4, 3, 2, 1].map((n) =>
          ok(
            n,
            n === 1
              ? [{ flag: 'off_topic', note: 'Sin encabezado.' }]
              : n === 2
                ? [
                    { flag: 'two_ideas', note: 'Dos ideas.' },
                    { flag: 'two_ideas', note: 'Otra vez.' },
                    { flag: 'off_topic', note: 'No trata de la introducción.' }
                  ]
                : []
          )
        )
      },
      6
    )
    if (!parsed.ok) throw new Error(parsed.error)
    const outline = buildReverseOutline(sections, parsed.value)
    expect(outline.paragraphs.map((p) => [p.index, p.heading, p.flags.map((f) => f.flag)])).toEqual([
      [1, null, []],
      [2, 'Introducción', ['two_ideas', 'off_topic']],
      [3, 'Introducción', []],
      [4, 'Introducción', []],
      [5, 'Introducción', []],
      [6, 'Métodos', []]
    ])
    expect(outline.dropped.off_topic_without_heading).toBe(1)
    expect(ORG.slice(outline.paragraphs[1].start, outline.paragraphs[1].end)).toBe('Primer párrafo,\nen dos líneas.')
  })
})

describe('RQ coverage', () => {
  const sections = splitSections(ORG, 'org').filter((s) => s.paragraphs.length > 0)
  const ids = sections.map((s) => s.id)

  it('wants exactly the sections sent and only the questions sent', () => {
    const all = ids.map((id) => ({ id, addresses: [] }))
    expect(parseRqCoverage({ sections: all }, ids, ['RQ1']).ok).toBe(true)
    expect(parseRqCoverage({ sections: all.slice(1) }, ids, ['RQ1']).ok).toBe(false)
    expect(parseRqCoverage({ sections: [...all, { id: 'S9', addresses: [] }] }, ids, ['RQ1']).ok).toBe(false)
    expect(parseRqCoverage({ sections: [{ id: 'S1', addresses: [{ rq: 'RQ7', excerpt: 'x' }] }, ...all.slice(1)] }, ids, ['RQ1']).ok).toBe(false)
  })

  it('keeps evidence found in its own section, one per question, and lists the questions left uncovered', () => {
    const raw = [
      { id: 'S1', addresses: [{ rq: 'RQ1', excerpt: 'Tercer párrafo.' }] },
      {
        id: 'S2',
        addresses: [
          { rq: 'RQ1', excerpt: 'Primer párrafo, en dos líneas.' },
          { rq: 'RQ1', excerpt: 'Segundo párrafo.' }
        ]
      },
      { id: 'S3', addresses: [] }
    ]
    const coverage = buildRqCoverage(ORG, sections, raw, ['RQ1', 'RQ2'])
    expect(coverage.sections.map((s) => [s.id, s.addresses.map((a) => [a.rq, a.excerpt])])).toEqual([
      ['S1', []],
      ['S2', [['RQ1', 'Primer párrafo,\nen dos líneas.']]],
      ['S3', []]
    ])
    expect(coverage.dropped.not_found).toBe(1)
    expect(coverage.not_addressed).toEqual(['RQ2'])
    const a = coverage.sections[1].addresses[0]
    expect(ORG.slice(a.start, a.end)).toBe(a.excerpt)
  })
})
