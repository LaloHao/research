import { describe, expect, it } from 'vitest'
import { prismaSvg, wrap, type PrismaLabels } from '../../src/renderer/lib/prismaSvg'
import type { PrismaColumn, PrismaCounts } from '../../src/shared/mapping'

const labels: PrismaLabels = {
  databases: 'Databases and registers',
  other: 'Other methods',
  stages: { identification: 'Identification', screening: 'Screening', included: 'Included' },
  identified: 'Records identified from:',
  source: (s) => `${s.database} (n = ${s.count})`,
  duplicates: (n) => `Duplicates (n = ${n})`,
  screened: (n, pending) => `Records screened (n = ${n}; ${pending} pending)`,
  excludedScreening: (n) => `Records excluded (n = ${n})`,
  sought: (n) => `Reports sought for retrieval (n = ${n})`,
  notRetrieved: (n) => `Reports not retrieved (n = ${n})`,
  assessed: (n, pending) => `Reports assessed for eligibility (n = ${n}; ${pending} pending)`,
  excludedFullText: 'Reports excluded:',
  reason: (criterion, n) => `${criterion} (n = ${n})`,
  included: (n) => `Studies included in review (n = ${n})`
}

const column = (over: Partial<PrismaColumn> = {}): PrismaColumn => ({
  identified: [],
  duplicates: 0,
  screened: 0,
  excludedScreening: 0,
  pendingScreening: 0,
  sought: 0,
  notRetrieved: 0,
  assessed: 0,
  excludedFullText: [],
  pendingFullText: 0,
  included: 0,
  ...over
})

const counts = (over: Partial<PrismaColumn> = {}): PrismaCounts => ({
  databases: column({ identified: [{ kind: 'import', database: 'A&B <Scopus>', count: 3 }], duplicates: 1, screened: 2, sought: 1, assessed: 1, excludedFullText: [{ criterion: 'E2', count: 1 }], ...over }),
  other: column({ identified: [{ kind: 'snowball', database: 'snowball', count: 2 }], screened: 2, pendingScreening: 2 }),
  included: 0
})

describe('prismaSvg', () => {
  it('draws both columns with every box, arrow and count, escaping the text', () => {
    const { svg, width, height } = prismaSvg(counts(), labels)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain(`width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`)
    expect(svg).toContain('A&amp;B &lt;Scopus&gt; (n = 3)')
    expect(svg).not.toContain('<Scopus>')
    expect(svg.match(/class="box"/g)).toHaveLength(19)
    expect(svg.match(/class="stage"/g)).toHaveLength(3)
    expect(svg.match(/<line /g)).toHaveLength(16)
    for (const text of ['Duplicates (n = 1)', 'E2 (n = 1)', 'Studies included in review (n = 0)', 'Other methods', 'Identification']) expect(svg).toContain(text)
  })

  it('stays well-formed XML whatever the names and titles hold', () => {
    const odd = counts({ identified: [{ kind: 'import', database: `It's "quoted" & <b>\u0000\u0007\ud800 ok`, count: 1 }] })
    const { svg } = prismaSvg(odd, { ...labels, databases: '</svg><script>x</script>' })
    expect(svg).toContain('It&apos;s &quot;quoted&quot; &amp; &lt;b&gt; ok (n = 1)')
    expect(svg).not.toContain('<script>')
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
    expect(svg).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    // Every & starts an entity, and tags nest.
    expect(svg).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/)
    const stack: string[] = []
    for (const [, close, name, self] of svg.matchAll(/<(\/?)([a-zA-Z]+)[^<>]*?(\/?)>/g)) {
      if (self) continue
      if (close) expect(stack.pop()).toBe(name)
      else stack.push(name)
    }
    expect(stack).toEqual([])
    expect(svg.replace(/<[^<>]*>/g, '')).not.toMatch(/[<>]/)
  })

  it('grows with the lists it shows', () => {
    const many = counts({ identified: Array.from({ length: 8 }, (_, i) => ({ kind: 'import' as const, database: `Database ${i}`, count: i })) })
    expect(prismaSvg(many, labels).height).toBeGreaterThan(prismaSvg(counts(), labels).height)
  })

  it('wraps words to the width of a box', () => {
    expect(wrap('a bb ccc dddd', 6)).toEqual(['a bb', 'ccc', 'dddd'])
    expect(wrap('', 6)).toEqual([''])
    expect(wrap('ab https://example.org/x', 8)).toEqual(['ab', 'https://', 'example.', 'org/x'])
  })
})
