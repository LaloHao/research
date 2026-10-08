# Research

App de escritorio personal para la investigación de una tesis: biblioteca de papers con BibTeX, búsqueda de texto completo y, en etapas siguientes, resúmenes, relaciones, chat y mapeo sistemático.

## Requisitos

- Node.js 24 o superior y pnpm 12 (`corepack enable`)

## Uso

```bash
pnpm install
pnpm dev
```

Crea un proyecto en una carpeta vacía. Agrega papers pegando un DOI, un ID de arXiv o una URL, o arrastrando PDFs. La app mantiene `exports/library.bib` para LaTeX u org-cite.

## Carpeta de proyecto

```
project.yaml             configuración del proyecto
papers/<clave>/          un paper por carpeta; <clave> es su clave de cita y nunca cambia
  paper.yaml             metadatos y BibTeX
  notes.md               tus notas
  content.md             texto legible (literatura gris)
  paper.pdf              según la política de PDFs
exports/library.bib      generado; no lo edites
.cache/                  índice local; se puede borrar y se reconstruye
```

Todo menos `.cache/` está pensado para versionarse con git o sincronizarse entre equipos.

## Desarrollo

```bash
pnpm test        # pruebas (sin red)
pnpm typecheck
pnpm check       # ambas
./scripts/record-fixtures.sh   # vuelve a grabar las respuestas HTTP de las pruebas
```

Diseño: `docs/specs/2026-10-07-research-assistant-design.md`.
