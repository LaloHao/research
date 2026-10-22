# Research

*[Versión en español](./README.es.md)*

A personal desktop app for thesis research: a paper library with BibTeX, full-text search, Claude-generated summaries, citations from OpenAlex, similar papers, a map of the field, typed relations and facet suggestions by Claude, chat with Claude over the library with verified citations and actions from the chat behind the app's confirmation rules, a versioned trash to remove and restore papers, git sync between machines from the app, systematic mappings with a protocol, a search log, screening with Claude's suggestions and a PRISMA diagram, a «Redacción» (Writing) view for the thesis (a chapter's `.bib` with only the entries it cites, a check of the citations in a text, and an outline of the state of the art by facets with its gaps, for Org, LaTeX or Markdown), and, in later stages, drafts, citation checks, outline wording and style review with Claude, a second reviewer, quality assessment and mapping reports.

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

## Development

```bash
pnpm test        # tests (no network)
pnpm typecheck
pnpm check       # both
./scripts/record-fixtures.sh   # re-record the tests' HTTP fixtures
```

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
