import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

describe('runtime', () => {
  it('node:sqlite has FTS5 with diacritic folding', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 2')")
    db.prepare('INSERT INTO t (x) VALUES (?)').run('anonimización de logs')
    const rows = db.prepare("SELECT x FROM t WHERE t MATCH 'anonimizacion*'").all()
    expect(rows).toHaveLength(1)
    db.close()
  })
})
