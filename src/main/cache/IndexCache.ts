import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { authorsLabel } from '../../shared/format'
import type { JobState } from '../../shared/jobs'
import type { PaperRow, TextStatus } from '../../shared/library'
import type { Paper } from '../../shared/schemas'
import type { SummaryStatus } from '../../shared/summary'
import type { Chunk } from '../extract/chunker'
import type { DedupeEntry } from '../library/dedupe'
import type { FileProblem } from '../project/errors'
import { buildPaperText } from '../summary/paperText'

export type { PaperRow, TextStatus }

export interface JobRow {
  id: number
  spec: string
  state: JobState
  message: string | null
  paper_id: string | null
  created_at: string
  updated_at: string
}

// 4: text_chars measures the text as the too-long check does.
const SCHEMA_VERSION = 4
const TOKENIZER = "tokenize='unicode61 remove_diacritics 2'"
const DDL = `
CREATE TABLE papers (
  id TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  authors_label TEXT NOT NULL DEFAULT '',
  year INTEGER,
  venue TEXT,
  kind TEXT,
  doi TEXT,
  arxiv TEXT,
  metadata_status TEXT,
  has_pdf INTEGER NOT NULL DEFAULT 0,
  problem TEXT,
  added_at TEXT,
  text_hash TEXT,
  text_status TEXT NOT NULL DEFAULT 'pending',
  text_chars INTEGER NOT NULL DEFAULT 0,
  summary_status TEXT NOT NULL DEFAULT 'none',
  pending_review INTEGER NOT NULL DEFAULT 0,
  summary_error TEXT,
  summary_model TEXT
);
CREATE VIRTUAL TABLE papers_fts USING fts5(id UNINDEXED, title, authors, venue, abstract, ${TOKENIZER});
CREATE VIRTUAL TABLE chunks_fts USING fts5(paper_id UNINDEXED, chunk_index UNINDEXED, page UNINDEXED, text, ${TOKENIZER});
CREATE VIRTUAL TABLE summaries_fts USING fts5(paper_id UNINDEXED, text, ${TOKENIZER});
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT,
  paper_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

const PAPER_COLUMNS =
  'id, title, authors_label, year, venue, kind, doi, arxiv, metadata_status, has_pdf, problem, added_at, text_status, summary_status, pending_review, summary_model'

/** Rebuildable per-device index. Anything here can be recomputed from the project files. */
export class IndexCache {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): IndexCache {
    mkdirSync(dirname(file), { recursive: true })
    try {
      return new IndexCache(connect(file))
    } catch {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
      return new IndexCache(connect(file))
    }
  }

  close(): void {
    this.db.close()
  }

  upsertPaper(p: Paper, fileHash: string, hasPdf: boolean): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO papers (id, file_hash, title, authors_label, year, venue, kind, doi, arxiv, metadata_status, has_pdf, problem, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET file_hash = excluded.file_hash, title = excluded.title, authors_label = excluded.authors_label,
             year = excluded.year, venue = excluded.venue, kind = excluded.kind, doi = excluded.doi, arxiv = excluded.arxiv,
             metadata_status = excluded.metadata_status, has_pdf = excluded.has_pdf, problem = NULL, added_at = excluded.added_at`
        )
        .run(
          p.id,
          fileHash,
          p.title,
          authorsLabel(p.authors),
          p.year ?? null,
          p.venue ?? null,
          p.kind,
          p.identifiers.doi ?? null,
          p.identifiers.arxiv ?? null,
          p.metadata_status,
          hasPdf ? 1 : 0,
          p.added_at
        )
      this.db.prepare('DELETE FROM papers_fts WHERE id = ?').run(p.id)
      this.db
        .prepare('INSERT INTO papers_fts (id, title, authors, venue, abstract) VALUES (?, ?, ?, ?, ?)')
        .run(p.id, p.title, p.authors.map((a) => `${a.given ?? ''} ${a.family}`).join(' '), p.venue ?? '', p.abstract ?? '')
    })
  }

  setProblem(id: string, fileHash: string, problem: FileProblem): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO papers (id, file_hash, title, problem) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET file_hash = excluded.file_hash, problem = excluded.problem`
        )
        .run(id, fileHash, id, `${problem.kind}: ${problem.message}`)
      this.db.prepare('DELETE FROM papers_fts WHERE id = ?').run(id)
    })
  }

  removePaper(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM papers WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM papers_fts WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM chunks_fts WHERE paper_id = ?').run(id)
      this.db.prepare('DELETE FROM summaries_fts WHERE paper_id = ?').run(id)
    })
  }

  fileHash(id: string): string | null {
    const row = this.db.prepare('SELECT file_hash FROM papers WHERE id = ?').get(id) as { file_hash: string } | undefined
    return row?.file_hash ?? null
  }

  textHash(id: string): string | null {
    const row = this.db.prepare('SELECT text_hash FROM papers WHERE id = ?').get(id) as { text_hash: string | null } | undefined
    return row?.text_hash ?? null
  }

  setText(id: string, textHash: string | null, status: TextStatus, chunks: Chunk[]): void {
    this.tx(() => {
      // The size the too-long check compares with max_input_chars: without the reference list, with page markers.
      const textChars = chunks.length ? buildPaperText(chunks, { maxChars: Infinity }).chars : 0
      this.db.prepare('UPDATE papers SET text_hash = ?, text_status = ?, text_chars = ? WHERE id = ?').run(textHash, status, textChars, id)
      this.db.prepare('DELETE FROM chunks_fts WHERE paper_id = ?').run(id)
      const insert = this.db.prepare('INSERT INTO chunks_fts (paper_id, chunk_index, page, text) VALUES (?, ?, ?, ?)')
      for (const c of chunks) insert.run(id, c.index, c.page, c.text)
    })
  }

  textChars(id: string): number {
    const row = this.db.prepare('SELECT text_chars FROM papers WHERE id = ?').get(id) as { text_chars: number } | undefined
    return row?.text_chars ?? 0
  }

  /** Indexed text of a paper in reading order (the input for summaries). */
  chunksFor(id: string): { page: number | null; text: string }[] {
    return (
      this.db.prepare('SELECT page, text FROM chunks_fts WHERE paper_id = ? ORDER BY CAST(chunk_index AS INTEGER)').all(id) as {
        page: number | null
        text: string
      }[]
    ).map((r) => ({ page: r.page === null ? null : Number(r.page), text: r.text }))
  }

  setSummaryState(id: string, status: SummaryStatus, pending: number, text: string, model: string | null): void {
    this.tx(() => {
      this.db.prepare('UPDATE papers SET summary_status = ?, pending_review = ?, summary_model = ? WHERE id = ?').run(status, pending, model, id)
      this.db.prepare('DELETE FROM summaries_fts WHERE paper_id = ?').run(id)
      if (text) this.db.prepare('INSERT INTO summaries_fts (paper_id, text) VALUES (?, ?)').run(id, text)
    })
  }

  setSummaryError(id: string, code: string | null): void {
    this.db.prepare('UPDATE papers SET summary_error = ? WHERE id = ?').run(code, id)
  }

  summaryError(id: string): string | null {
    const row = this.db.prepare('SELECT summary_error FROM papers WHERE id = ?').get(id) as { summary_error: string | null } | undefined
    return row?.summary_error ?? null
  }

  paperIds(): string[] {
    return (this.db.prepare('SELECT id FROM papers ORDER BY id').all() as { id: string }[]).map((r) => r.id)
  }

  listPapers(): PaperRow[] {
    return (this.db.prepare(`SELECT ${PAPER_COLUMNS} FROM papers ORDER BY added_at DESC, id`).all() as Record<string, unknown>[]).map(toPaperRow)
  }

  getPaper(id: string): PaperRow | null {
    const row = this.db.prepare(`SELECT ${PAPER_COLUMNS} FROM papers WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? toPaperRow(row) : null
  }

  /** Paper ids best match first. Metadata hits weigh twice as much as full-text hits. */
  search(query: string, limit = 50): string[] {
    const words = query.match(/[\p{L}\p{N}]+/gu)
    if (!words) return []
    const match = words.map((w) => `"${w}"*`).join(' ')
    const rows = this.db
      .prepare(
        `SELECT id, MIN(score) AS score FROM (
           SELECT id, bm25(papers_fts) * 2 AS score FROM papers_fts WHERE papers_fts MATCH ?
           UNION ALL
           SELECT paper_id AS id, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ?
           UNION ALL
           SELECT paper_id AS id, bm25(summaries_fts) * 1.5 AS score FROM summaries_fts WHERE summaries_fts MATCH ?
         ) GROUP BY id ORDER BY score LIMIT ?`
      )
      .all(match, match, match, limit) as { id: string }[]
    return rows.map((r) => r.id)
  }

  dedupeEntries(): DedupeEntry[] {
    return this.db.prepare('SELECT id, doi, arxiv, title FROM papers WHERE problem IS NULL ORDER BY id').all() as unknown as DedupeEntry[]
  }

  insertJob(spec: string, now: string): number {
    const result = this.db.prepare("INSERT INTO jobs (spec, state, created_at, updated_at) VALUES (?, 'queued', ?, ?)").run(spec, now, now)
    return Number(result.lastInsertRowid)
  }

  updateJob(id: number, fields: { state?: JobState; message?: string | null; paper_id?: string | null }, now: string): void {
    const current = this.getJob(id)
    if (!current) return
    this.db
      .prepare('UPDATE jobs SET state = ?, message = ?, paper_id = ?, updated_at = ? WHERE id = ?')
      .run(fields.state ?? current.state, fields.message !== undefined ? fields.message : current.message, fields.paper_id !== undefined ? fields.paper_id : current.paper_id, now, id)
  }

  getJob(id: number): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null
  }

  nextQueuedJob(excludeTypes: string[] = []): JobRow | null {
    const filter = excludeTypes.length ? ` AND json_extract(spec, '$.type') NOT IN (${excludeTypes.map(() => '?').join(', ')})` : ''
    return (this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued'${filter} ORDER BY id LIMIT 1`).get(...excludeTypes) as JobRow | undefined) ?? null
  }

  cancelQueuedBatch(batchId: string, now: string): number {
    const r = this.db
      .prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE state = 'queued' AND json_extract(spec, '$.batchId') = ?")
      .run(now, batchId)
    return Number(r.changes)
  }

  hasActiveJob(type: string, paperId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND json_extract(spec, '$.type') = ? AND json_extract(spec, '$.paperId') = ? LIMIT 1")
        .get(type, paperId)
    )
  }

  listJobs(limit = 50): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as JobRow[]
  }

  /** Jobs left running by a crash or a quit go back to the queue. */
  requeueRunningJobs(now: string): void {
    this.db.prepare("UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'").run(now)
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function connect(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (user_version !== SCHEMA_VERSION) {
      if (user_version !== 0) throw new Error('Stale cache schema')
      db.exec(DDL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function toPaperRow(r: Record<string, unknown>): PaperRow {
  return {
    id: r.id as string,
    title: r.title as string,
    authors_label: (r.authors_label as string | null) ?? '',
    year: (r.year as number | null) ?? null,
    venue: (r.venue as string | null) ?? null,
    kind: (r.kind as string | null) ?? null,
    doi: (r.doi as string | null) ?? null,
    arxiv: (r.arxiv as string | null) ?? null,
    metadata_status: (r.metadata_status as string | null) ?? null,
    has_pdf: Boolean(r.has_pdf),
    problem: (r.problem as string | null) ?? null,
    added_at: (r.added_at as string | null) ?? null,
    text_status: r.text_status as TextStatus,
    summary_status: (r.summary_status as SummaryStatus) ?? 'none',
    pending_review: Number(r.pending_review ?? 0),
    summary_model: (r.summary_model as string | null) ?? null
  }
}
