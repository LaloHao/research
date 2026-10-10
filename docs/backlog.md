# Backlog

## Parked ideas (functionality)

- Reorder facets in the extraction form editor.
- Have Claude suggest facets (and values) from the thesis's context.
- Git sync from the app: a "Sincronizar" button that pulls, commits and pushes the project folder (git or git LFS for PDFs), shows the last sync time, warns when there are unpushed changes before closing, and reports conflicts clearly (the app already refuses to overwrite files with conflict markers). Today syncing between computers is done by hand with `git pull` / `git commit` / `git push`.

## Upcoming stages

- Stage 3b: typed relations between papers suggested by Claude (`extends`, `uses_method_of`, `compares_with`, `contradicts`, `replicates`, `same_problem`) over stage 3a's candidates (citations and similar pairs), with a review flow like summaries.
- Principle for every future LLM use (3b, chat): Claude gets **read-only tools** over the library (full-text search, semantic search, grep over the project files, reading a paper's pages, reading a summary and its facets, querying citations and neighbours) and never write tools; in 3b the relation suggester uses them to look for evidence.
- Stage 4: chat (per paper and global) over the library.
- Stage 5: formal systematic mapping.

## Stage 2 technical minutiae

- The PDF viewer reloads the whole document every time focus changes within the same paper.
- Library bar: the "Modelo del lote" and "Regenerar filtrados con…" selectors use the first option as their label; review visually.
- Evidence: a single-word quote counts as found if that word appears anywhere; consider a minimum length.
- Writes: if `writeExtraction` fails for something other than a conflict, the write can end up half-done; `save()` writes extraction and summary without joint atomicity.
- Masked errors: a failure while logging to the cost ledger or while reindexing inside a `catch`/`finally` can hide the original error.
- Cost entries for failed calls log the model alias, not the full id.
- `appendCost` uses `appendFile`; a cut-off line is ignored on read.
- Batch: a batch's spend lives in memory; after a restart, a batch's re-queued jobs get a fresh cap. A summary that finishes while the app is closing can go back to the queue and be paid for again.
- Verify/edit carries no version token: if the paper is regenerated while you're reviewing it, "Verificar" can mark a value you never saw.
- `PROMPT_VERSION` wasn't bumped when thesis context was added.
- `summarySearchText` doesn't include facet scoring; moving from edited to verified loses the edit's provenance (by design).
- IPC validation: `ipcArgs.force` is unused; nested RQ items aren't strictly typed; `mapProposed` validates `from`/`to` as free text.
- Unknown keys inside `llm:` in project.yaml are silently dropped on write.
- Eval (`pnpm eval:summaries`): doesn't clean up its temp folders; `vitest.eval.config` isn't in the tsconfig's `include`.
- Watcher test: fixed 700 ms wait before the external edit.

## Stage 3a technical minutiae

- The full neighbour recompute (end of a batch, project open) is brute force on the main process, yielding every 50 rows; single changes are incremental. Beyond a few thousand papers, move the full pass to a worker.
- The incremental update keeps an in-memory snapshot of each paper's signals; after a restart the first change waits for the startup full recompute.
- The graph keeps node positions while the set of papers is the same; adding or removing papers re-runs fcose from the current positions.
- The local model is downloaded through the open project's job queue (a project must be open); an app-level download would not need one.
- The embeddings utility process stays alive once started; shut it down after a period without embed jobs to free its memory.
- The graph exports PNG only (no maintained SVG exporter for cytoscape); charts export SVG, PNG and CSV.
- Packaging is out of scope: a packaged build would need `asarUnpack` for `onnxruntime-node` and the embeddings worker.
- Works OpenAlex did not return are stored as empty rows in `external_works` and never requested again until the cache is rebuilt.
- A citations job and a metadata update writing the same paper.yaml at once: the later one fails with `conflict` and has to be retried.
- The OpenAlex citation fixtures are committed trimmed; re-recording them means updating the citation tests' expectations.
- "Aplicar los filtros de la biblioteca" uses the rows visible the last time the library was shown, not live filters.
- `CONTENT_FLOOR` (0.75) and `WEIGHTS` are first guesses until `pnpm eval:similarity` runs on the real project.
- Candidates' metadata is cached in `external_works`; a refresh only fetches ids still missing from the cache, not the whole candidate list.
- If a similarity batch is cancelled partway through, the full recompute it would have ended with is skipped; it runs instead on the next single paper change.
- Model download cancellation is only checked before and after the whole download, not mid-transfer, so cancelling can take a while to take effect.
- An embed request that arrives while the model is downloading and no embedder is loaded yet can leave an orphan ONNX session in the embeddings worker (`worker.ts`, the lazy embedder load).
- Two library papers sharing one OpenAlex id (e.g. a preprint and its published version) make their neighbours depend on the order the papers are processed in.
- A candidates run (its metadata batches) cannot be aborted when the project closes; closing waits for the current request.
- Two different candidate queries running at once can fetch the same missing ids twice.
- A cancelled model download leaves its `.tmp` files behind, and they count in the model's size on disk until the next download.
- The local-model Download/Delete buttons in Settings aren't disabled while a download or delete is in flight (repeated clicks are harmless but can look unresponsive).
- When a paper's stored OpenAlex id points to a work whose DOI differs from the paper's, the citation fetch falls back to the DOI but doesn't correct `identifiers.openalex`, so later metadata updates refetch citations again (two requests each time).
- After a DOI change, the old work's incoming citations stay cached and "Buscar quién cita a mis papers" skips the paper for up to 7 days.
