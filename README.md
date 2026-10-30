# Research

*[Versión en español](./README.es.md)*

A personal desktop app for thesis research: a paper library with BibTeX, full-text search, Claude-generated summaries, citations from OpenAlex, similar papers, a map of the field, typed relations and facet suggestions by Claude, chat with Claude over the library with verified citations and actions from the chat behind the app's confirmation rules, a versioned trash to remove and restore papers, git sync between machines from the app, systematic mappings with a protocol, a search log, screening with Claude's suggestions and a PRISMA diagram, a «Redacción» (Writing) view for the thesis (a chapter's `.bib` with only the entries it cites, a check of the citations in a text, with Claude's verdict on whether each cited paper supports its sentence, drafts written by Claude from chosen papers with every citation verified, an outline of the state of the art by facets with its gaps and Claude's wording for it, and Claude's style review, for Org, LaTeX or Markdown), a local API on 127.0.0.1 with an Emacs package (`emacs/research.el`) to cite, check citations (also with Claude), build the `.bib`, insert the outline or its proposal, ask for a draft, review style and find passages from the editor, a writing tutor from the editor that never writes for you (Claude points at what weakens a passage and asks you a question, offers options for one sentence to compare, a reverse outline of a section's paragraphs and the research questions each heading addresses, with verified evidence), a browser extension for Firefox and Chrome (`extension/`) that adds the page open in your own browser with one click, with that browser's session (paired with the app through a one-time code, talking only to the local API), a system tray icon that keeps the app (and its local API) running when the window closes, with its status, adding a DOI or URL from the clipboard, sync, the local API switch and start with the session, local Spanish academic prose checks in Emacs without the app (`emacs/research-prose.el`: long sentences, repetitions, filler, gerunds, passive, INFLESZ readability, term consistency, acronyms), and, in later stages, a second reviewer, quality assessment and mapping reports.

## Screenshots

The interface is in Spanish.

![Library with a paper's summary: each field with its quote, page and review state](docs/images/library-summary.png)

| | |
|---|---|
| ![Typed relation suggested by Claude](docs/images/paper-relations.png) | ![Chat about a paper with verified citations](docs/images/chat.png) |
| Typed relations suggested by Claude, with quotes from both papers | Chat over the library, every claim cited and checked |
| ![Map of the field](docs/images/map-graph.png) | ![Search log of a systematic mapping](docs/images/mapping-search-log.png) |
| Map: citations, similarity and typed relations | Systematic mapping: the search log with exact strings and figures |
| ![Screening](docs/images/mapping-screening.png) | ![PRISMA 2020 diagram](docs/images/mapping-prisma.png) |
| Screening record by record, with Claude's suggestions | PRISMA 2020 diagram computed from the log |

## Requirements

- Node.js 24 or later and pnpm (`corepack enable`)
- To summarize papers: the `claude` CLI installed and signed in (`claude login`)
- To sync from the app: git (and git-lfs if PDFs are tracked with LFS)

## Run

```bash
pnpm install
pnpm dev
```

Full user guide (what the app does, how to add papers, summaries, review mode, each setting, project files): [`docs/guide.md`](docs/guide.md).

## Install as an app (AppImage, Linux)

### From a release

Each release on the [Releases page](https://github.com/LaloHao/research/releases) has `research-<version>-x86_64.AppImage` and its `.sha256`. The install script downloads the latest one, checks its SHA-256 and installs it (no checkout needed; it needs `curl`):

```bash
curl -fsSL https://raw.githubusercontent.com/LaloHao/research/master/scripts/install-appimage.sh | bash -s -- --release
# or from a checkout:
./scripts/install-appimage.sh --release            # the latest release
./scripts/install-appimage.sh --release v0.2.0     # a given one
```

By hand instead: download both files from the Releases page, check with `sha256sum -c research-<version>-x86_64.AppImage.sha256`, then run `./scripts/install-appimage.sh path/to/research-<version>-x86_64.AppImage` (or just `chmod +x` it and run it, without the launcher).

The install script copies the AppImage to `~/Applications/research.AppImage` (replacing the previous one in a single step), adds the launcher `~/.local/share/applications/research.desktop` and the icon (`~/.local/share/icons/hicolor/<size>/apps/research.png`, taken from the AppImage). Then open «research» from the application menu, and, if you want it at login, turn on Settings → Aplicación → «Iniciar con la sesión» from that copy (with «Iniciar oculto en la bandeja», the session start leaves it in the tray).

To update: quit the app (tray → «Salir», or Ctrl+Q) and run the same command again (`--release` installs the newest release). The path stays the same, so the launcher and the autostart entry keep working. The settings, the local model and the log stay in `~/.config/research` (shared with `pnpm dev`).

### Building it yourself

```bash
pnpm install
pnpm dist                        # builds dist/research-<version>-x86_64.AppImage
./scripts/install-appimage.sh    # installs the newest one in dist/ for your user
```

To update a local build: quit the app, then `git pull`, `pnpm install`, `pnpm dist` and `./scripts/install-appimage.sh` again.

AppImages need FUSE (`libfuse2` on Ubuntu 24.04). Without it, run `~/Applications/research.AppImage --appimage-extract-and-run`.

## Development

```bash
pnpm test        # tests (no network)
pnpm typecheck
pnpm check       # both
pnpm test:emacs  # the Emacs packages' ERT tests (EMACS=/path/to/emacs to pick one)
./scripts/record-fixtures.sh   # re-record the tests' HTTP fixtures
pnpm ext:build   # the browser extension (extension/README.md); ext:package zips it, ext:lint runs web-ext lint
```

CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm test:emacs` on every push to master and every pull request.

### Cutting a release

From a clean, up-to-date master:

```bash
pnpm release 0.2.0          # scripts/release.sh: sets package.json's version, commits «Release v0.2.0», tags v0.2.0
git push origin master
git push origin v0.2.0      # the Release workflow takes it from here
```

The tag starts `.github/workflows/release.yml`: it checks that the tag matches package.json's version, runs `pnpm check` and `pnpm test:emacs`, builds the AppImage, and publishes the GitHub release with `research-<version>-x86_64.AppImage`, its `.sha256` and notes listing the commits since the previous tag (`scripts/release-notes.sh`) plus the install command. A version like `0.2.0-rc.1` makes a pre-release. The Emacs packages (`emacs/*.el`) keep their own `Version:` header. Before pushing, `git tag -d v0.2.0 && git reset --hard HEAD~1` undoes it.

### Evaluation against real Claude

`pnpm eval:summaries` runs an optional evaluation against the real Claude CLI, over a temporary, disposable copy of a real project (it never writes to the original project):

```bash
EVAL_PROJECT=~/path/to/my/project pnpm eval:summaries
```

**Uses real Claude quota.** Optional variables: `EVAL_MODEL` (model to use, default `sonnet`) and `EVAL_LIMIT` (maximum number of papers to summarize, default 5). Without `EVAL_PROJECT`, the test shows as skipped, and `pnpm test`/`pnpm check` never include it.

### Similarity evaluation with the real model

`pnpm eval:similarity` embeds a temporary, disposable copy of a real project with the real local model and prints how many papers got a vector, how long it took, how often a cited library paper is among the citing paper's 10 most similar ones (with several weightings), and the top similar papers of a few papers with their reasons:

```bash
EVAL_PROJECT=~/path/to/my/project pnpm eval:similarity
```

The first run downloads the model (~470 MB) to `EVAL_MODELS_DIR` (default `~/.cache/research-eval-models`). `EVAL_FETCH_CITATIONS=1` refreshes citations from OpenAlex first (it uses part of OpenAlex's daily budget). Without `EVAL_PROJECT`, the test shows as skipped; `pnpm test`/`pnpm check` never include it.

### Typed relations evaluation against real Claude

`pnpm eval:relations` asks the real Claude CLI (as an agent with the read-only library tools) for typed relations for a few papers of a temporary, disposable copy of a real project, and prints, per paper, the candidates, the suggested relations and their types, the tool calls, how many quotes were found, what was dropped, the cost and the time. Nothing is written back:

```bash
EVAL_PROJECT=~/path/to/my/project pnpm eval:relations
```

**Uses real Claude quota.** Optional variables: `EVAL_MODEL` (default `sonnet`) and `EVAL_LIMIT` (papers to analyze, default 3). Without `EVAL_PROJECT`, the test shows as skipped; `pnpm test`/`pnpm check` never include it.
