import { PAPER_KEY } from '../../shared/chat'
import type { ChapterBib, OutlineData, OutlineScope, WritingLibrary } from '../../shared/writing/api'
import type { CiteCheckPlan, CiteCheckProgress, CiteCheckRequest, CiteCheckResult } from '../../shared/writing/citeCheck'
import { chapterBibReport, type BibLibraryPaper } from '../../shared/writing/bibtex'
import { citedKeys, parseCitations, type CiteFormat } from '../../shared/writing/citations'
import type { OutlinePaper } from '../../shared/writing/outline'
import type { IndexCache } from '../cache/IndexCache'
import { rekeyBibtex } from '../ingest/bibtex'
import type { ProjectStore } from '../project/ProjectStore'
import { UserFacingError } from '../library/UserFacingError'
import { loadForm } from '../summary/extractionForm'
import type { CiteChecker } from './CiteChecker'
import { readWithIncludes } from './includes'

export interface WritingDeps {
  store: ProjectStore
  cache: IndexCache
  /** A mapping's papers included on full text («los incluidos de un mapeo»). */
  includedPapers: (mappingId: string) => string[]
  /** «Verificar con Claude»; absent where no Claude is wired (tests of the reads). */
  checker?: CiteChecker
}

/**
 * The writing view's reads: which keys the library knows, the chapter .bib, and the outline's data. Read-only: nothing
 * here writes to the project (drafts, when they come, go through ProjectStore like every other write).
 *
 * A later Claude-powered tab (cost kinds `draft`, `cite_check`, `outline`, `style`) runs one confirmed, capped
 * operation the way the chat and the suggesters do: a plan IPC answers `operationPlan(deps, kind)` (estimate, that kind's
 * cap, the month), the renderer asks, the run IPC checks `ipcArgs.confirmed` and wraps the provider call in
 * `runCappedOperation` (both in ../llm/cappedOperation.ts), which admits, caps, logs the cost and settles.
 */
export class WritingService {
  /** The window's running citation check: one at a time, stopped by «Detener» or when the project closes. */
  private check: { controller: AbortController; progress: CiteCheckProgress | null; done: Promise<unknown> } | null = null
  private closed = false

  constructor(private readonly deps: WritingDeps) {}

  private checker(): CiteChecker {
    if (!this.deps.checker || this.closed) throw new UserFacingError('llm_unavailable')
    return this.deps.checker
  }

  /** What «Verificar con Claude» would check and cost, for the confirmation. */
  citeCheckPlan(text: string, format: CiteFormat): Promise<CiteCheckPlan> {
    return this.checker().plan(text, format)
  }

  /**
   * One citation check of `text`, for any caller (the window, or a local API): the structured result, never written
   * anywhere. The caller has confirmed the cost; `signal` stops it (the result then says `stopped`).
   */
  citeCheck(req: CiteCheckRequest, opts: { signal?: AbortSignal; onProgress?: (p: CiteCheckProgress) => void } = {}): Promise<CiteCheckResult> {
    return this.checker().run({ ...req, ...opts })
  }

  /** The window's check: a new one stops the previous one; its progress is polled with `checkProgress`. */
  async windowCheck(req: CiteCheckRequest): Promise<CiteCheckResult> {
    this.check?.controller.abort()
    const controller = new AbortController()
    const entry: NonNullable<WritingService['check']> = { controller, progress: null, done: Promise.resolve() }
    this.check = entry
    const run = this.citeCheck(req, { signal: controller.signal, onProgress: (p) => (entry.progress = p) })
    entry.done = run.catch(() => undefined)
    try {
      return await run
    } finally {
      if (this.check === entry) this.check = null
    }
  }

  checkProgress(): CiteCheckProgress | null {
    return this.check?.progress ?? null
  }

  /** «Detener»: the batches answered so far are kept. */
  stopCheck(): void {
    this.check?.controller.abort()
  }

  /** The project closes: the running check stops. */
  async close(): Promise<void> {
    this.closed = true
    const running = this.check
    running?.controller.abort()
    await running?.done
  }

  library(): WritingLibrary {
    const { cache } = this.deps
    return {
      papers: cache
        .listPapers()
        .filter((r) => !r.problem)
        .map((r) => ({ id: r.id, title: r.title, year: r.year, hasText: r.text_status === 'ok' })),
      trashed: cache.trashEntries().map((t) => ({ id: t.id, title: t.title }))
    }
  }

  /** «BibTeX» of pasted text. */
  async bibFromText(text: string, format: CiteFormat): Promise<ChapterBib> {
    const citations = parseCitations(text, format)
    return { report: await this.report(citedKeys(citations)), files: [], skipped: [], citations: citations.length }
  }

  /** «BibTeX» of a chosen file and what it includes inside its folder. */
  async bibFromFile(path: string): Promise<ChapterBib> {
    const read = await readWithIncludes(path)
    return { report: await this.report(read.keys), files: read.files, skipped: read.skipped, citations: read.citations }
  }

  /** The cited entries as the library exports them (rekeyed), plus every paper's title for suggestions. */
  private async report(keys: string[]): Promise<ChapterBib['report']> {
    const { store, cache } = this.deps
    const library = new Map<string, BibLibraryPaper>()
    for (const row of cache.listPapers()) if (!row.problem) library.set(row.id, { title: row.title, bibtex: null })
    for (const key of keys) {
      const paper = library.get(key)
      if (!paper || !PAPER_KEY.test(key)) continue
      try {
        const read = await store.readPaper(key)
        if (read.ok) paper.bibtex = rekeyBibtex(read.value.bibtex, key)
      } catch {
        // An invalid entry is left out, as in exports/library.bib; the report lists it.
      }
    }
    return chapterBibReport({ keys, library, trashed: cache.trashedIds() })
  }

  /** «Esquema»: the form's facets, each paper's facet values and one-liner, and the confirmed relations among them. */
  async outlineData(scope: OutlineScope): Promise<OutlineData> {
    const { store, cache } = this.deps
    const form = loadForm(store.config.extraction_form)
    const facets =
      form.status === 'ok' ? form.form.facets.flatMap((f) => (f.type === 'single' || f.type === 'multi' ? [{ key: f.key, values: [...f.values] }] : [])) : []
    const rows = cache.listPapers().filter((r) => !r.problem)
    const wanted = scope.kind === 'library' ? null : new Set(scope.kind === 'papers' ? scope.ids : this.deps.includedPapers(scope.mappingId))
    const papers = new Map<string, OutlinePaper>()
    for (const r of rows) if (!wanted || wanted.has(r.id)) papers.set(r.id, { id: r.id, title: r.title, year: r.year, tldr: null, facets: {} })
    for (const f of cache.facetRows()) {
      const p = papers.get(f.paperId)
      if (!p) continue
      const entry = (p.facets[f.facet] ??= { values: [], reviewed: f.reviewed })
      entry.values.push(f.value)
    }
    for (const p of papers.values()) {
      const read = await store.readSummary(p.id).catch(() => null)
      const tldr = read?.ok ? read.value.fields.tldr.value.trim() : ''
      p.tldr = tldr || null
    }
    const relations = cache
      .typedRelations()
      .filter((r) => r.status === 'confirmed' && papers.has(r.from) && papers.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, type: r.type }))
    return { facets, papers: [...papers.values()], relations }
  }
}
