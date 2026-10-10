import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { authorsLabel } from '../../shared/format'
import type { JobState } from '../../shared/jobs'
import type { PaperRow, TextStatus } from '../../shared/library'
import type { Citations, CitationsStatus, ExternalWork, SimilarityReason } from '../../shared/relations'
import type { Paper } from '../../shared/schemas'
import type { SummaryStatus } from '../../shared/summary'
import { TypedRelationSchema, type TypedRelation } from '../../shared/typedRelations'
import type { Chunk } from '../extract/chunker'
import type { DedupeEntry } from '../library/dedupe'
import type { FacetRow, FacetValueRow } from '../map/facetStats'
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

// 5: citations, external works, vectors, neighbours and facet values (stage 3a). 6: when citing works were fetched.
// 7: typed relations, an index of relations.yaml (stage 3b).
const SCHEMA_VERSION = 7
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
  summary_model TEXT,
  openalex_id TEXT,
  citations_status TEXT NOT NULL DEFAULT 'none',
  cited_by_count INTEGER,
  citations_fetched_at TEXT,
  thesis_score INTEGER
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
CREATE TABLE citation_edges (citing_id TEXT NOT NULL, cited_openalex_id TEXT NOT NULL, PRIMARY KEY (citing_id, cited_openalex_id));
CREATE INDEX citation_edges_cited ON citation_edges (cited_openalex_id);
CREATE TABLE incoming_citations (cited_paper_id TEXT NOT NULL, citing_openalex_id TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (cited_paper_id, citing_openalex_id));
CREATE TABLE incoming_fetches (paper_id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL);
CREATE TABLE external_works (openalex_id TEXT PRIMARY KEY, title TEXT, year INTEGER, authors TEXT NOT NULL DEFAULT '', doi TEXT, cited_by_count INTEGER, fetched_at TEXT NOT NULL);
CREATE TABLE paper_vectors (paper_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
CREATE TABLE similar_pairs (a TEXT NOT NULL, b TEXT NOT NULL, score REAL NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE paper_facets (paper_id TEXT NOT NULL, facet TEXT NOT NULL, value TEXT NOT NULL, reviewed INTEGER NOT NULL, PRIMARY KEY (paper_id, facet, value));
CREATE TABLE typed_relations (id TEXT PRIMARY KEY, type TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX typed_relations_from ON typed_relations (from_id);
CREATE INDEX typed_relations_to ON typed_relations (to_id);
`

const PAPER_COLUMNS =
  'id, title, authors_label, year, venue, kind, doi, arxiv, metadata_status, has_pdf, problem, added_at, text_status, summary_status, pending_review, summary_model, citations_status, ' +
  "(SELECT COUNT(*) FROM typed_relations r WHERE r.status = 'suggested' AND (r.from_id = papers.id OR r.to_id = papers.id)) AS relations_pending"

export interface RelationRow {
  id: string
  title: string
  year: number | null
  doi: string | null
  openalex_id: string | null
  cited_by_count: number | null
  citations_status: CitationsStatus
  thesis_score: number | null
}

function citationsStatus(c: Citations | undefined): CitationsStatus {
  return !c ? 'none' : c.unresolved ? 'unresolved' : 'ok'
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

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
          `INSERT INTO papers (id, file_hash, title, authors_label, year, venue, kind, doi, arxiv, metadata_status, has_pdf, problem, added_at,
             openalex_id, citations_status, cited_by_count, citations_fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET file_hash = excluded.file_hash, title = excluded.title, authors_label = excluded.authors_label,
             year = excluded.year, venue = excluded.venue, kind = excluded.kind, doi = excluded.doi, arxiv = excluded.arxiv,
             metadata_status = excluded.metadata_status, has_pdf = excluded.has_pdf, problem = NULL, added_at = excluded.added_at,
             openalex_id = excluded.openalex_id, citations_status = excluded.citations_status, cited_by_count = excluded.cited_by_count,
             citations_fetched_at = excluded.citations_fetched_at`
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
          p.added_at,
          p.citations?.openalex_id ?? p.identifiers.openalex ?? null,
          citationsStatus(p.citations),
          p.citations?.cited_by_count ?? null,
          p.citations?.fetched_at ?? null
        )
      this.db.prepare('DELETE FROM papers_fts WHERE id = ?').run(p.id)
      this.db
        .prepare('INSERT INTO papers_fts (id, title, authors, venue, abstract) VALUES (?, ?, ?, ?, ?)')
        .run(p.id, p.title, p.authors.map((a) => `${a.given ?? ''} ${a.family}`).join(' '), p.venue ?? '', p.abstract ?? '')
      this.db.prepare('DELETE FROM citation_edges WHERE citing_id = ?').run(p.id)
      const edge = this.db.prepare('INSERT OR IGNORE INTO citation_edges (citing_id, cited_openalex_id) VALUES (?, ?)')
      for (const ref of p.citations?.references ?? []) edge.run(p.id, ref)
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
      this.db.prepare('DELETE FROM citation_edges WHERE citing_id = ?').run(id)
      this.db.prepare('DELETE FROM incoming_citations WHERE cited_paper_id = ?').run(id)
      this.db.prepare('DELETE FROM incoming_fetches WHERE paper_id = ?').run(id)
      this.db.prepare('DELETE FROM paper_vectors WHERE paper_id = ?').run(id)
      this.db.prepare('DELETE FROM similar_pairs WHERE a = ? OR b = ?').run(id, id)
      this.db.prepare('DELETE FROM paper_facets WHERE paper_id = ?').run(id)
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

  relationRows(): RelationRow[] {
    return (
      this.db
        .prepare('SELECT id, title, year, doi, openalex_id, cited_by_count, citations_status, thesis_score FROM papers WHERE problem IS NULL ORDER BY id')
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      year: num(r.year),
      doi: (r.doi as string | null) ?? null,
      openalex_id: (r.openalex_id as string | null) ?? null,
      cited_by_count: num(r.cited_by_count),
      citations_status: (r.citations_status as CitationsStatus | null) ?? 'none',
      thesis_score: num(r.thesis_score)
    }))
  }

  /** Edges of readable papers only: a paper.yaml with a problem keeps its old edges in the table but they do not count. */
  citationEdges(): { citing: string; cited: string }[] {
    return this.db
      .prepare(
        `SELECT e.citing_id AS citing, e.cited_openalex_id AS cited FROM citation_edges e JOIN papers p ON p.id = e.citing_id
         WHERE p.problem IS NULL ORDER BY e.citing_id, e.cited_openalex_id`
      )
      .all() as unknown as { citing: string; cited: string }[]
  }

  setIncoming(paperId: string, citing: string[], fetchedAt: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM incoming_citations WHERE cited_paper_id = ?').run(paperId)
      const insert = this.db.prepare('INSERT OR IGNORE INTO incoming_citations (cited_paper_id, citing_openalex_id, fetched_at) VALUES (?, ?, ?)')
      for (const id of citing) insert.run(paperId, id, fetchedAt)
      // Recorded apart from the edges: a paper nobody cites has none but was still looked up.
      this.db
        .prepare('INSERT INTO incoming_fetches (paper_id, fetched_at) VALUES (?, ?) ON CONFLICT(paper_id) DO UPDATE SET fetched_at = excluded.fetched_at')
        .run(paperId, fetchedAt)
    })
  }

  /** When the citing works of each paper were last fetched. */
  incomingFetchedAt(): Map<string, string> {
    const rows = this.db.prepare('SELECT paper_id, fetched_at FROM incoming_fetches').all() as { paper_id: string; fetched_at: string }[]
    return new Map(rows.map((r) => [r.paper_id, r.fetched_at]))
  }

  incomingEdges(): { paperId: string; citing: string }[] {
    return this.db
      .prepare('SELECT cited_paper_id AS paperId, citing_openalex_id AS citing FROM incoming_citations ORDER BY cited_paper_id, citing_openalex_id')
      .all() as unknown as { paperId: string; citing: string }[]
  }

  upsertExternalWorks(works: ExternalWork[], fetchedAt: string): void {
    this.tx(() => {
      const upsert = this.db.prepare(
        `INSERT INTO external_works (openalex_id, title, year, authors, doi, cited_by_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(openalex_id) DO UPDATE SET title = excluded.title, year = excluded.year, authors = excluded.authors, doi = excluded.doi,
           cited_by_count = excluded.cited_by_count, fetched_at = excluded.fetched_at`
      )
      for (const w of works) upsert.run(w.openalexId, w.title, w.year, w.authors, w.doi, w.citedByCount, fetchedAt)
    })
  }

  externalWorks(ids: string[]): Map<string, ExternalWork> {
    const out = new Map<string, ExternalWork>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const rows = this.db
        .prepare(`SELECT openalex_id, title, year, authors, doi, cited_by_count FROM external_works WHERE openalex_id IN (${chunk.map(() => '?').join(', ')})`)
        .all(...chunk) as Record<string, unknown>[]
      for (const r of rows) {
        out.set(r.openalex_id as string, {
          openalexId: r.openalex_id as string,
          title: (r.title as string | null) ?? null,
          year: num(r.year),
          authors: (r.authors as string) ?? '',
          doi: (r.doi as string | null) ?? null,
          citedByCount: num(r.cited_by_count)
        })
      }
    }
    return out
  }

  setVector(paperId: string, inputHash: string, model: string, vector: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO paper_vectors (paper_id, input_hash, model, dims, vector) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET input_hash = excluded.input_hash, model = excluded.model, dims = excluded.dims, vector = excluded.vector`
      )
      .run(paperId, inputHash, model, vector.length, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
  }

  vectorMeta(paperId: string): { inputHash: string; model: string } | null {
    const row = this.db.prepare('SELECT input_hash, model FROM paper_vectors WHERE paper_id = ?').get(paperId) as { input_hash: string; model: string } | undefined
    return row ? { inputHash: row.input_hash, model: row.model } : null
  }

  /** Vectors made with `model`; vectors of another model are ignored (they get recomputed). */
  vectors(model: string): Map<string, Float32Array> {
    const rows = this.db.prepare('SELECT paper_id, vector FROM paper_vectors WHERE model = ?').all(model) as { paper_id: string; vector: Uint8Array }[]
    // Copy into a fresh buffer: the BLOB's offset is not guaranteed to be 4-byte aligned.
    return new Map(rows.map((r) => [r.paper_id, new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength))]))
  }

  clearVectors(): void {
    this.db.exec('DELETE FROM paper_vectors')
  }

  replaceSimilar(pairs: { a: string; b: string; score: number; reasons: SimilarityReason[] }[]): void {
    this.tx(() => {
      this.db.exec('DELETE FROM similar_pairs')
      const insert = this.db.prepare('INSERT OR REPLACE INTO similar_pairs (a, b, score, reasons) VALUES (?, ?, ?, ?)')
      for (const p of pairs) insert.run(p.a, p.b, p.score, JSON.stringify(p.reasons))
    })
  }

  /** Rewrites only the rows of the given papers (incremental update); an empty list removes that paper's row. */
  setSimilarRows(rows: Map<string, { a: string; b: string; score: number; reasons: SimilarityReason[] }[]>): void {
    this.tx(() => {
      const remove = this.db.prepare('DELETE FROM similar_pairs WHERE a = ?')
      const insert = this.db.prepare('INSERT OR REPLACE INTO similar_pairs (a, b, score, reasons) VALUES (?, ?, ?, ?)')
      for (const [a, row] of rows) {
        remove.run(a)
        for (const p of row) insert.run(a, p.b, p.score, JSON.stringify(p.reasons))
      }
    })
  }

  similarFor(id: string): { other: string; score: number; reasons: SimilarityReason[] }[] {
    return (this.db.prepare('SELECT b, score, reasons FROM similar_pairs WHERE a = ? ORDER BY score DESC, b').all(id) as { b: string; score: number; reasons: string }[]).map(
      (r) => ({ other: r.b, score: Number(r.score), reasons: JSON.parse(r.reasons) as SimilarityReason[] })
    )
  }

  allSimilar(): { a: string; b: string; score: number; reasons: SimilarityReason[] }[] {
    return (this.db.prepare('SELECT a, b, score, reasons FROM similar_pairs ORDER BY a, score DESC, b').all() as { a: string; b: string; score: number; reasons: string }[]).map(
      (r) => ({ a: r.a, b: r.b, score: Number(r.score), reasons: JSON.parse(r.reasons) as SimilarityReason[] })
    )
  }

  setFacets(id: string, rows: FacetValueRow[], thesisScore: number | null): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM paper_facets WHERE paper_id = ?').run(id)
      const insert = this.db.prepare('INSERT OR IGNORE INTO paper_facets (paper_id, facet, value, reviewed) VALUES (?, ?, ?, ?)')
      for (const r of rows) insert.run(id, r.facet, r.value, r.reviewed ? 1 : 0)
      this.db.prepare('UPDATE papers SET thesis_score = ? WHERE id = ?').run(thesisScore, id)
    })
  }

  facetRows(): FacetRow[] {
    return (
      this.db
        .prepare(
          `SELECT f.paper_id, f.facet, f.value, f.reviewed, p.year FROM paper_facets f JOIN papers p ON p.id = f.paper_id
           WHERE p.problem IS NULL ORDER BY f.paper_id, f.facet, f.value`
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({ paperId: r.paper_id as string, facet: r.facet as string, value: r.value as string, reviewed: Boolean(r.reviewed), year: num(r.year) }))
  }

  /** Mirrors relations.yaml: the whole table is replaced on every (re)index. */
  replaceTypedRelations(relations: TypedRelation[]): void {
    this.tx(() => {
      this.db.exec('DELETE FROM typed_relations')
      const insert = this.db.prepare('INSERT OR REPLACE INTO typed_relations (id, type, from_id, to_id, status, data) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of relations) insert.run(r.id, r.type, r.from, r.to, r.status, JSON.stringify(r))
    })
  }

  /** Sorted by id; with `paperId`, only the relations that involve that paper. */
  typedRelations(paperId?: string): TypedRelation[] {
    const rows = (
      paperId
        ? this.db.prepare('SELECT data FROM typed_relations WHERE from_id = ? OR to_id = ? ORDER BY id').all(paperId, paperId)
        : this.db.prepare('SELECT data FROM typed_relations ORDER BY id').all()
    ) as { data: string }[]
    return rows.flatMap((r) => {
      const parsed = TypedRelationSchema.safeParse(JSON.parse(r.data))
      return parsed.success ? [parsed.data] : []
    })
  }

  /** Full-text hits over the indexed chunks, best first; every word must appear (prefix match). */
  searchChunks(query: string, opts: { paperId?: string; limit: number }): { paperId: string; page: number | null; text: string }[] {
    const words = query.match(/[\p{L}\p{N}]+/gu)
    if (!words) return []
    const match = words.map((w) => `"${w}"*`).join(' ')
    const filter = opts.paperId ? ' AND paper_id = ?' : ''
    const params = opts.paperId ? [match, opts.paperId, opts.limit] : [match, opts.limit]
    const rows = this.db
      .prepare(`SELECT paper_id, page, text FROM chunks_fts WHERE chunks_fts MATCH ?${filter} ORDER BY bm25(chunks_fts) LIMIT ?`)
      .all(...params) as { paper_id: string; page: number | null; text: string }[]
    return rows.map((r) => ({ paperId: r.paper_id, page: r.page === null ? null : Number(r.page), text: r.text }))
  }

  hasQueuedJobs(types: string[]): boolean {
    if (types.length === 0) return false
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM jobs WHERE state = 'queued' AND json_extract(spec, '$.type') IN (${types.map(() => '?').join(', ')}) LIMIT 1`)
        .get(...types)
    )
  }

  hasActiveJobOfType(type: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND json_extract(spec, '$.type') = ? LIMIT 1").get(type))
  }

  cancelQueuedTypes(types: string[], now: string): number {
    if (types.length === 0) return 0
    const r = this.db
      .prepare(`UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE state = 'queued' AND json_extract(spec, '$.type') IN (${types.map(() => '?').join(', ')})`)
      .run(now, ...types)
    return Number(r.changes)
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

  /** Queued or running jobs of `type` for `paperId`, oldest first. */
  activeJobs(type: string, paperId: string): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('queued', 'running') AND json_extract(spec, '$.type') = ? AND json_extract(spec, '$.paperId') = ? ORDER BY id")
      .all(type, paperId) as unknown as JobRow[]
  }

  updateJobSpec(id: number, spec: string, now: string): void {
    this.db.prepare('UPDATE jobs SET spec = ?, updated_at = ? WHERE id = ?').run(spec, now, id)
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
    summary_model: (r.summary_model as string | null) ?? null,
    citations_status: (r.citations_status as CitationsStatus | undefined) ?? 'none',
    relations_pending: Number(r.relations_pending ?? 0)
  }
}
