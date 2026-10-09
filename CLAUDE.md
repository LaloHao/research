# Research

Personal desktop app (Electron + React + TypeScript) for thesis research:
a paper library, BibTeX, and in later stages summaries, relations, chat, and systematic mapping.

- Design and per-stage plans exist locally under `docs/specs/` and `docs/plans/`, but are not committed.

## Conventions
- All internal content (code, YAML/JSON keys, enums, SQL, error codes) and all file names in English. Only UI translations go in Spanish, via i18n (`src/renderer/i18n/es.json`).
- User-facing docs (`docs/guide.md` + `docs/guide.es.md`, `README.md` + `README.es.md`) are bilingual and must be updated with every user-visible change.
- `docs/backlog.md` is versioned and holds parked items and backlog notes.
- Source of truth: files in the project folder. `.cache/` is rebuildable.
- `ProjectStore` is the only thing that writes to the project folder.
- Tests don't use the network: inject `FetchFn`.
- Don't commit `docs/specs/`, `docs/plans/` or `.superpowers/`.
- Commits without a `Co-Authored-By` trailer.

## Commands
- `pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm check`
