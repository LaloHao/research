# Backlog

## Parked ideas (functionality)

- Reorder facets in the extraction form editor.
- Personal shared library across projects (after stages 4–5): a store outside the projects (app data folder or a user-chosen, git-synced folder) keyed by DOI/arXiv/OpenAlex/PDF hash, holding PDFs and analyses. Adding a paper to any project offers to reuse what is compatible: summary fields when the content language matches, facets whose definition is identical, never the thesis relation; verified/edited statuses kept (optionally re-review). Papers removed from a project stay there.

## Upcoming stages

- Principle for every LLM use: **reading always, acting only from the chat.** Claude gets read-only tools over the library (full-text search, semantic search, finding a passage in a paper, reading a paper's pages, reading a summary and its facets, querying citations and neighbours; src/main/mcp/), used by the 3b relation suggester, the 3c facet suggester, the 5a full-text screening suggestions and the chat. Screening suggestions never decide: every decision is the user's click. Write tools exist only in the chat's actions server (stage 4b), offered only to a conversation whose «Acciones» or «Sincronizar con git» switch is on, and the app enforces the confirmation rule: reversible free actions run on their own only when the user's latest message asked for them in the quoted words; whatever spends money, removes or deletes, attaches a file or syncs is always approved in the conversation. No other LLM use gets write tools.
- Stage 5b (paused on 2026-10-21, to work on thesis-writing tools first): rigor of systematic mappings. The 5a data leaves room for it: every decision names its `reviewer` (`main` in 5a), the protocol stores its `phases`, and every file is a loose object that keeps keys a later version adds.
  - **How a second review works.** A second reviewer screens, without seeing the first one's decisions, a random sample of the records the first reviewer screened. The app compares both decisions record by record and computes Cohen's kappa per phase, the agreement corrected for chance (above about 0.6 is usually read as substantial agreement); the records where they differ are discussed and settled. It shows the criteria are applied consistently and not by one person's judgement alone; a single-reviewer mapping usually reports it on a sample.
  - **Decided:**
    - Stage 5 splits into 5b (rigor: second reviewer, quality, classification scheme) and 5c (reporting).
    - Second reviewer, both modes, chosen per mapping: another person with the app and the project synced by git (each machine names its reviewer in Settings), or the same user re-screening blind later (intra-rater agreement).
    - The second reviewer works on a configurable random sample per phase (for instance 20 %), drawn with a stored seed so it is reproducible.
    - Quality assessment is optional per mapping: configurable questions answered yes, partly or no with a score; Claude suggests answers with a quote from the text and the user confirms.
  - **Still open:**
    - Disagreements: whether a consensus decision settled by the main reviewer replaces the main one in PRISMA (recommended), the main reviewer's always counts, or the more inclusive one counts.
    - Blindness: whether the second reviewer sees no one else's work (no main decisions, no Claude suggestions; recommended) or may use Claude's suggestions.
    - Quality threshold: whether a study under the threshold is excluded in PRISMA as «Calidad insuficiente» (recommended) or only flagged.
    - Classification scheme: whether a mapping picks among the library's facets and links them to its research questions (recommended), or defines facets of its own.
- Stage 6 (writing tools): the «Redacción» view is in place with «BibTeX» (a chapter's `.bib`, following `\input`/`\include`/`\subfile`/`#+INCLUDE` inside the chosen file's folder), «Verificar citas» (the local step and «Verificar con Claude»: app-picked passages per sentence and paper, 10 sentences per structured call under one cap, quotes verified, Markdown report), the basic «Esquema» with «Proponer redacción del esquema» (headings, order, openings and gap sentences, markers checked against text and evidence), and «Estilo» (suggestions kept only when verbatim and leaving citations, math and commands untouched; accept/reject, diff, final text); one cost confirmation for all of them (`writing.plan(kind)`, the check's text-dependent `checkPlan` with the same shape, the shared ClaudeConfirm dialog); the shared citation parser (src/shared/writing/citations.ts), the marker conversion to Org, LaTeX and Markdown (convert.ts), the caps «Tope por borrador», «Tope por verificación de citas», «Tope por esquema» and «Tope por revisión de estilo» and the cost kinds `draft`, `cite_check`, `outline` and `style` exist. Pending:
  - «Borrador» (built: drafts/ with versions, streaming, verified chips, export, sync split) still lacks: the chips are listed below the text rather than inline in it (a textarea cannot color them); its tools are scoped to the chosen papers, but semantic search only filters the library-wide top 20 (a chosen paper ranked lower is not returned); a draft's earlier versions are read-only (no «usar esta versión»); a draft in Activity.
  - «Proponer redacción del esquema» and «Estilo» are built (src/shared/writing/outlineProposal.ts and style.ts, WritingService.proposeOutline/reviewStyle). Pending for them: «Detener» and an entry in «Actividad» (they are single structured calls, not jobs); a Markdown report of a style review; style suggestions in Markdown links or code spans are not protected (only LaTeX, Org and the app's markers are).
  - «Verificar con Claude»: it runs as a direct confirmed call with polled progress, not in «Actividad» (the job queue persists its specs, and a check is 30 000 characters of pasted text whose result lives in the tab). Passage retrieval is lexical when the local similarity model is not downloaded, so a Spanish sentence citing an English paper may get «no se encontró» for lack of the right passage; consider an agent fallback (read-only tools restricted to the cited papers) for those pairs.
  - Local API and Emacs: the server (src/main/api, Settings → Aplicación → «API local») and `emacs/research.el` offer the free tools and, behind «Permitir operaciones con costo desde la API», `cite_check`, `outline_proposal`, `style` and `draft` (a new draft through DraftService, answered once admitted; the free `draft_status` and `draft_stop` follow and stop it, `research-draft` polls on a timer and `research-draft-stop` stops it; one API draft at a time). Closing the project or quitting stops every API run and the server waits (up to 10 s) for the calls in progress; a check, outline proposal or style review stops when its caller hangs up. Pending: how a draft's run ended is kept in memory (the last 100), so after a restart `draft_status` judges from the file (a draft with no version reads as failed); an API check, outline proposal or style review cannot be stopped from the window (only by the caller hanging up, closing the project or quitting), and Emacs' C-g while waiting for one of them only hangs up; an optional live Flymake check while typing; `research-api-file`'s default on macOS/Windows (the app's data folder is not `~/.config/research` there).
  - The tutor (built: the API tools `tutor`, `alternatives`, `reverse_outline` and `rq_coverage`, WritingService.tutor/alternatives/reverseOutline/rqCoverage with their cost kinds and caps, src/shared/writing/tutor.ts and structure.ts; `research-tutor`, `research-alternatives`, `research-reverse-outline`, `research-rq-coverage`) and the local prose checks (`emacs/research-prose.el`). Pending: they have no place in the window (only the API and Emacs); the rewrite filter only catches quoted rewrites of 8+ words (an unquoted one passes); `research-alternatives` sends the paragraph as context only when it is under 4 000 characters; `research-prose.el`'s stemming, gerund and passive detection are crude (false positives such as «es complicado», verbs in -mente like «implemente» listed by hand), the INFLESZ syllable count ignores prefixes (sub-, trans-) and the checks are Org-centric (LaTeX and Markdown buffers are read as Org); the term consistency counts plurals but not other inflections; the Flymake backend rechecks the whole buffer on each pass (fine for a chapter, slow for a whole thesis in one file).
- Stage 5c (after 5b): reporting of systematic mappings. Tables of the included studies with their facets, bubble charts per research question, CSV, SVG and LaTeX tables, and the protocol, search log (the exact strings per database and date) and decisions as Markdown and CSV for a reproducible appendix. Labels name the protocol version a decision was made with; CSV cells that look like formulas are escaped.

## Blocked sites and metadata editing technical minutiae

- The app's browser window (src/main/capture): one window at a time (opening another URL reuses it); a capture is added directly, not as a job in «Actividad», and the window shows its error in the toolbar. Downloads from the page are denied rather than offered through a save dialog. A URL that serves a PDF and is blocked opens in Chromium's PDF viewer, whose print is not the original file: download it in your own browser instead.
- Re-capturing a page is found as a duplicate only by DOI, arXiv id or title: the index has no URL column, so the same URL under a changed title adds a second paper.
- A captured page with a DOI keeps the printed landing page as its PDF when the paper had none, even if an open-access PDF exists.
- «Editar metadatos» is not offered from the chat's actions or the local API, and its undo token lives in memory (lost on restart). Editing does not reconcile `kind` (a web page cannot become an article); an author line is split at its last space unless it has a comma or braces.
- PDF metadata (Title/Author of a PDF attached later) is not offered as a suggestion in the editor.

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
- A paper trashed on another machine that arrives through `git pull` while an untracked PDF keeps its `papers/<key>/` folder loses its cached text before the trash records it; restoring it extracts the text again.
- Listing the trash and planning a delete wait behind a long ingest (a PDF download) on the same project.

## Git sync technical minutiae

- The last sync time and the decisions waiting in the conflicts panel live in memory: after a restart the rail says «Sin sincronizar en esta sesión» until the first sync, and a pending conflict is found again (nothing on disk changed meanwhile).
- `git merge-tree` (git 2.43) always detects renames: a paper trashed on one machine and edited on the other usually merges cleanly, with the edit carried into `.trash/<key>/`; the app detects the case from both sides' diffs and asks anyway.
- A paper trashed and deleted for good on one machine while the other machine edited it is not detected as its own case: it falls back to the per-file modify/delete decisions for whatever changed, and the leftover library folder with no `paper.yaml` stays in history.
- Sync commits are made with `git commit-tree`: commit hooks (pre-commit, commit-msg) don't run; push hooks do.
- A project inside a bigger repository shares its branch and remote: a sync also pushes the user's own commits outside the project (never their uncommitted changes).
- The diff view compares whole lines (no word-level highlighting) and skips files over 512 KB or binary; past 4 million line pairs it shows both sides without aligning them. It also compares git-lfs pointer files as plain text, not as the PDFs they point to.
- `exports/library.bib` in conflict keeps this machine's copy until the app re-exports it from the merged papers.
- A `relations.yaml` side with invalid entries or another schema version is never merged automatically: it becomes a decision.
- Retyping or reversing the same relation on both machines (the id is the unordered pair plus the type) can leave both the old and the new id in the merged `relations.yaml`.
- Cost-log lines (`costs/<device>.jsonl`) are merged by deduplicating identical lines across both sides, without using the merge base as a reference; a retried write whose line differs only slightly from an equivalent one on the other side is not caught.
- A trash operation (remove, restore, delete forever) that starts right after the automatic sync's periodic check runs anyway: each write stays atomic and hash-checked under the write gate, so nothing is corrupted, but a multi-paper operation can be split across two sync commits.
- A git command run by `status()`, `hasUnsynced()`, `conflicts()` or `diff()` (read-only) is not tracked for abort: closing the project or quitting does not wait for it or kill it, unlike `fetch`/`push`/local commit steps.
- If the app is killed outright (a crash, a forced quit), a detached git/ssh process it started can outlive it; a clean close or quit always stops the sync's own processes first.
- On macOS, an app started from the Finder finds git and git-lfs only in the system PATH plus `/opt/homebrew/bin` and `/usr/local/bin`.
- The automatic sync is a per-device setting shared by every project opened on that machine.
- Two overlapping `openProject` calls (e.g. opening one project while another is still opening) can leave an orphaned session that is never closed, and that session keeps its own automatic sync timer running against its project.
- A fast-forward that brings many files (or, with git LFS, downloads the PDFs it checks out) holds the write gate while it runs, so the app's own saves wait for it.

## Stage 3c technical minutiae

- A decided alias suggestion (accepted or rejected) keeps its id (`alias__<facet>__<to>`): once a target is decided, a later run proposing new synonyms for the same target produces the same id and is dropped, so it never resurfaces. New synonyms have to be mapped by hand with the summary's own «Mapear a…» on the proposed chip.
- `FacetSuggester` duplicates `RelationSuggester`'s run/charge flow (one agent run, admitted through `BudgetGuard`, logged by `CostLedger`, same retry and timeout shape) almost line for line; the two could share a base.
- `writeChecked` (used by every gated write, including `facet-suggestions.yaml`) has no per-file lock: two writes to the same file racing from different code paths rely entirely on the hash check and a retry, not on mutual exclusion.
- A run cancelled while still queued is remembered only in memory (`autoDay`); after a restart on the same day the automatic trigger can queue one more run than "once a day" promises.
- The fill offer after accepting a new facet, and the library's batch, count every paper with an up-to-date summary that has *any* unfilled facet, not only the one just accepted; the per-batch cap bounds what that can cost.
- Undo tokens for facet suggestion decisions live in the main process (the last 50) and are lost on restart. Undoing the acceptance of a new facet after a fill already ran leaves the filled values in the papers' files, like any removed facet's, and those papers become stale, since they now hold an entry for a facet the form lacks (the same as removing such a facet by hand later). In the UI this is hard to reach: «Deshacer» lasts a few seconds and a confirmed fill has to finish first.
- The automatic trigger counts papers with an up-to-date summary now minus that count at the last successful run: removing papers delays it, and regenerating a paper never counts as new.
- Listing the suggestions while an alias suggestion waits for review, and accepting one, read every paper's `extraction.yaml` to compute how facets are used; fine for hundreds of papers, slow for many thousands. The section reloads the list on every `jobs-changed`, so during a batch that read repeats often.
- Re-adding a facet key that papers still hold as an orphan entry (kept from a removed facet by the merge) makes those papers stale, not «sin llenar», and accepting a `new_facet` suggestion shows no impact warning for it. A real fix needs the extraction to record which keys its form hash covers.
- The fill plan (and «Llenar en N papers») counts papers whose fill will fail with `too_long` (their text exceeds a `max_input_chars` lowered after a summary that was not truncated). Those jobs fail before `BudgetGuard.admit`, so they cost nothing; a fix needs the truncated flag in the cache or an async fillable check.
- A written fill whose `summary.md` keeps conflicting is reported as done: the classification is written and only the body of `summary.md` lags until the summary is next edited or regenerated.
- «Aceptar» or «Mapear a…» on a summary's proposed chip (`replaceProposals`) computes the form at the start and saves it at the end without a `base` check: a facet suggestion accepted in between is dropped from the form while the suggestion still reads `accepted`. The fix is an `assertForm` right before `updateConfig`, or routing those through `changeForm`.
- Accepting a facet suggestion on one machine and rejecting it on another leaves them disagreeing after sync: the newest `updated_at` wins in `facet-suggestions.yaml`, so a winning `rejected` leaves the accepted change in the merged `project.yaml`. Nothing is lost; an option is to let `accepted` beat `rejected` when both changed, since only it has side effects.
- The suggestion prompt lists at most 150 papers; the agent pages through the rest with `list_papers`, within its 20 tool calls.
- Example quotes are checked once, when the run ends; a paper whose text changes later keeps the old `found` flag.
- `facet_overview` counts a scale's scores as values; for a text facet it only counts how many papers have it.
- Accepting is disabled while the form editor has unsaved changes, rather than merging the acceptance into the draft.
- A `suggest_facets` cost line has an empty `paper_id`.
- `facet-suggestions.yaml` with conflict markers (only possible after a hand-run git merge; the app's sync never leaves them) has no automatic resolution button, unlike `relations.yaml`: it must be fixed by hand.
- A suggestion edited before acceptance keeps its original id (e.g. `new_facet__data_source` for a facet saved as `data_origin`), so a later run may suggest the original key again.
- The cache schema goes from 8 or 9 to 10 in place (`ALTER TABLE` and the mapping tables, keeping texts and vectors); any other older schema is still rebuilt from scratch.

## Stage 4a technical minutiae

- Every message re-sends the conversation (the newest 8 messages / 24 000 characters verbatim plus a one-line digest of older ones, within 4 000 characters): input grows with long conversations, and the digest is mechanical (cut lines), not a summary written by Claude. Resuming CLI sessions was ruled out (see the 4a plan's decisions).
- The stream-json event shapes are those of the documented SDK stream, checked only against `claude --help`; `scripts/record-chat-fixture.sh` re-records `test/fixtures/llm/chat-stream.jsonl` from the real CLI (a few cents) when the parser needs checking.
- A stopped or timed-out answer is charged at its per-message cap as an estimate; the CLI's partial usage is not read.
- A conversation's `cost_usd` adds up its answers only; a failed answer's charge shows in the month's total, not in the conversation.
- Text written in a turn before a tool call is shown while streaming but not saved: the saved answer is the final turn's text.
- Citations are re-verified every time a conversation opens (each cited paper's indexed text is read once per open).
- The chat index lives in memory and re-reads every file in `chats/` on each external change; fine for hundreds of conversations.
- Two machines splitting the same conversation in concurrent syncs can each create their copy (`<id>-<hash of the other's text>`), leaving two copies after both merges; git's own clean text merge of `chats/<id>.md` (when it can resolve the file on its own) bypasses the app's conversation merger entirely, so a criss-cross of concurrent hand edits and app writes can still produce duplicate copies even when git merges cleanly.
- A message edited by hand on one machine while the other continued the conversation splits it into two, like any divergence.
- «Preguntar a Claude» is offered in the PDF tab and Contenido, not in Texto.
- The PDF tab draws a selectable text layer on every page (needed for selections), which takes longer on very long PDFs; the text layers use plain `pdfjs.TextLayer` without pdf.js's own `TextLayerBuilder` selection helpers (`endOfContent`/`selecting`), so dragging a selection past the end of a text run can jump to a larger selection than in a page that uses those helpers. Every page's canvas is still rendered eagerly up front; only the page's text layer is lazy (built the first time the page nears the visible area).
- The citation side panel has no «Abrir paper» button to jump to the paper's detail in the library.
- «Guardar en notas del paper» has no «Deshacer»; the appended block is edited in the notes by hand.
- A quote containing `"]]` cannot be written in a marker (it is broken up as `" ]]`).
- Answers in different conversations may run at the same time; only the monthly cap's reservations bound them together.
- Conversation search is a substring match over titles and messages, without ranking.
- A conversation file with conflict markers or an invalid frontmatter shows as «Archivo con errores» and can only be fixed or deleted by hand.
- Model ids from the CLI that would break the chat file's schema (whitespace, a leading `$`, or the literal `detenida`) are sanitized to a safe form, or to `unknown` if nothing usable remains; the ledger records the same sanitized id, so it can differ from the CLI's raw id.
- One answer at a time per conversation (`chat_busy`): a send, retry or delete while an answer of that conversation is in flight (or while the project is closing) is refused rather than queued, and the model selector is disabled meanwhile. Rename, archive and save-to-notes are allowed during an answer: its final write re-reads the file and keeps them.
- A paid answer whose final write fails (file deleted or made invalid meanwhile) is lost; the question stays for «Reintentar».
- Closing a project waits for any chat send or retry in flight, then stops the run and saves what arrived as a stopped answer; a send that starts in the narrow window just before close is still admitted and then stopped the same way.

## Stage 4b technical minutiae

- The CLI's wait for a tool call held by an approval is raised with `MCP_TOOL_TIMEOUT=600000` in the CLI's environment; the variable is documented for Claude Code but was not checked against a real run (that costs money). If a real run shows the CLI giving up earlier, an approval longer than its limit fails the call while the card still waits.
- Undo tokens (chat «Deshacer», like Revisar's) live in memory: after closing or switching the project, a restart, or on the other machine, the records stay but «Deshacer» is gone.
- A request quote needs at least 8 folded letters or digits and matches on whole words at both ends; a short «sí» to «¿Lo agrego?» asks instead of running. A quote can also match words inside a negation or a question ("no agregues una nota a Drain" contains "agregues una nota a Drain"): the check only proves those words are in the user's own latest message, not that the user meant that exact call. The quoted words need not be about the action at all: any 8+ letter phrase of the latest message unlocks up to 3 free, reversible actions for that message, even unrelated ones, so text Claude reads (a paper, a tool result, an earlier answer) could steer it into them without the user asking. This is why the app also caps unconfirmed actions at 3 per message (the 4th and later always ask), why editing a summary value or resolving a proposed value always asks regardless of the quote, and why every unasked action can still be undone. add_paper, which fetches what its identifier names, additionally runs unasked only when that identifier (DOI and arXiv ids without case, trailing slashes aside; URLs as typed) is in the user's latest message; any other identifier, such as a URL taken from a paper, asks.
- An unasked action whose record failed to write (the conversation file deleted or broken meanwhile) does not count toward that cap of 3 on a retry.
- add_paper's risk is decided when the call is prepared: if «Resumir automáticamente al agregar» is turned on while a free add_paper card waits, approving it queues a summary the card never priced (the summary reads the setting when the job runs).
- add_paper and attach_pdf wait up to 60 s for their job; after that the record says the job goes on in Actividad, without the new key or an undo.
- Undoing a note written into a paper without notes leaves an empty notes.md.
- A hand-edited action record whose YAML no longer reads keeps its heading and is read (and written back) with empty arguments and result.
- Not available from the chat: «Editar y aceptar» of a facet suggestion, merging a restored paper with its twin, sync setup and «Cancelar» of a pending sync, metadata updates, citation fetches, and form edits other than proposed values.
- Relation suggestions from the chat are always forced (like the paper's button), even when no new candidate appeared.
- The chat's own cost shows the answer only; jobs it started are charged by the jobs (Actividad, monthly total), not in the conversation's cost.
- An approval that waits keeps that answer's actions server open; answers in other conversations go on in parallel, bounded by the budget guard.

## Stage 5a technical minutiae

- Mappings can't be deleted or archived from the app yet; removing `mappings/<id>/` by hand (or through git) drops it from the index.
- A record's metadata can't be edited in the app; a correction means editing `records.yaml` by hand (the index picks it up).
- Any future CSV export (mapping reports, stage 5b) must escape formula-like cells (`=`, `+`, `-`, `@`) to avoid formula injection when the file is opened in a spreadsheet.
- Doubtful duplicates are looked for by title only among records a year apart at most (records without a year are compared against all); two records of one work with different titles and no shared identifier are never flagged.
- Automatic merging on title needs matching first authors (the same family name on both sides, or neither record having authors, with an exact title/year/venue match); the same title and year with a different or missing first author on one side always asks instead of merging silently. Two different authors who happen to share a family name (two different Zhangs) with the same title and year still auto-merge, since nothing else tells the records apart.
- «Es el mismo» carries the merged record's screening decisions over to the survivor, but not its suggestions: the survivor may be asked again by «Sugerir cribado», which costs money but loses no decision.
- The protocol edited on two machines at once: when both edits change the body differently, the sync merge can't resolve it on its own, and `protocol.yaml` becomes a file conflict the user picks a side for in «Sincronización», like any other file it can't merge; the version you don't pick isn't lost, it stays in git's history. The losing side's decisions whose `protocol_version` collides with the winning side's number then show the winning side's wording for that version. A third choice — keep both edits, renumbering one of them — would need a new kind of sync decision beyond the existing "ours"/"theirs".
- Opposite answers to the same duplicate pair on two machines (one answers «Es el mismo» while the other answers «Son distintos» and keeps deciding the newer record) can hide the second machine's later decisions from the survivor after they sync. When a retry after an «Es el mismo» write conflict is refused because the other machine answered «Son distintos» meanwhile, the carried decision copies it already wrote stay on a survivor that never actually merged.
- A record whose ingest merged into a library paper with a different DOI stays unlinked and keeps appearing in the ingest plan; asking again only answers "already in the library" (`duplicate`), never a link. Confirmed jobs, including paid screening suggestions, resume on reopen like any other job.
- Protocol drafts in the editor last only the window's lifetime (closing the app drops an unsaved one); an in-place edit (still version 1) that lands after a save's version check but before its write is not caught as a conflict.
- Title-and-abstract and full-text suggestions share one learned `screening` cost estimate (the largest cost seen), so a full-text run raises the estimate shown for title-and-abstract batches.
- An import retried after a concurrent change (a sync writing `records.yaml` meanwhile) reports the records of its first pass as "already there".
- Snowballing looks up at most 2000 works per iteration and uses each paper's references or incoming citations as last fetched, fetching them first when a paper never had them in that direction.
- A record whose identifier the registries don't know becomes an incomplete paper built from the record's own metadata; fix it with «Actualizar metadatos».
- The OpenAlex search sends the string as-is to OpenAlex's exact title-and-abstract filter (`title_and_abstract.search.exact`); its Boolean syntax is OpenAlex's, not Scopus's or IEEE's, and a string with a comma or `|`, or starting with `!` (OpenAlex negates the whole filter), is refused (OpenAlex reads them as filter separators; a quoted value could carry a comma, but it would change the string's meaning). Searches logged before this change searched OpenAlex's full text and have no `field`.
- The app log (`<userData>/logs/main.log`) is plain text with one JSON object per line; redaction is pattern-based, so a secret in an unusual shape (a bare key with no name, not matching a known token prefix) inside an error message would not be caught. The app's own secrets (OpenAlex API key, contact email) are also replaced literally, and HTTP error messages are scrubbed of them before they are shown or logged. OpenAlex's own explanation of a refused search (`detail` of `http_failed` / `job_failed`) can echo the search string or a title: not a secret, but it is content the log otherwise leaves out. Renderer errors are capped at 20 a minute.
- Terminal mirror of the app log (`pnpm dev`): a job's line shows no cost (the job result carries none; an agent run's `end` line does). An agent run's `turns` is the CLI's `num_turns` and is missing when the CLI does not report it. The title/abstract screening call has no tools, so its lines are only `start` and `end`. A tool argument is shown only when its key is an id or enum name (`paper_id`, `decision`…) and its value matches that id's own pattern (paper key, record, mapping, relation, suggestion id); `key` and `facet` only when they are a summary field or a short snake_case facet key (at most 32 characters and 4 words), anything else only by its length. A short snake_case phrase (or a lowercase run of letters under `paper_id`) can still pass as a key: the log cannot check it against the form or the library.
- «Buscar» asks OpenAlex for the count (`meta.count`, one request of one result) every time the confirmation opens; the count is approximate, so «Subir el tope a N» can still leave a search a few results short (`capped`), which «Completar búsqueda» then covers.
- «Completar búsqueda» only repeats searches logged with the current field (`title_and_abstract`) and filters this app writes (`publication_year`, `type` with known types); older entries searched full text and can't be completed. When some records only the old search brought don't come back, both searches stay live (the new one counts toward PRISMA as well, its shared records as duplicates) and the user decides what to discard. A second completion of the same search is refused while one is queued or running (`search_completion_pending`), and a completion job run after its search was replaced fails before any request. Two machines completing the same search before syncing: the merge keeps the earlier discard (and its `replaced_by`), so the other machine's new search stays live next to the winner, and PRISMA counts both (the shared records as duplicates) until one is discarded by hand. The stored discard reason is the token `completed`; the window words it from `replaced_by`. A completion that keeps the old search live is recognised by matching (a later live, uncapped search with the same string, field and filters), not by a stored link, so repeating the same string by hand with a higher cap also reads as a partial completion; the window checks pending completions only in the latest 50 jobs (the main process still refuses), and it shows «Completar» without comparing the logged request URL, which the main process does.
- The PRISMA diagram always uses print colors (black on white), whatever the app's theme; lines wrap by an estimated character width, so a very long database name may slightly overflow its box.
- A suggestion run cancelled while Claude was still answering writes no suggestion; its cost is logged anyway.
- «Deshacer» is not offered for the decision that resolved a conflict between machines (undoing it would need both earlier decisions back).
- Records already in a mapping are linked to a library paper only when they enter the mapping or are added to the library from it: a paper added to the library later by other means doesn't link the matching record, which «Agregar a la biblioteca» then links ("already in the library").
- A decision made on a queue the window hasn't reloaded yet replaces, without showing a conflict, a decision on the same record that a sync brought meanwhile. Nothing is lost (decisions are append-only, and the replaced one is in `decisions.yaml`); a fix is to send the decision on screen and refuse with `conflict` when the heads differ.
- The PRISMA exclusion reasons and other labels use each criterion's current wording, not the wording of the protocol version the decision was made with; 5b's reports should name the version (`criterionText` with the decision's `protocol_version`).
- A large mapping sends every queue row (abstracts included) over IPC on each reload of the screening list; the files are parsed only when their text changes, but a paginated queue would cut the transfer.
