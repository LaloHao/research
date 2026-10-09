# Research

*[Versión en español](./README.es.md)*

A personal desktop app for thesis research: a paper library with BibTeX, full-text search, Claude-generated summaries, and, in later stages, relations, chat, and systematic mapping.

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
