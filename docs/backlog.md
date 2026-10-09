# Backlog

## Parked ideas (functionality)

- Reorder facets in the extraction form editor.
- Have Claude suggest facets (and values) from the thesis's context.

## Upcoming stages

- Stage 3: relations between papers and a graph.
- Stage 4: chat (per paper and global) over the library.
- Stage 5: formal systematic mapping.

## Stage 2 technical minutiae

- Review mode: the fallback passage (when the quote isn't found in the PDF) is shown normalized, lowercased.
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
