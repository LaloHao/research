# User guide

*[Versión en español](./guide.es.md)*

This app is a paper library for the thesis *Método computacional para la desensibilización de logs y generación trazable de post-mortems de incidentes de software asistida por modelos de lenguaje locales*. It's a personal, standalone application: it needs no accounts or servers of its own; it uses Claude for the summaries and public services (doi.org/Crossref, OpenAlex, arXiv) for metadata.

## What it's for

- Keep the thesis's papers in a project folder, with their BibTeX, to cite them from LaTeX or org-cite.
- Search titles, authors and the full text of the papers (including grey literature: web pages without a PDF).
- Generate, with Claude, a summary of each paper: its fields (problem, contribution, method, evaluation…), a classification according to the thesis's extraction form, and its relation to the thesis, all with evidence (verbatim quotes with page) and a per-field review status.
- A quick review mode to go through every field and facet Claude generated, one by one.
- Fetch each paper's references from OpenAlex and suggest **citation candidates** (*snowballing*): works your papers cite, or that cite them, which aren't in your library yet.
- Find **similar papers** by combining shared references, shared citers, shared facet values and a local content model, with the reasons for each match.
- See the field in the **Mapa** (Map) view: a graph of papers with two lenses (field and thesis) and per-facet charts.
- Ask Claude for **typed relations** between papers (extends, uses the method of, compares with, contradicts, replicates, same problem), with a justification and quotes from both papers that Claude finds by itself with read-only tools over your library; you confirm, reject or retype them.
- Ask Claude for **suggested facets** for the extraction form: new facets, new values and aliases that merge loose proposed values, with a rationale and quoted examples from your papers. You review them in Settings → Formulario (Form); a new facet is filled in papers already summarized without regenerating their summaries.
- **Chat with Claude** about your library or about one paper: it answers as it writes, searches your papers with read-only tools and cites every claim with the verbatim sentence and its page, which the app checks against the text and which opens the PDF highlighted. Conversations are stored in the project and synced between your machines.
- **Sync** the project between your machines with git from the app: it commits your changes, brings in the other machine's, merges them and pushes, never leaving conflict markers in your files; whatever it can't merge on its own, it asks you about.

Coming soon (not implemented yet): actions from the chat (adding papers, writing notes, deciding relations… always behind the right confirmations), and formal systematic literature mapping.

## Getting started

### Install and run

```bash
pnpm install
pnpm dev
```

Requires Node.js 24 or later and pnpm (`corepack enable`).

### The Claude CLI

Summarizing papers needs the `claude` CLI installed on the system and signed in:

```bash
claude login
```

The app invokes it locally, in non-interactive mode and without tools or MCP; it opens no network of its own and sends nothing anywhere except Claude. If the CLI isn't installed or isn't signed in, any attempt to summarize fails with «No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.» (Couldn't use Claude: check that the `claude` CLI is installed and signed in.).

### Create or open a project

On startup with no project open, the app asks you to create a new one (a name and a folder that doesn't already hold a project) or open an existing one (a folder that already has `project.yaml`). If you pick a folder that already holds a project to create a new one, it warns «Esa carpeta ya tiene un proyecto; ábrelo en lugar de crear otro.» (That folder already has a project; open it instead of creating another one.). The project stays open for the next time you start the app.

### Syncing the project between machines

The project folder is plain text (YAML, Markdown), meant to be versioned with git. The app syncs with git by itself (see "Syncing with git" below); you can also use git by hand or a tool like Syncthing. Files reload on their own when they change from outside the app (a sync, a `git pull`, an external editor) — no restart needed. If two machines edit the same file at the same time outside the app's sync, the app detects it as a conflict (see "Common problems" below). The trash (`.trash/`) syncs too: a paper you remove on one machine shows up in the other's «Papelera» (Trash), and can be restored or deleted there the same way.

## Adding papers

In the library's top bar you can:

- **Paste a DOI, an arXiv id or a URL** and tap «Agregar» (Add). It also accepts an OpenAlex id (`W2741809807` or `https://openalex.org/W2741809807`); that's what «Agregar» (Add) in Candidates uses for works without a DOI. For a URL that isn't a DOI or arXiv id, the app looks at what's behind it: if it serves a PDF, it's added as a PDF; if the page has a DOI or an arXiv id, that identifier is used; otherwise it's saved as a web page (grey literature), with its readable text if found, and if not, it warns that «La página no tiene un artículo legible.» (The page has no readable article.).
- **Drag one or more PDFs** onto the library.

The app fills in metadata automatically from the identifier. If the paper ends up with «Los metadatos están incompletos.» (Metadata is incomplete.), you can paste a DOI or arXiv id in the notice and tap «Completar» (Complete), or tap «Reintentar» (Retry) if it already had one.

When a paper is added (or its metadata completed), the app looks up its references in OpenAlex in the background (see "Citations and candidates"); this uses no Claude quota.

Adding an identifier or PDF that's already in the library updates the existing paper instead of duplicating it («ya estaba en la biblioteca» (was already in the library) / «actualizado» (updated) in the activity panel). A PDF dropped on the library is matched by the DOI or arXiv id printed on it, or by its title: when nothing matches, it becomes a new paper, and when the paper already has a PDF, the dropped one is ignored. To give a specific paper its PDF, use its PDF tab instead (see "Attaching or replacing a PDF" below).

### Attaching or replacing a PDF

To add the PDF of a paper that's already in the library (for example one added by DOI without an open-access PDF), open the paper and, in its **PDF** tab, tap «Adjuntar PDF…» (Attach PDF…) to pick the file, or drop the file on the tab. For a web page without a PDF, the «Adjuntar PDF…» button is at the top of the **Contenido** (Content) tab, which also accepts the dropped file. Only one `.pdf` file at a time is accepted, up to 200 MB. A PDF dropped on an open PDF or Contenido tab is attached to that paper instead of being added as a new paper. An attached PDF is always kept in the paper's folder (`papers/<key>/paper.pdf`, tracked or ignored by git per the PDF policy), even with «No guardarlos: descargarlos al abrirlos» (Don't store them: download on open), since it can't be downloaded again; a previously downloaded copy in `.cache/` is removed.

When the paper already has a PDF, the PDF tab has a «Reemplazar PDF…» (Replace PDF…) button at the top (dropping a file there works too). Before replacing it, the app asks: «Se reemplaza el PDF y se vuelve a extraer el texto. Los resúmenes no cambian.» (The PDF is replaced and its text extracted again. Summaries don't change.).

Attaching runs as a job in the activity panel («Adjuntar PDF a <key>» (Attach PDF to <key>), outcome «PDF adjuntado» (PDF attached)). Only the PDF changes: the paper's metadata isn't looked up or merged again, and the PDF's text replaces the previously indexed text (search, the Texto tab, summaries generated from now on). Existing summaries are kept as they are, so after a replacement their evidence quotes and page numbers may point to a different place in the new PDF; regenerate the summary if that matters. If the file isn't a PDF, it's damaged, or the paper's `paper.yaml` has a problem, the job fails and nothing changes.

Each paper gets a **citation key** (its folder under `papers/`) that never changes, even if you edit its metadata. It can be copied with the «Copiar» (Copy) button next to the key, in the paper's detail.

The app keeps `exports/library.bib` with the BibTeX of every paper, ready to cite from LaTeX or org-cite. It's a generated file: don't edit it by hand.

## Library

The list on the left shows every paper matching the active search and filters.

- **Search**: the box at the top searches titles, authors and each paper's indexed full text.
- **Badges** (under each paper's title):
  - *Error en archivo* (File error): `paper.yaml` couldn't be read (git conflict markers, invalid YAML, or missing fields).
  - *Metadatos incompletos* (Incomplete metadata): title, authors or other data still needs completing.
  - *Web*: the paper is a web page (no PDF, with extracted text).
  - *Sin PDF* (No PDF): not a web paper and has no attached PDF.
  - *Sin resumen* (No summary): not summarized yet (and already has indexed text). A paper too long to summarize without «Forzar» (Force) (see "Summaries with Claude") doesn't show this badge while it has no summary.
  - *Por revisar (N)* (To review (N)): the summary has N fields, facets, or the thesis relation still neither verified nor edited, or a previously reviewed thesis relation that's now pending re-review because the thesis changed. N also counts the suggested typed relations that involve the paper and that you haven't confirmed or rejected yet, so the badge can show even when the summary is already reviewed.
  - *Revisado* (Reviewed): everything generated has already been verified or edited.
  - *Desactualizado* (Stale): the summary went stale because the extraction form changed, or because the thesis changed and the relation to it was still in *generado* (generated) (see "Summaries with Claude").
  - *Resumen falló* (Summary failed): the last summarize attempt ended in an error.
  - *Sin citas* (No citations): the paper wasn't found in OpenAlex (it has no DOI and there was no exact title-and-year match), so it has no citations or candidates.
- **Filters**: by summary status (all, no summary, to review, reviewed, stale, with error, con relaciones por revisar (with relations to review)) and by the model it was generated with (the selector is labeled «Resumido con» (Summarized with) for screen readers; its visible options are «Cualquier modelo» (Any model), Sonnet, Haiku and Opus).
- **Facet filter**: clicking a bar or a bubble in the charts (Map view) opens the library filtered by that value (or a pair of values), shown as a `facet = value` tag you can remove with ✕.
- **«Actualizar citas»** (Update citations): looks up the references of every paper again in OpenAlex or, when a search or any filter is active, only of the visible ones. The jobs show up in the activity panel.
- **Sugerir relaciones** (Suggest relations): asks Claude for typed relations for the papers whose candidates changed since their last analysis (all of them or, with a search or filter active, only the visible ones). Before queueing it shows the number of papers, the estimated cost and the batch cap; if there are none, it says «No hay papers con candidatos nuevos por analizar.» (No papers with new candidates to analyze.). See "Typed relations".
- **Batch actions**: both queue, in one go, every eligible paper visible under the current search and filters (over-long ones are skipped unless they already have a forced summary); both ask for confirmation before queuing. All of a batch's jobs are queued upfront; if the batch cap (or Claude's quota) is hit while it runs, that batch's jobs still queued are cancelled.
  - *Resumir pendientes* (Summarize pending): queues papers with no summary (or a stale or failed one) within the batch budget, using the model chosen in the «Modelo del lote» (Batch model) selector. The confirmation shows the number of papers, the estimated cost and the batch cap; if none are pending, it warns «No hay papers pendientes de resumir.» (There are no papers pending summarization.).
  - *Regenerar filtrados con…* (Regenerate filtered with…): with an active status filter (not «Todos» (All)), regenerates with the model chosen in its own selector every visible paper that has indexed text.
- **Activity panel**: lists running and recent jobs (adding an identifier or PDF, attaching a PDF to a paper, completing metadata, summarizing, citations, who cites a paper, a paper's similarity, downloading the similarity model, sugerir relaciones (suggest relations)), with their status (queued, running, done, failed, cancelled) and, when applicable, the outcome (added, updated, was already in the library, PDF attached, summarized, citations updated, not found in OpenAlex, incoming citations updated, model downloaded, relaciones sugeridas (relations suggested), sin candidatos para analizar (no candidates to analyze)). The model download shows its progress as a percentage. A queued or running job can be cancelled. Tapping a job's name opens its paper.

## Removing papers and the trash

**«Quitar de la biblioteca»** (Remove from library) deletes nothing: it moves the paper's whole folder (`paper.yaml`, PDF, summary, extraction, notes and text) from `papers/<key>/` to `.trash/<key>/`, inside the project, and records when and on which machine in `.trash/<key>/trashed.yaml`.

- **One paper:** in its detail (in the library or the graph), «Quitar de la biblioteca» asks for confirmation with its title.
- **Several:** with a search or any filter active, the list's «Quitar de la biblioteca» button removes every visible paper; the confirmation says how many. Without a search or filter, the button doesn't show.
- Its pending jobs (summary, citations, citing works, similarity, relations and attaching a PDF) are cancelled before it moves.
- For a few seconds «N papers movidos a la papelera» (N papers moved to the trash) shows with **«Deshacer»** (Undo), which restores them.

A paper in the trash disappears from the library, search, graph, charts, similar papers, Review mode and `exports/library.bib`. Its typed relations stay in `relations.yaml`, but they're hidden (in the app and from Claude) until you restore it. Its key stays reserved: a new paper never reuses it.

If another program has one of the paper's files open (say, its PDF in a viewer), the app retries for a moment and, if it's still busy, shows «Otro programa tiene abierto un archivo de ese paper…» (Another program has a file of that paper open…).

### Trash

The **«Papelera»** (Trash) view (🗑 in the side rail) lists removed papers with title, authors, year, the day they were removed and on which machine («este equipo», this machine, or «otro equipo», another machine), with a simple search and checkboxes to pick several.

- **«Restaurar»** (Restore) puts the folder back in `papers/<key>/` exactly as it was, relations included; if its PDF didn't change, its text isn't extracted again.
- If meanwhile **a different paper** took that key, it comes back under the next free one (e.g. `he2017draina`), with its BibTeX and relations adjusted; the notice says which key it got.
- If **the same paper** (same DOI, arXiv id or title) came back to the library, the app warns and offers **«Fusionar»** (Merge) or **«Cancelar»** (Cancel). Merging leaves a single paper, the library's: it joins both notes (the trashed ones at the end), keeps the summary and extraction with more verified or edited entries, takes the trashed files the library lacks, and moves its relations to the library key. No differing copy is lost: the one that doesn't win stays beside the other as `<name>.trashed.<ext>` (from the trash) or `<name>.before-merge.<ext>` (from the library), e.g. `paper.trashed.pdf`.
- If a `papers/<key>/` folder without `paper.yaml` was left behind (by a sync), restoring moves the files into it without overwriting any: a clashing one is kept as `<name>.trashed.<ext>`.
- Anything the app doesn't move (a subfolder, or a file such as `.DS_Store`) stays in the trash and the notice says so («Algo de … sigue en la papelera», Something of … is still in the trash). The paper itself is back in the library as usual, with its relations and jobs; delete the leftover for good when you no longer need it.
- **«Eliminar definitivamente»** (Delete permanently, one or several) and **«Vaciar papelera»** (Empty trash) ask for confirmation with the number of papers and of relations that will be removed from `relations.yaml`, and delete exactly those papers. If `relations.yaml` has a git conflict, nothing is deleted until it's resolved. Deleted papers can only be recovered from git history, and PDFs you keep out of git («Guardarlos fuera de git» or «No guardarlos» policy) can't be recovered.
- A trash folder that can't be restored shows the reason, e.g. «No se puede restaurar: le falta paper.yaml.» (Can't be restored: paper.yaml is missing.); check it in the project's `.trash` folder. «Restaurar (N)» (Restore, for the checked papers) counts and restores only the ones that can be restored.

In **«Candidatos»** (Candidates, Map view), a work that matches a paper in your trash (by OpenAlex id or DOI) shows «En la papelera» (In the trash) with **«Restaurar»** (Restore) instead of «Agregar» (Add).

## Syncing with git

The app syncs the project folder with a git repository: it commits your changes, brings in the other machine's, merges them and pushes the result. It uses the git installed on your machine and its credentials (ssh-agent or git's credential manager): it never asks for or stores passwords. If your SSH key has a passphrase, it must be loaded in ssh-agent (`ssh-add`) before syncing; the app can't type it for you.

- **In the side rail**, above ⚙, the ⟳ button syncs right away (or opens the Sync view if it can't, or if that sync ended in an error or conflicts); under it there's a short status («ahora», now; «3 min»; «sin subir», not pushed; «sin red», offline; «conflictos», conflicts…) and, on hover, the full one: «Sincronizado hace 3 min» (Synced 3 min ago), «Cambios sin subir» (Changes not pushed), «Sin conexión» (Offline), «Conflictos por resolver» (Conflicts to resolve) or «Sincronizando…» (Syncing…). Clicking the status opens the **Sincronización** (Sync) view, with the repository, the branch, the last error and the «Sincronizar» (Sync) button.
- **What gets pushed**: only the files in the project folder (honoring `.gitignore`; `.cache/` never), in a commit «research: sync from <machine>» listing the papers touched. If nothing changed, there's no commit. If the project lives inside a bigger repository (say, your thesis's), whatever you have outside the folder, staged or not, is left alone and stays out of the commit; commits you made yourself with git are pushed with the branch. If you had staged (`git add`) a change inside the project by hand before syncing, the sync's commit includes it anyway: nothing is lost, but it stops showing up as separately "staged".
- **How it merges**: it never rewrites history (merge, not rebase: the other machine's commits stay as they are) and never leaves conflict markers in your files, because it computes the merge apart and only changes files once the result is complete. It merges on its own `relations.yaml` (joined by `id`; if a relation changed on both machines the latest change wins, and one deleted on one machine and untouched on the other stays deleted), `facet-suggestions.yaml` (the same way, by `id`: a suggestion changed on one machine only takes that machine's version, and changed on both, the latest change wins), the `costs/` spend logs (lines joined), the conversations in `chats/` (if one machine only added messages, or renamed or archived the conversation, they merge; if both machines continued the same conversation, both are kept, the other machine's showing as «(copia de <equipo>)» (copy from <machine>)), `project.yaml` key by key (dismissed candidates are added up), the `trashed.yaml` of a paper removed on both machines (latest date wins) and `exports/library.bib` (the app regenerates it). A file you added that git relocated because the other machine renamed its folder isn't lost or asked about: it's kept beside the original as `<name>.conflict` (or `.conflict-2`, etc. if one already exists).
- **Conflicts**: if a file changed on both machines and the app can't merge it (a `summary.md`, `extraction.yaml`, `paper.yaml` or `notes.md`, or the same key of `project.yaml`), the sync stops without touching your files and the Sync view shows «Conflictos por resolver» (Conflicts to resolve): each file with the paper it belongs to, what each machine did, «Ver diferencias» (Show differences: both versions side by side) and «Quedarme con la mía» (Keep mine) / «Usar la del otro equipo» (Use the other machine's). If one machine moved a paper to the trash while the other edited it, you pick «Conservar el paper» (Keep the paper: it returns to the library with the edits and leaves the trash) or «Aceptar que se quitó» (Accept that it was removed: it stays in the trash, with the edits git could carry there). Nothing gets pushed until you've chosen for all of them («Terminar sincronización» (Finish sync) only enables then); «Cancelar» (Cancel) leaves everything as it was (your changes stay in a local commit, not pushed). If something changes while you're deciding (something new was saved here, or the other machine pushed), the app asks you again before going on. The version you don't pick isn't lost: it stays in git history.
- **Outside the project folder**: if the project lives inside a bigger repository and the other machine changed the same outside files, or if you have a hand-run git merge or rebase left unfinished, the sync stops without touching anything; resolve it with git and sync again.
- **Automatic**: «Sincronizar automáticamente» (Sync automatically; Settings → App, on by default) syncs when the project opens and every 10 minutes (or the interval you choose, 5 to 120) if the repository has a remote. It skips an interval while conflicts wait for your decision or while papers are being moved to or from the trash, and it never opens windows: if it fails (offline, credentials), only the side rail shows it, and it tries again at the next interval.
- **On close**: if the project has uncommitted changes, unpushed commits or pending decisions, the app asks «Sincronizar y cerrar» (Sync and close), «Cerrar sin sincronizar» (Close without syncing) or «Cancelar» (Cancel). The window closes only if that sync succeeds; if it finds conflicts or fails, it stays open and you can go to «Ver sincronización» (Show sync). If an automatic sync was running at that moment, it waits for it and syncs again, so what you saved last is pushed too. While it syncs you can still choose «Cerrar sin sincronizar»: the transfer stops and whatever wasn't pushed stays on your machine for next time.
- **First use**: if the folder isn't in a repository, the Sync view offers «Inicializar repositorio» (Initialize repository: `git init` in the project folder, on branch `main`, with the `.gitignore` the app already maintains) and a field for the URL of an empty remote repository (on GitHub, GitLab or a shared folder); a URL with a password is refused. With a URL, it pushes the project when done. If the repository has no remote, the same URL with «Agregar remoto y sincronizar» (Add remote and sync); if the branch tracks no remote branch, «Conectar y sincronizar» (Connect and sync) connects it to the branch of the same name (or publishes it if there's none). That URL can only be corrected while that remote has never worked (it hasn't yet been used to sync); once it has, changing it needs `git remote set-url origin <url>` by hand. If the remote has a different history from this repository, the app refuses it (see "Common problems" below). For a second machine, clone the repository with git and open that folder as the project.
- **PDFs in git LFS**: with the «Versionarlos con git LFS» (Track them with git LFS) policy, git-lfs must be installed; if it's missing, the sync says so. The app sets up git-lfs in the repository itself and uploads the PDFs before the commits that point to them, so it works even with git hooks turned off (`core.hooksPath`); if the upload fails, nothing is pushed.

## Paper detail

Selecting a paper opens its tabs (only the ones that apply):

They appear in this order: Resumen, Contenido, PDF, Texto, Relaciones, Chat, Notas.

- **Resumen** (Summary): see "Summaries with Claude" below.
- **Contenido** (Content): the extracted readable text, whenever there is one (typically web pages without a PDF), rendered as a readable document (headings, paragraphs, lists, tables, blockquotes, code). Links open in the system browser; images aren't loaded, they show as a small chip linking to the image instead. Following an evidence link to a web paper opens this tab with the quote highlighted and scrolled into view; if the exact text isn't found, it shows a small notice. Selecting text shows «Preguntar a Claude» (Ask Claude; see "Chat with Claude").
- **PDF**: the PDF viewer. Shown for any paper that isn't a web page, even before it has an attached PDF: in that case it shows «Este paper no tiene PDF. Usa «Adjuntar PDF…» o suelta el archivo aquí.» (This paper has no PDF. Use «Adjuntar PDF…» or drop the file here.) instead of the viewer. See "Attaching or replacing a PDF" above. Selecting text shows «Preguntar a Claude» (Ask Claude; see "Chat with Claude").
- **Texto** (Text): the PDF's extracted text, page by page, laid out for reading. Shown when the paper has a PDF and its text is indexed (see "Reading the text" below).
- **Relaciones** (Relations): at the top, the «Relaciones tipadas» (Typed relations) section (see "Typed relations"); below it, the citation status (not fetched yet, fetched on a date with N citations in OpenAlex, or *Sin citas* (No citations)) with an «Actualizar citas» (Update citations) button; «Cita a (en tu biblioteca)» (Cites, in your library) and «Citado por (en tu biblioteca)» (Cited by, in your library), library papers only, each opening on click; how many references aren't in your library, with «Ver candidatos» (See candidates), which opens the Candidates tab filtered by this paper; and «Similares» (Similar): the 10 most similar papers with their score and reasons (e.g. «6 referencias en común · citados juntos por 3 papers · technique: ner · similitud de contenido 0.82» (6 shared references · cited together by 3 papers · technique: ner · content similarity 0.82)).
- **Chat**: the conversations with Claude about this paper, and «Nueva conversación» (New conversation); see "Chat with Claude".
- **Notas** (Notes): your own notes in Markdown, with autosave (`notes.md`). If the file changed from outside the app while there were unsaved changes, it warns of the conflict and lets you choose between reloading (discards your own) or overwriting with your own version.

### Reading the text

The Texto tab shows one page at a time, with «Página N de M» (Page N of M), «Anterior» / «Siguiente» (Previous / Next) and a box to jump to a page. The text is reflowed: words hyphenated at a line end are joined, the lines of a paragraph are merged, short title-like lines (such as «1 Introduction», «2.3 Results» or all-caps lines) show as headings, and running headers, footers and page numbers that repeat across pages are dimmed. The search box searches every page, ignoring case and accents, and shows how many results there are; the arrows move between results, changing page when needed, with each match highlighted.

Above the detail: the citation key (with a button to copy it), the link to the original DOI or URL, «Mostrar en carpeta» (Show in folder) (opens `papers/<key>/` in the file explorer), and the indexed-text status (indexing, text indexed, PDF without text/scanned, no text, extraction error).

## Summaries with Claude

A summary (`summary.md`) has these fields: tl;dr, problem, contribution, method, evaluation, results, limitations (stated and inferred), future work, and research type (solution proposal, validation, evaluation, experience, philosophical, or opinion). Along with the summary, the app generates a classification (`extraction.yaml`) according to the project's form facets, and, if the thesis has a defined topic, that paper's relation to the thesis. If the project doesn't have an extraction form yet, summarizing creates the default form first (see "Form" under Settings) automatically.

Every field, facet and the thesis relation carry:

- **Evidence**: one or more verbatim quotes, with the page number when it applies. Each quote with a page shows a «p. N ↗» link that opens the PDF tab at that page with the quote highlighted (on a web page, it opens the Contenido tab instead, with the quote highlighted there too). If the exact text isn't found, there's no link; the extracted passage around that quote is only shown in Review mode (see below).
- **Status**: *generado* (generated) (just created by Claude, unreviewed), *verificado* (verified) (you confirmed it's correct), *editado* (edited) (you corrected it by hand), or *evidencia no encontrada* (evidence not found) (Claude generated the field with a quote that isn't found in the text: review it carefully). An edited value is already considered yours and doesn't go back to *generado* unless you unverify it from *verificado*.
- **Provenance**: the model and date that particular field was generated with, or the whole summary's if the field has none of its own.

Actions on each field: **Verificar** (Verify) (moves to verified), **Desverificar** (Unverify) (goes back to generated), and **Editar** (Edit) (opens an editor and saves as edited). **Verificar todo** (Verify all) marks everything still *generado* in that paper as verified, in one go.

**Proposed values**: if Claude returns, for a single- or multiple-choice facet, a value that isn't in the allowed list, it's left as "proposed" under that facet. You can **Aceptar** (Accept) it (adds it as an allowed value of the facet) or **Mapear a…** (Map to…) (associates it with an existing value, as an alias). Both actions apply to every paper with that same proposal, not just the one you're viewing.

**Regenerate and model**: «Regenerar» (Regenerate) resummarizes the paper with the configured model; «Regenerar con…» (Regenerate with…) lets you pick the model for that one time without changing the one in Settings. Regenerating never overwrites a field that's already verified or edited — it only updates what was still *generado*.

**Force and truncation**: if the paper's text exceeds the configured maximum input size, the «Resumir» (Summarize) button (when the paper has no summary yet) is disabled and shows «El texto es demasiado largo» (The text is too long), with «Forzar» (Force) next to it to summarize using only the beginning of the text up to that maximum. If the paper already has a summary, «Regenerar» stays enabled: tapping it fails with «El texto supera el tamaño máximo configurado.» (The text exceeds the configured maximum size.), and «Forzar» appears then. A summary already made from truncated text re-forces itself automatically when regenerated (whether on its own or inside a batch), without needing to tap «Forzar» again. The resulting summary is marked «Resumido solo con el comienzo del texto: el paper supera el máximo de caracteres» (Summarized using only the beginning of the text: the paper exceeds the maximum number of characters).

**Stale**: a summary becomes *Desactualizado* (Stale) when the extraction form changes (removing a facet the paper has, or changing its key, type, description, or — on a scale — its minimum or maximum; adding a facet does not make it stale: on that paper the facet shows «Faceta nueva sin llenar» (New facet not filled), see "Facets suggested by Claude" — unless the paper still keeps values of an earlier facet with that same key, removed and then added again, which does make it stale; adding or removing allowed *values* of a facet, or editing aliases, doesn't either) or when the thesis's topic changes (title, description, or research questions; having either the title or the description defined is enough for there to be a relation to the thesis). The next time it's regenerated, everything still in *generado* is regenerated again; what's verified or edited is kept. If the thesis relation was already verified or edited when the thesis changed, the whole summary doesn't become Stale: the thesis relation instead gets marked «La tesis cambió; revisa esta relación» (The thesis changed; review this relation) and the paper moves to «Por revisar» (To review), instead of losing your edit or verification.

**Costs**: every call to Claude logs its estimated cost in USD. Since the account is subscription-based (not billed per use), these numbers are only an estimate of how much quota you're consuming, not an actual charge. A call cut off before it reports its cost (it hit the time limit or you cancelled the job) is logged at the per-paper cap, marked as estimated (`estimated: true`), so it counts toward the batch and monthly caps.

## Review mode

«Revisar pendientes» (Review pending), in the library, opens a sequential run-through of every field, facet and thesis relation still in *generado* status among the visible papers under the active filters, plus previously reviewed thesis relations left pending because the thesis changed (see «La tesis cambió; revisa esta relación» under "Summaries with Claude"); for those, the **Verificar** button reappears.

Keyboard shortcuts (shown on screen as «V verificar · E editar · U desverificar · → siguiente · ← anterior · Esc salir»; ignored while typing in a text field):

- **V**: verify the current item.
- **E**: edit the current item.
- **U**: unverify the current item.
- **→ / ←**: next / previous.
- **Esc**: if an editor is open, it does nothing (close the editor with its own «Cancelar» (Cancel) button); if none is open, exits review mode.

The right-hand panel shows the PDF with the quote highlighted when the paper has one and the quote is found in the text. Otherwise it shows the passage, formatted for reading: for a web page, its content laid out like the **Contenido** tab, with the quote highlighted (or a small notice if the exact text isn't found); if the quote doesn't appear in the PDF, that page's text laid out like the **Texto** tab (headings, paragraphs, running headers and footers dimmed), with the quote marked wherever it can still be located. If the PDF can't be loaded (or there's no content to show), it falls back to the plain extracted text of that page.

The queue also includes suggested typed relations, each one once, next to the first of its two papers in the list. On a relation the shortcuts are «V confirmar · R rechazar · E elegir otro tipo · U deshacer · → siguiente · ← anterior · Esc cerrar la lista o salir»: **V** confirms it, **R** rejects it, **E** opens the list of types (only those the pair doesn't have yet; **Esc** closes it) and **U** undoes the last decision; the card also offers «Invertir dirección» (Reverse direction) for types with a direction. After each decision, «Decisión guardada.» (Decision saved.) shows for a few seconds with «Deshacer» (Undo), which puts the relation back as it was and back in the queue. While that notice shows, **U** undoes that decision even on a summary item; when there is nothing to undo, **U** unverifies as usual. The right-hand panel shows both papers' evidence side by side (the PDF with the quote highlighted or, failing that, the passage, as elsewhere in review mode).

## Citations and candidates

Citations come from [OpenAlex](https://openalex.org), without Claude. For each paper the app finds its OpenAlex work by OpenAlex id, otherwise by DOI and, without a DOI, by exact title and year (only on an unambiguous match; never for web pages). It stores in `paper.yaml` the full list of what the paper cites, in your library or not, and its total citation count in OpenAlex. If nothing is found, the paper gets the *Sin citas* (No citations) badge. When the OpenAlex work found by id has a different DOI than the paper, the paper's DOI wins. Completing or changing a paper's DOI («Completar» (Complete) or «Reintentar» (Retry)) discards the citations of the old work and fetches them again on their own.

OpenAlex limits requests per day. Without a key it's plenty for a few hundred papers; if you hit the limit (in a citations job or while loading the candidates' data), pending citation jobs are cancelled and «Se alcanzó el límite diario de OpenAlex. Reintenta mañana o agrega una clave de API en Ajustes.» (OpenAlex's daily limit was reached. Try again tomorrow or add an API key in Settings.) appears. A free key (Settings → App) raises the budget.

**Candidates** (Map view → «Candidatos») are works not in your library that:

- **«Referencias de tus papers»** (References of your papers): are cited by at least N of your papers.
- **«Trabajos que citan a tus papers»** (Works citing your papers): cite at least N of your papers. To see them, first tap «Buscar quién cita a mis papers» (Find who cites my papers), which asks OpenAlex who cites each paper (one job per paper, in the activity panel). Papers looked up in the last 7 days are skipped, so tapping it again doesn't spend the daily budget twice; after that week it looks them up again.

The table shows title (linking to the DOI or OpenAlex), year, authors, «Citado por tus papers» (Cited by your papers), «Cita a tus papers» (Cites your papers) and «Citas en OpenAlex» (Citations in OpenAlex). **«Agregar»** (Add) ingests it like any DOI (or by OpenAlex id when it has no DOI); **«Descartar»** (Dismiss) stores it in `project.yaml` so it never shows up again (on any machine). Works already in your library (by OpenAlex id or DOI) never show up. A work that is in your trash shows «En la papelera» (In the trash) and comes back with «Restaurar» (Restore); see "Removing papers and the trash".

## Similarity

Each pair of papers gets a score between 0 and 1 that combines:

| Signal | What it measures | Reason shown |
|---|---|---|
| Content | how alike the title, abstract and (when summarized) problem, contribution and method are, according to a local model | «similitud de contenido 0.82» (content similarity 0.82) |
| Bibliographic coupling | shared references | «6 referencias en común» (6 shared references) |
| Facets | shared values in single- or multiple-choice facets | «technique: ner · task: anonymization» |
| Co-citation | library papers that cite both | «citados juntos por 3 papers» (cited together by 3 papers) |
| Direct citation | one cites the other | «zhu2020loghub cita a he2017drain» (zhu2020loghub cites he2017drain) |

The direct-citation reason shows both papers' citation keys. The 10 most similar papers of each paper are kept. Without the local model, the score uses the other signals only. Everything updates on its own when a paper's citations, summary or text change: a single change updates only what involves that paper, and a batch (for example «Actualizar citas» (Update citations) for the whole library) recomputes everything when it ends. If a batch is cancelled partway through, the full recompute is left pending and runs on the next paper change. Changing the extraction form (which changes every paper's facets) also recomputes everything, only if some facet value actually changed.

## Typed relations

Claude can suggest how a paper relates to others in your library:

- **Extiende** (Extends): builds directly on the other one (extends, improves or generalizes it).
- **Usa el método de** (Uses the method of): applies a method, tool, dataset or technique of the other one, without extending it.
- **Compara con** (Compares with): they are compared directly (one is a baseline of the other, or they are evaluated side by side). No direction.
- **Contradice** (Contradicts): reports results or claims that clash with the other one's.
- **Replica** (Replicates): reproduces the other one's study or experiments.
- **Mismo problema** (Same problem): both address the same problem with different approaches, without building on each other. No direction.

**How they are suggested.** For each paper the app picks up to 12 *candidates*: the library papers it cites or that cite it, then the most similar ones (see "Similarity"). Claude gets the paper with its summary (or its abstract), the candidates with a short summary, and the relations already recorded **for that paper** (never the rest of the library's), rejected ones included so they aren't repeated. It then looks for the evidence itself with **read-only** tools over your library: full-text search, search by meaning (if the local model is downloaded), search for literal text inside one paper (ignoring case and accents), reading pages, a paper's data and summary, its citations and its similar papers. It can't write anything or see files outside the project; the tools exist only while that request runs, and it can use them at most 12 times per paper. Every quote it returns is looked up in its paper's text, as with summaries; the ones that can't be found get a wavy underline.

**When.** With «Sugerir relaciones» (Suggest relations) in a paper's Relations tab (it always analyzes the paper, with all its candidates), with the library's «Sugerir relaciones» batch, or automatically, if you turn on «Sugerir relaciones automáticamente» (Suggest relations automatically) under Settings → Claude. The batch and the automatic trigger only analyze a paper when a candidate appeared that its last analysis didn't see, and never look again at a pair already analyzed from the other paper. One paper is analyzed at a time, with the configured model and the same caps as summaries; the cost is logged in `costs/`. A paper that reaches its per-paper cap fails alone and the batch goes on; the batch stops when the Claude quota runs out or the batch or monthly cap is reached. Automatic suggestions of one day count as one batch for the batch cap. When a paper's analysis fails, the automatic trigger leaves it alone for 24 hours (or until the app restarts); the paper's button still works. Tapping «Sugerir relaciones» while that paper already waits in the queue for a batch or automatic analysis turns that job into yours (all candidates, out of the batch); if one is already running, yours is queued after it.

**Reviewing them.** In each paper's Relations tab, the «Relaciones tipadas» (Typed relations) section shows:

- «Sugeridas» (Suggested), with «Confirmar» (Confirm), «Rechazar» (Reject), «Cambiar tipo» (Change type; it only offers types the pair doesn't have yet), «Invertir dirección» (Reverse direction, for types with a direction) and «Editar justificación» (Edit justification). Quotes from this paper carry their page and open the PDF with the quote highlighted; next to the other paper's quotes, «Abrir» (Open) opens that paper.
- «Confirmadas» (Confirmed): they can go back to suggested («Devolver a sugerida»), be rejected or retyped.
- «Rechazadas (N)» (Rejected (N)), folded: rejecting never deletes; «Restaurar» (Restore) puts it back among the suggested ones and «Confirmar» confirms it.

Changing the type or reversing the direction leaves the relation confirmed and marked *editada* (edited); no previous type is ever suggested again. Editing the justification marks it edited without changing its status. After each decision «Deshacer» (Undo) shows for a few seconds. Analyzing a paper again only replaces the unreviewed suggestions an earlier analysis of that same paper made with the candidates it looks at this time (Claude may repeat them if still supported); those for a pair it skips this time, because it was already analyzed from the other paper, are kept; those suggested by the other paper's analysis, and confirmed, rejected and edited ones, are left alone.

**`relations.yaml`.** All relations live in one file at the project root, sorted by `id` (both keys in alphabetical order plus the type, e.g. `he2017drain__zhu2020loghub__extends`), with their status (`suggested`, `confirmed` or `rejected`), the justification, the quotes with their page and whether they were found, and the model, date and paper whose analysis suggested them; plus, under `analyzed`, which candidates each paper was last analyzed with (so a rebuilt index never spends again on what was already analyzed). It is meant to be versioned with git. If a `git pull` leaves conflict markers in it, the app doesn't modify it and shows, in a notice at the bottom of the window, «relations.yaml tiene marcadores de conflicto de git: la app no lo modifica hasta que se resuelva.» (relations.yaml has git conflict markers: the app won't modify it until it's resolved.) with «Resolver automáticamente» (Resolve automatically: it merges both versions by `id`; if the same relation changed on both sides, the most recent change wins; it keeps keys it doesn't know and reports any invalid entries it had to drop) and «Mostrar archivo» (Show file). If the file can't be read for another reason, «relations.yaml no se puede leer: …» (relations.yaml can't be read: …) shows and it has to be fixed by hand.

## Facets suggested by Claude

Claude can propose how to improve the extraction form from your thesis (title, description and research questions), the current form and what is in the library: an inventory of the papers, how each facet is used, and the «propuestos» (proposed) values the summaries left unassigned. To check what it proposes it reads the library with read-only tools (the typed relations' ones, plus listing the papers, reading one paper's summary and facets, and seeing how each facet is used); it never writes anything.

It suggests three things:

- **New facet**: key, type, description and values (or minimum and maximum, on a scale), with a rationale of how it serves your research questions and quoted examples from your papers.
- **New value** for a single- or multiple-choice facet, typically one several papers proposed.
- **Alias**: merges proposed values that mean the same into an existing or new value.

**Suggesting.** In Settings → Formulario (Form), the «Sugerencias de Claude» (Claude's suggestions) section has the «Sugerir facetas» (Suggest facets) button; before queuing it shows how many papers it will look at, the estimated cost and the run's cap. It runs as a job in Actividad (Activity), one at a time. Each new run replaces only the suggestions still waiting for review: accepted and rejected ones are kept, and Claude sees the rejected ones so it doesn't repeat them. It can also run on its own with «Sugerir facetas automáticamente» (Suggest facets automatically; see "Claude" under Settings).

**Reviewing.** Each suggestion shows its kind, the proposal, the rationale and the examples; clicking a quote opens the passage with the quote highlighted (in the PDF, if the paper has one). A quote not found in the text is marked «cita no encontrada en el texto» (quote not found in the text). The buttons:

- «Aceptar» (Accept): applies the suggestion to the form. A new facet is added and the section offers to fill it in the papers already summarized, with the estimated cost; a new value is added to its facet; an alias is added (with its target value, if new). In papers whose facet is still *generado* (generated), the new value or the alias replaces that proposed value; anything verified or edited is left alone.
- «Editar y aceptar» (Edit and accept): opens the proposal in the same card (key, type, description, values or range; the value; or the value the aliases merge into), with the form editor's rules, and accepts it with your changes («Guardar y aceptar», Save and accept).
- «Rechazar» (Reject): folds it under «N rechazadas» (N rejected), where «Restaurar» (Restore) brings it back for review.
- «Deshacer» (Undo) shows for a few seconds after each decision. Undoing an acceptance puts the form and the papers it changed back as they were, as long as nothing changed since.

While the form editor has unsaved changes, nothing can be accepted or edited and accepted («Guarda o descarta los cambios del formulario antes de aceptar sugerencias.», Save or discard the form's changes before accepting suggestions). If the form changed since the suggestion (say, you already added that facet, or no paper proposes those values any more), the suggestion says why it no longer applies and can only be rejected. Accepted ones are folded under «N aceptadas» (N accepted). The tab reads «Formulario (N)» and the section «N sugerencias por revisar» (N suggestions to review).

**Filling new facets.** Adding a facet (by accepting a suggestion or by hand in the editor) doesn't make summaries stale: papers already summarized show «Faceta nueva sin llenar» (New facet not filled; in the list and in the Resumen tab, with «Facetas nuevas sin llenar: …») and are filled by a cheap job per paper that asks Claude for the new facets only, with evidence, without regenerating the summary or touching anything verified or edited. Filled values are *generado* (generated), to be reviewed like the rest. Filling is offered right after accepting a new facet, with «Llenar en N papers» (Fill in N papers); from the paper, with «Llenar facetas nuevas (~$x)» (Fill new facets), which opens a confirmation with the estimated cost and the batch cap before queuing; or in a batch with the library's «Llenar facetas nuevas» (every paper with an up-to-date summary that needs it, or only the visible ones when a search or filter is active; the «Con facetas sin llenar» (With unfilled facets) filter shows them), always asking to confirm with the estimated cost and the batch cap. It uses the same text as the summary: a paper summarized from the beginning of its text only is filled from that same beginning. A paper with a stale summary is not filled (regenerating it brings every facet), and papers you summarize later get the new facets with their summary.

**`facet-suggestions.yaml`.** Suggestions live in one file at the project root, sorted by `id` (the kind plus what it changes, e.g. `new_facet__data_source`), with their status (`suggested`, `accepted` or `rejected`), the rationale, the examples and the last run. It is versioned with the project, and the app's sync merges it on its own.

**Costs.** Each run is logged in `costs/` as `suggest_facets` (with no paper) and each fill as `fill_facets`.

## Chat with Claude

You can talk with Claude about your library in two places:

- **The Chat view** (💬 in the side rail): all your conversations, newest first, with a search box (it searches titles and messages, ignoring case and accents), a paper filter and the archived ones folded at the end («N archivadas», N archived). «Nueva conversación» (New conversation) starts one about the whole library.
- **A paper's Chat tab**: the conversations about that paper, and «Nueva conversación». Claude gets the paper's metadata and summary, and can still search the rest of the library.

**How it answers.** Every message you send (Enter sends; Shift+Enter adds a line break) goes to Claude with your thesis, the paper (in its tab) and the conversation so far: the latest messages in full and one line per older message. Claude searches your library with the same read-only tools it uses for typed relations (full-text search, search by meaning, finding a sentence in a paper, reading pages, reading the summary, citations and similar papers), at most 12 times per answer and for at most 10 minutes, and never writes anything. What the tools return is passed to it as data, never as instructions. The answer shows up as it's written; meanwhile the message box is disabled and «Detener» (Stop) cuts it short: what it had written is kept as a «respuesta detenida» (stopped answer).

**Verified citations.** Claude must back every claim about a paper with a citation: the key, the page and the sentence copied verbatim. The app checks each sentence against the paper's text, with the same tolerance as the summaries' evidence, and shows it as a chip «clave, p. N» (key, p. N). If it isn't found, the chip says «no encontrada» (not found); if the paper is in the trash, «paper en la papelera» (paper in the trash); if it can't tell which paper it refers to, «paper desconocido» (unknown paper). Under the answer, it says how many citations couldn't be verified. Clicking a chip opens the paper's PDF (or web content) on the right at that page, with the sentence highlighted; if it can't be highlighted, the page's text is shown.

**Under each answer** you see its model and cost, and three buttons; none writes anything without your click:

- «Copiar» (Copy): the answer in Markdown, with its citations as text (`"sentence" [key, p. N]`).
- «Guardar en notas del paper» (Save to the paper's notes): appends it to the end of `notes.md`, under a heading with the date and the conversation's title. In a paper's tab it goes to that paper; in the Chat view you pick the paper (cited ones first).
- «Copiar BibTeX de las citas» (Copy the citations' BibTeX): the BibTeX entries of the cited papers in your library.

**Asking about a selection.** Selecting text in the PDF tab or in Contenido shows «Preguntar a Claude» (Ask Claude): it opens the paper's Chat tab with that excerpt and its page above the message box (remove it with «Quitar fragmento», Remove excerpt), and it's sent, quoted, with your next question. The Texto tab doesn't offer it. A longer selection is cut at 1000 characters. If the selection can't be quoted as is (too short), the button turns into a hint instead: «Esta selección no se puede citar: selecciona un poco más de texto.» (This selection can't be quoted: select a bit more text.).

**The conversation header** has the model selector (a new conversation starts with the model in Settings → Claude; changing it applies to the next answers), the running cost, «Renombrar» (Rename), «Archivar» / «Desarchivar» (Archive / Unarchive) and «Borrar» (Delete; it asks first, and git history keeps the file). The title comes from the first question.

**Errors.** If Claude is unavailable, the quota ran out, a cap was reached or it took too long, the notice shows in the conversation with «Reintentar» (Retry). Your question stays saved without an answer (even if you close the app) and «Reintentar» sends it again. If the monthly cap doesn't allow it, the message isn't sent and its text stays in the box.

**Spending.** Each answer has its own cap, «Tope por mensaje de chat (USD est.)» (Per chat message cap (est. USD); 0.5 by default, in Settings → Claude), and counts toward the monthly cap. A stopped answer, or one that took too long, is counted at its cap as an estimate.

**Where they're stored.** Each conversation is a `chats/<id>.md` file, readable Markdown you can edit by hand: its data at the top (title, paper, model, dates, whether it's archived, and the cost), then the messages under `## Tú — <date>` and `## Claude — <date> · <model> · <cost>` headings, with citations written as `[[key|p. N|"sentence"]]`. Anything you write before the first heading is lost the next time the app writes the file. They're versioned and synced with git (see "How it merges" in "Syncing with git"). If you move a paper to the trash, its conversations are kept and their header says the paper is in the trash.

## Map

The **Mapa** (Map) view (side rail) has three tabs:

- **Grafo** (Graph): one node per paper (larger the more citations it has in OpenAlex) and two kinds of edges: citations (solid arrow) and similarity (dashed, thicker the more alike). Hover a dashed edge to see its reasons; click a node to open its detail on the side. Controls: **«Lente»** (Lens) «Área» (Field; colored by the facet you pick; a paper with several values takes the one most frequent in the library) or «Tesis» (Thesis; colored by the 1–5 relevance of the thesis relation, gray without one); show or hide citations and similarity; «Umbral de similitud» (Similarity threshold); «Aplicar los filtros de la biblioteca» (Apply the library's filters; uses the papers visible the last time you opened the library); «Exportar PNG» (Export PNG; the graph exports to PNG only). Typed relations are drawn with one color per type: solid when confirmed, dotted when suggested, with an arrow except for the types without direction. The «Relaciones:» (Relations:) row has one switch per type and «Ocultar sugeridas» (Hide suggested); hovering a relation shows its type.
- **Gráficas** (Charts): «Barras por valor» (Bars per value), «Burbujas faceta × faceta» (Facet × facet bubbles; empty cells show as gaps) and «Papers por año» (Papers per year). With «Solo revisadas» (Reviewed only) off, every facet value counts and unreviewed ones are drawn fainter; on, only verified or edited ones. Entries that no longer fit their facet's current type don't count. Clicking a bar or bubble opens the library filtered. They export to SVG, PNG and CSV.
- **Candidatos** (Candidates): see "Citations and candidates".

## Settings

Settings are organized in tabs.

Tabs are navigable with ←/→/Home/End; the app remembers the last tab you had open. Most fields save themselves as soon as you leave them (immediately for selects and checkboxes) and show «Guardado» (Saved); the extraction form editor is the exception — there, changes stay pending until you tap «Guardar cambios» (Save changes) (see "Form" below).

Defaults for a new project: generated-content language English; PDFs «Versionarlos con git» (Track them with git); model Sonnet; auto-summarize off; suggest relations automatically off; per-paper cap 0.5 USD; per-batch cap 10 USD; monthly cap empty (no cap); maximum input size 400000 characters.

### Project

- **Nombre** (Name): the project's name, shown in the app.
- **Carpeta** (Folder): the project folder's path (read-only).
- **Idioma del contenido generado** (Generated content language): English or Spanish. Used by summaries and, in later stages, other generated responses. Changing it doesn't make existing summaries stale (they stay in the language they were generated with); it applies to new ones.
- **PDFs**: how new PDFs are stored — track them with git, track them with git LFS, keep them outside git (to sync separately, e.g. with Syncthing), or don't store them and download them on demand (open-access papers only). Changing this doesn't move already-stored PDFs, it only affects new ones. With «Guardarlos fuera de git» (Keep them outside git), the app takes care of adding `papers/*/paper.pdf` to `.gitignore`; with «Versionarlos con git LFS» (Track them with git LFS), it takes care of the matching `.gitattributes` — neither needs to be touched by hand.

### Claude

- **Modelo** (Model): Sonnet (recommended), Haiku (faster, lower quality), or Opus (highest quality, uses more quota). It's the default model for summarizing; you can pick another one just for that time with «Regenerar con…» or when confirming a batch.
- **Resumir automáticamente al agregar papers** (Auto-summarize when adding papers): if on, at the end of an add/merge/metadata-completion job, every paper left with indexed text, no summary (or a stale or failed one), and a valid form gets queued to summarize itself; over-long papers aren't auto-summarized (they need «Forzar» by hand).
- **Sugerir relaciones automáticamente** (Suggest relations automatically): if on (off by default), once a paper has a summary and citations, and its candidates changed since its last analysis, a typed relation suggestion is queued on its own. It uses Claude quota.
- **Sugerir facetas automáticamente** (Suggest facets automatically): if on (off by default), once as many new papers as **Papers resumidos nuevos para sugerir** (New summarized papers before suggesting; 10 by default) got a summary since the last facet suggestion, one is queued on its own («Sugerir facetas (automático)» in Activity), at most once a day; if it fails, it tries again the next day. It never accepts anything: it leaves the suggestions to review in Settings → Formulario. It uses Claude quota.
- **Tope por paper (USD est.)** (Per-paper cap (est. USD)): the estimated maximum a single summary can cost. It can't be left empty or be 0 or negative. It applies per call to Claude (as `--max-budget-usd`); a summary can make up to two call attempts, filling a paper's new facets («Llenar facetas nuevas») also up to two, and a relation suggestion, one.
- **Tope por lote (USD est.)** (Per-batch cap (est. USD)): the estimated maximum accumulated within a single batch operation (summarize pending or regenerate filtered). Once reached, that batch's jobs still queued are cancelled. It can't be left empty or be 0 or negative.
- **Tope por sugerencia de facetas (USD est.)** (Facet suggestion cap (est. USD)): the estimated maximum of one «Sugerir facetas» run (2 by default), which reads the whole library and so has its own cap instead of the per-paper one. It also counts toward the monthly cap; each day's automatic runs also share the per-batch cap with the automatic relation suggestions.
- **Tope por mensaje de chat (USD est.)** (Per chat message cap (est. USD)): the estimated maximum of each chat answer (0.5 by default). It also counts toward the monthly cap.
- **Tope mensual (USD est., vacío = sin tope)** (Monthly cap (est. USD, empty = no cap)): the estimated maximum accumulated in the month, adding up spend from all your machines (see "Gasto estimado este mes" below). It's the only one of the three caps that can be left empty, and empty means no cap. The month is counted as the calendar month in UTC, across every device syncing the project.
- **Tamaño máximo de entrada (caracteres)** (Maximum input size (characters)): how much of the paper's text is sent to Claude at most. A longer paper can't be summarized without using «Forzar» (see "Summaries with Claude").
- **Gasto estimado este mes (todos tus equipos)** (Estimated spend this month (all your machines)): the sum of estimated costs logged this month in `costs/`, from any device syncing this project. With a subscription, these costs are estimates of the quota you're consuming, not actual charges.

### Thesis

- **Título** (Title) and **Descripción** (Description) (problem, approach, scope): the thesis topic Claude uses to explain how each paper relates to it. Having either one filled in is enough to start getting relations; while both are missing, the summary leaves out that section («Define el tema de tu tesis en Ajustes para obtener esta sección.» (Define your thesis's topic in Settings to get this section.)). Summaries generated before either was filled in become *Desactualizadas* (Stale) and show «Regenera el resumen para obtener la relación con la tesis.» (Regenerate the summary to get the relation to the thesis.).
- **Preguntas de investigación** (Research questions): added and removed with their buttons; each has its own identifier (RQ1, RQ2…) that **never gets renumbered or reused**, even if you delete the question with the highest number — so a question keeps being the same reference in already-generated summaries even if its position in the list changes. Those identifiers show up as chips in the summary's thesis-relation card, not in this tab.
- Changing the title, description, or questions makes existing summaries stale (see "Stale" under "Summaries with Claude").

### Form

The extraction form defines the facets (columns) Claude classifies each paper with. It's edited from this tab; you can also see the raw YAML with «Mostrar project.yaml» (Show project.yaml) (which opens `project.yaml` in the file explorer), a button that only appears when the form is valid.

If the project doesn't have a form yet, a button offers «Crear formulario por defecto» (Create default form), which is the form designed for this thesis:

| Facet | Type | What it classifies |
| --- | --- | --- |
| `sanitization_technique` | multiple choice | How sensitive data in the logs is removed or transformed (rules/regex, NER, pseudonymization, differential privacy, LLM-based, none) |
| `data_type` | multiple choice | The kind of operational data the work processes (logs, traces, tickets, postmortems, code, chats) |
| `llm_usage` | single choice | How language models are used, if at all (none, cloud API, local, fine-tuned) |
| `task` | multiple choice | Main task (anonymization, log parsing, root-cause analysis, postmortem generation, summarization) |
| `traceability` | free text | Whether results can be traced back to their source evidence, and how |
| `privacy_evaluation` | free text | How privacy or data leakage is evaluated (metrics, datasets) |
| `rigor` | scale (1 to 5) | Methodological rigor: evaluation design, datasets, baselines, and reproducibility |

If `project.yaml` has a form with errors, the detected problems are listed and you have to fix them by hand in the file before you can edit it here.

For each facet you can edit:

- **Clave** (Key): in English, lowercase and underscores (e.g. `dataset_public`). Only changeable when creating the facet; once a facet is saved, its key and type are fixed and can't be edited.
- **Tipo** (Type): single choice, multiple choice, free text, or scale. Also only editable when creating it.
- **Descripción** (Description): what Claude reads to understand what to classify there.
- **Valores permitidos** (Allowed values) (single/multiple choice): added and removed with their buttons; the text must be in English, lowercase and underscores. Removing a value also drops its learned aliases.
- **Mínimo / Máximo** (Minimum / Maximum) (scale): the scale's integer bounds; the minimum can't be greater than the maximum.
- **Alias aprendidos** (Learned aliases): values Claude proposed that you already mapped to an allowed value (see "Proposed values" under "Summaries with Claude"); they can be removed one by one.

**What makes summaries stale and what doesn't**: removing a facet, or changing the key, type or description of a facet a paper already has, or — on a scale — the minimum or maximum, makes that summary stale. Adding a facet makes nothing stale: papers already summarized show «Faceta nueva sin llenar» (New facet not filled) and are filled separately (see "Facets suggested by Claude"); papers you summarize later get it with their summary. The exception is a key that papers still hold from an earlier facet you removed (their values stay in the files): adding a facet with that same key again makes those papers stale. Adding or removing an allowed *value*, or editing aliases, doesn't either. Reordering facets (by hand, editing the YAML) does change the hash that determines whether a summary is stale.

When saving changes, the app first shows the impact (how many summaries will become stale, and whether a value you're about to remove is still in use on any paper — that value is kept on those papers even if you remove it from the list) before asking for confirmation.

**Removing and recreating a facet**: what was already extracted for that facet stays in each paper's files even if you remove it from the form, and comes back if you recreate a facet with the same key (though with a different type, whatever was saved that doesn't match the new type is treated as absent). Removing the facet also drops its learned aliases.

**Restaurar formulario por defecto** (Restore default form) resets the form back to the table above and clears all learned aliases; what was already extracted stays as-is in the files. Unlike saving changes to a facet, this action doesn't show an impact preview before confirming, and it can leave summaries stale.

If the form changed from outside this editor (another machine, a `git pull`) while you had unsaved changes of your own, a notice appears to discard yours and reload.

Below the editor is the «Sugerencias de Claude» (Claude's suggestions) section (see "Facets suggested by Claude"); the tab reads «Formulario (N)» when N suggestions are waiting for review.

### App

- **Correo de contacto para Crossref y OpenAlex** (Contact email for Crossref and OpenAlex): optional. Crossref gives priority to requests that include it (OpenAlex no longer uses it). It's sent only to those services. It's a per-device app setting, not stored in `project.yaml`, and therefore not synced between machines.
- **Clave de API de OpenAlex** (OpenAlex API key): optional and free. Without a key OpenAlex allows about 1000 requests a day; with one, more. Stored on this machine only and sent only to OpenAlex.
- **Modelos locales** (Local models): the content-similarity model (multilingual-e5-small, about 470 MB) runs on your machine. Shows whether it's downloaded and how much space it takes, with «Descargar» (Download; progress shows in Activity) and «Borrar» (Delete). It's stored in the app's data folder, never in the project, so each machine downloads it once. The download runs as a job of the open project (one must be open); if you close the project or the app midway, it resumes the next time you open that project. «Borrar» (Delete) cancels the similarity computations still queued.
- **Sincronizar automáticamente** (Sync automatically) and **Cada (minutos)** (Every (minutes)): the automatic git sync (see "Syncing with git"), when the project opens and every 5 to 120 minutes (10 by default). It's a per-device setting, not stored in `project.yaml`.
- **Cerrar proyecto** (Close project): returns to the welcome screen to create or open another project.

## Project files

```
project.yaml               project config (name, language, PDF policy, Claude, thesis, extraction form, dismissed candidates)
relations.yaml             typed relations between papers (suggested, confirmed and rejected)
facet-suggestions.yaml     facets, values and aliases Claude suggested for the form, with their status
chats/<id>.md              conversations with Claude, one per file
papers/<key>/              one paper per folder; <key> is its citation key and never changes
  paper.yaml               metadata, BibTeX and citations (OpenAlex)
  summary.md               summary fields, with evidence and per-field status
  extraction.yaml          classification per the form, and the relation to the thesis
  notes.md                 your notes
  content.md               readable text (grey literature, pages without a PDF)
  paper.pdf                the PDF, per the configured policy
.trash/<key>/              a paper removed from the library, with all its files
  trashed.yaml             when and on which machine it was removed
costs/<device>.jsonl       estimated costs of each call to Claude, one per device (so syncing between machines never conflicts)
exports/library.bib        BibTeX for the whole library; generated, don't edit it
.cache/                    local search index, PDFs downloaded on demand, incoming citations, candidate data, vectors, similar papers, the relations index and the trash index; can be deleted without losing anything, rebuilds itself
```

Everything above, except `.cache/`, is meant to be versioned with git or synced between machines. `notes.md`, the `chats/` conversations and `project.yaml` (outside `extraction_form`) can be edited by hand with confidence; `paper.yaml`, `summary.md` and `extraction.yaml` too, but carefully, so as not to break their format. A file edited from outside the app (or updated by a sync) reloads on its own, without restarting the app. The app's sync commits only this folder (without `.cache/`) and keeps its temporary files inside `.git/`.

## Common problems / FAQ

**«No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.»** (Couldn't use Claude: check that the `claude` CLI is installed and signed in.)
Install the `claude` CLI and run `claude login` in a terminal.

**«Se alcanzó el presupuesto configurado.»** (The configured budget was reached.)
The per-batch or monthly cap configured under Settings → Claude was reached, so the app didn't make the call. Raise the relevant cap (or leave the monthly one empty to remove it) and retry. A single paper reaching its per-paper cap shows a different message: «La operación llegó a su tope por paper y se detuvo…» (see below).

**«Se agotó la cuota de tu suscripción de Claude. Intenta más tarde.»** (Your Claude subscription quota ran out. Try again later.)
This is a limit of the Claude account, not of this app; wait for the quota to renew.

**«Claude devolvió una respuesta inválida. Vuelve a intentarlo o prueba con otro modelo.»** (Claude returned an invalid response. Try again or use another model.)
Claude didn't return a response the app could parse (a summary tries twice; a relation suggestion, once). Retry later or with another model; if it persists, it may be an issue with the `claude` CLI.

**«Claude tardó demasiado y se canceló.»** (Claude took too long and was cancelled.)
Every call to Claude has a 5-minute limit (10 for suggesting relations); if it's exceeded, it cancels itself and its cost is logged as the per-paper cap (estimated). Retry.

**«No se pudo mover ese paper: su carpeta en la papelera está dañada…»** (That paper couldn't be moved: its trash folder is damaged…)
The folder in `.trash/` has no `paper.yaml`, or one with that key already exists. Check it by hand in the project's `.trash` folder (or recover it from git history).

**«Otro programa tiene abierto un archivo de ese paper (por ejemplo, su PDF). Ciérralo y vuelve a intentarlo.»** (Another program has a file of that paper open, e.g. its PDF. Close it and try again.)
This happens mostly on Windows, which won't move a folder with an open file. Close the viewer or editor and repeat the action.

**«Ese paper ya no está en la papelera (quizás ya se restauró).»** (That paper is no longer in the trash; maybe it was already restored.)
«Deshacer» (Undo) or «Restaurar» (Restore) came too late: the paper is already back in the library (from here or from another machine).

**The paper is too long**
The summarize button is disabled and «Forzar» (Force) appears, which summarizes using only the beginning of the text up to the configured maximum size (see "Maximum input size" under Settings → Claude). The resulting summary is marked as made from truncated text.

**Scanned PDF without text**
The paper's status shows «PDF sin texto (escaneado)» (PDF without text (scanned)); this app doesn't do OCR, so that paper can't be summarized until you get a version with text.

**«Los metadatos están incompletos.»** (Metadata is incomplete.)
Title, authors, or other paper data still needs completing. Paste a DOI or arXiv id next to the notice and tap «Completar» (Complete), or «Reintentar» (Retry) if it already had one.

**«El formulario cambió fuera de este editor»** (The form changed from outside this editor)
Another machine (or a `git pull`) changed `project.yaml` while you had unsaved changes of your own in the form editor. Use «Descartar mis cambios y recargar» (Discard my changes and reload) to see the new version, and reapply your changes if they were still needed.

**«El formulario de extracción en project.yaml tiene errores.»** (The extraction form in project.yaml has errors.)
The form stored in `project.yaml` isn't valid (for example, you edited it by hand and it ended up malformed). Fix it directly in the file; the Form tab in Settings lists the detected problems and won't let you edit it there until they're resolved.

**«El archivo cambió fuera de la app.»** (The file changed from outside the app.)
This is the general conflict notice: another machine or a sync changed a paper's file while the app had it open. See "Conflicts when two machines edit" below.

**Conflicts when two machines edit**
If `notes.md`, `paper.yaml`, `summary.md` or `extraction.yaml` changed on disk between the app reading them and trying to save them (for example, two machines syncing at once), the app warns of the conflict instead of overwriting the other change: for notes, it lets you choose between reloading or overwriting with your version; for the rest, check the file by hand (look for git conflict markers if you use git) before retrying.

**«Se alcanzó el límite diario de OpenAlex. Reintenta mañana o agrega una clave de API en Ajustes.»** (OpenAlex's daily limit was reached. Try again tomorrow or add an API key in Settings.)
OpenAlex limits how many requests can be made per day. Pending citation jobs are cancelled; tap «Actualizar citas» (Update citations) again the next day, or add a free key under Settings → App.

**A paper shows the «Sin citas» (No citations) badge**
It wasn't found in OpenAlex: it has no DOI and the title-and-year search gave no exact match. Complete its DOI (metadata notice or «Completar» (Complete)): its citations are fetched again on their own.

**«El modelo local de similitud no está descargado. Descárgalo en Ajustes → Aplicación.»** (The local similarity model isn't downloaded. Download it in Settings → App.)
Content similarity needs the local model. Until it's there, similarity uses citations and facets only.

**«No se pudo cargar el modelo local de similitud. Bórralo y vuelve a descargarlo en Ajustes → Aplicación.»** (The local similarity model couldn't be loaded. Delete it and download it again in Settings → App.)
The model files are incomplete or damaged (for example, an interrupted download). Use «Borrar» (Delete) and then «Descargar» (Download).

**«No se pudieron preparar las herramientas de búsqueda de la biblioteca para Claude. Reintenta; si sigue fallando, reinicia la app.»** (The library search tools for Claude couldn't be set up. Try again; if it keeps failing, restart the app.)
The app couldn't start, on your machine, the local server (only on `127.0.0.1`) through which Claude reads your library. Nothing was spent. Try again; if it persists, restart the app.

**«relations.yaml tiene un conflicto de git o un error; resuélvelo antes de cambiar relaciones.»** (relations.yaml has a git conflict or an error; resolve it before changing relations.)
Use «Resolver automáticamente» (Resolve automatically) in the notice at the bottom of the window (see "Typed relations"), or fix the file by hand.

**«La operación llegó a su tope por paper y se detuvo. Sube «Tope por paper (USD est.)» en Ajustes → Claude o reintenta con otro modelo.»** (The operation reached its per-paper cap and stopped. Raise «Tope por paper (USD est.)» under Settings → Claude or retry with another model.)
That paper went over the per-paper cap during the request. Only that paper fails: a running batch goes on with the rest.

**«Hay conflictos en archivos fuera de la carpeta del proyecto: …»** (There are conflicts in files outside the project folder: …)
The project lives inside a bigger repository and the other machine changed the same outside files you did. The app doesn't touch them: resolve them with git (`git pull`) and sync again. Your project changes are already in a local commit.

**«Hay cambios locales sin commit que la sincronización sobrescribiría: …»** (There are uncommitted local changes the sync would overwrite: …)
The other machine changed files you have modified here without committing (outside the project folder, or ignored by git, like a PDF). Commit or move them with git and sync again.

**«Hay un merge o un rebase hecho a mano sin terminar…»** (There's a hand-run merge or rebase left unfinished…)
This repository has a git merge or rebase left halfway through. Finish it or cancel it with git (`git merge --abort` or `git rebase --abort`) and sync again.

**«El remoto rechazó tus credenciales o no tienes permiso…»** (The remote rejected your credentials or you don't have permission…)
git couldn't authenticate. Check that your SSH key is loaded (`ssh-add`) or that git's credential manager has your user; try a `git fetch` in a terminal. The app never asks for passwords.

**«No se pudo conectar con el remoto…»** (Couldn't connect to the remote…)
No network, or the server doesn't answer. Your changes stay in a local commit («Cambios sin subir», Changes not pushed) and the automatic sync tries again by itself.

**«git tardó demasiado y se canceló…»** (git took too long and was cancelled…)
When pushing or fetching, git is cancelled only after 3 minutes without any progress (not for taking long: the first sync of a big library with its PDFs can take a good while and goes on as long as it moves). It's usually a connection that dropped halfway: check it and sync again.

**«Este proyecto guarda los PDF con git LFS y git-lfs no está instalado…»** (This project keeps its PDFs in git LFS and git-lfs isn't installed…)
Install git-lfs (https://git-lfs.com), or change the PDF policy in Settings → Project.

**«No se pudieron subir los PDF a git LFS…»** (The PDFs couldn't be uploaded to git LFS…)
The commits stay unpushed until their PDFs are on the remote. Check that the remote accepts git LFS (some servers have it turned off) and that this machine has the PDFs: `git lfs push origin <branch>` in a terminal names the one that's missing.

**«git no sabe tu nombre ni tu correo…»** (git doesn't know your name or email…)
Set them once in a terminal: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.

**«El remoto tiene una historia distinta de la de este repositorio…»** (The remote has a different history from this repository…)
You initialized a repository here and the remote already held another project. Clone the remote into another folder and open that folder as the project.
