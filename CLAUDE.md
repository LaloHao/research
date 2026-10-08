# Research

App de escritorio personal (Electron + React + TypeScript) para la investigación de una tesis:
biblioteca de papers, BibTeX, y en etapas posteriores resúmenes, relaciones, chat y mapeo sistemático.

- Diseño: `docs/specs/2026-10-07-research-assistant-design.md`
- Planes por etapa: `docs/plans/`

## Convenciones
- Todo lo interno en inglés (código, claves YAML/JSON, enums, SQL, códigos de error). Solo la UI en español, vía i18n (`src/renderer/i18n/es.json`).
- Fuente de verdad: archivos en la carpeta del proyecto. `.cache/` es reconstruible.
- `ProjectStore` es el único que escribe en la carpeta del proyecto.
- Las pruebas no usan red: inyecta `FetchFn`.
- No hacer commits de `docs/` (specs y planes) ni de `.superpowers/`.
- Commits sin trailer `Co-Authored-By`.

## Comandos
- `pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm check`
