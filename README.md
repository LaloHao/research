# Research

*[Versión en español](./README.es.md)*

A personal desktop app for thesis research: a paper library with BibTeX, full-text search, Claude-generated summaries, citations from OpenAlex, similar papers and a map of the field, and, in later stages, typed relations, chat, and systematic mapping.

## Requirements

- Node.js 24 or later and pnpm (`corepack enable`)
- To summarize papers: the `claude` CLI installed and signed in (`claude login`)

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
