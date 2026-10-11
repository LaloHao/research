# Backlog

## Parked ideas (functionality)

- Reorder facets in the extraction form editor.
- Remove papers with a trash (next, right after stage 3b): today the app has no way to remove a paper. "Quitar de la biblioteca" moves `papers/<key>/` (PDF, summary, extraction, notes) to `.trash/<key>/` inside the project, its relations and dismissals stay recoverable, and a Papelera view restores or empties it (emptying asks for confirmation). Removing never deletes data silently.
- Personal shared library across projects (after stages 4–5): a store outside the projects (app data folder or a user-chosen, git-synced folder) keyed by DOI/arXiv/OpenAlex/PDF hash, holding PDFs and analyses. Adding a paper to any project offers to reuse what is compatible: summary fields when the content language matches, facets whose definition is identical, never the thesis relation; verified/edited statuses kept (optionally re-review). Papers removed from a project stay there.
- Git sync from the app (next, right after the trash): a "Sincronizar" button that pulls, commits and pushes the project folder (git or git LFS for PDFs), shows the last sync time, warns about unpushed changes before closing, resolves automatically the files the app knows how to merge (relations.yaml, per-device costs/, dismissed lists) and asks the user to pick a version for the rest (e.g. a summary edited on both machines). In the stage 4 chat, a separate MCP server used only for syncing, enabled per conversation and always behind the user's approval (it is not part of the read-only library tools). Today syncing between computers is done by hand with `git pull` / `git commit` / `git push`.

## Upcoming stages

- Stage 3c: Claude suggests facets (and values) from the thesis context and the papers, reusing the read-only library MCP server and agent runner of stage 3b; suggestions reviewed like the summaries' proposed values.
- Principle for every future LLM use (3b, 3c, chat): Claude gets **read-only tools** over the library (full-text search, semantic search, grep over the project files, reading a paper's pages, reading a summary and its facets, querying citations and neighbours) and never write tools; the 3b relation suggester already uses them (src/main/mcp/).
- Stage 4: chat (per paper and global) over the library.
- Stage 5: formal systematic mapping. Design decision already taken: a project can hold **several mappings** (each with its own protocol, research questions, inclusion/exclusion criteria, search log and screening) over one shared library, so papers, PDFs and summaries are never analysed twice; excluding a paper from one mapping never removes it from the library.

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

## Stage 3b technical minutiae

- The installed `claude` CLI does not list `--max-turns` in `--help`; `src/main/llm/agentCliFlags.ts` records what the real verification run proved (the `--allowedTools` form, the permission flags and whether `--max-turns` exists). Either way the turn cap is enforced by the MCP server's budget of 12 tool calls per run, plus a 10-minute timeout and `--max-budget-usd`. Regenerate that file with the verification script after a CLI upgrade.
- Which candidates each paper was analyzed with lives in `relations.yaml` (`analyzed`), so a rebuilt cache never re-spends; removing a paper leaves its `analyzed` entry behind (harmless).
- A relation id is the unordered pair plus the type, so `A extends B` and `B extends A` share an id: reversing a direction keeps the id.
- A batch plan counts both papers of a new pair; at run time the second one skips the pair, so the estimate can be higher than the real cost.
- Relations of a paper removed from the library stay in `relations.yaml`; their other end shows the key instead of a title.
- A relation suggestion is not retried on invalid output (an agent run is expensive).
- `find_in_paper` searches literal text only (no model-supplied regular expressions run in the main process); it folds case and accents per character, so a ligature split across a line break may not match.
- The MCP server is stateless: a new `McpServer` per HTTP request, with the call budget kept outside.
- Undo tokens live in the main process (the last 100 decisions) and are lost on restart; an undo deep-compares the entry with what the decision left (timestamps compared as instants), so any change since refuses it.
- A timed-out or cancelled agent or summary call is charged at the per-paper cap (`estimated: true` in `costs/`), which overstates calls cut off early; the CLI gives no partial cost.
- The automatic trigger's 24-hour pause after a failed analysis lives in memory, so restarting the app lets it try that paper again.
- Runs that fail with `operation_budget` or `llm_invalid_output` leave no `analyzed` record, so the automatic trigger retries them after its 24-hour in-memory pause (bounded by the daily batch cap).
- If `relations.yaml` gets conflict markers while an agent run is in progress, the paid result is discarded (`relations_conflict`) and the paper must be analyzed again after resolving.
- An invalid (unparseable) `relations.yaml` reports `relations_conflict`, whose text ("conflicto de git o un error") is vague for that case.
- The paper's button upgrades a queued unforced analysis in place (its job spec is rewritten and it leaves its batch), so that job no longer counts toward the batch cap.
- Evidence of confirmed relations is not re-checked when a paper's text changes (a new PDF).
- The review mode loads a relation item with three requests (the paper's relations and both papers' details), one after another.
- Candidates use only the stored neighbours; a paper added after the last neighbour recompute is a candidate only once the neighbours are updated.

## Paper trash technical minutiae

- Removing a paper drops it from its neighbours' lists without backfilling: a paper that had it in its top 10 shows 9 neighbours until the next full recompute (end of a batch, project open).
