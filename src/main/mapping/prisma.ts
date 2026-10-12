import { DATABASE_KINDS, type MappingRecordRow, type PrismaColumn, type PrismaCounts, type Search } from '../../shared/mapping'

const emptyColumn = (): PrismaColumn => ({
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
  included: 0
})

/** E2 before E10. */
const byCriterion = (a: string, b: string): number => (a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a < b ? -1 : 1)

/**
 * PRISMA 2020 flow from the live searches and the current decisions. Database searches (OpenAlex, imports) are grouped
 * by database (case-insensitively, under the first spelling); snowballing and library searches by kind, in the «other
 * methods» column. A record belongs to the first column when any live source of it is a database search.
 * Duplicates = records read by the column's searches − the column's screened records, floored at 0: reads are never
 * fewer than the records they brought unless `searches.yaml` was edited by hand. A record waiting for «Es el mismo» or
 * «Son distintos» is not screened (it is in no queue, and its decisions go to the other record if it is the same), so
 * until it is answered it counts among the duplicates; «Son distintos» moves it to the screening.
 */
export function prismaCounts(rows: MappingRecordRow[], searches: Search[]): PrismaCounts {
  const columns = { databases: emptyColumn(), other: emptyColumn() }
  for (const s of searches) {
    if (s.discarded) continue
    const isDatabase = DATABASE_KINDS.has(s.kind)
    const column = isDatabase ? columns.databases : columns.other
    const database = isDatabase ? s.database : s.kind
    const source = column.identified.find((x) => x.database.toLowerCase() === database.toLowerCase())
    if (source) source.count += s.count
    else column.identified.push({ kind: s.kind, database, count: s.count })
  }
  const reasons = { databases: new Map<string, number>(), other: new Map<string, number>() }
  for (const row of rows) {
    if (!row.active || row.duplicate) continue
    const c = columns[row.column]
    c.screened++
    const ta = row.title_abstract.state
    if (ta === 'exclude') {
      c.excludedScreening++
      continue
    }
    if (ta !== 'include') {
      c.pendingScreening++
      continue
    }
    c.sought++
    const ft = row.full_text
    if (ft.state === 'not_retrieved') c.notRetrieved++
    else if (ft.state === 'include') {
      c.assessed++
      c.included++
    } else if (ft.state === 'exclude') {
      c.assessed++
      const m = reasons[row.column]
      m.set(ft.criterion ?? '', (m.get(ft.criterion ?? '') ?? 0) + 1)
    } else c.pendingFullText++
  }
  for (const key of ['databases', 'other'] as const) {
    const c = columns[key]
    c.duplicates = Math.max(0, c.identified.reduce((sum, x) => sum + x.count, 0) - c.screened)
    c.excludedFullText = [...reasons[key]].map(([criterion, count]) => ({ criterion, count })).sort((a, b) => byCriterion(a.criterion, b.criterion))
  }
  return { ...columns, included: columns.databases.included + columns.other.included }
}
