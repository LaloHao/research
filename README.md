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

## Resúmenes (etapa 2)

Resumir un paper requiere la CLI `claude` instalada y con sesión iniciada (`claude login`); la app la invoca sin red propia, en modo no interactivo y sin herramientas ni MCP.

Cómo resumir:

- **Un paper**: botón "Resumir" en su detalle.
- **En lote**: botón de resumen por lotes, que encola todos los papers pendientes dentro del presupuesto del proyecto.
- **Automático**: si `llm.auto_summarize` está activo en `project.yaml`, cada paper nuevo se resume al terminar su ingestión.

El resultado queda en la carpeta del paper: `summary.md` (campos del resumen) y `extraction.yaml` (facetas de clasificación), ambos con evidencia y estado (`generated`, `verified`, `edited`) por campo. El costo estimado de cada llamada se registra en `costs/<device-id>.jsonl`.

El formulario de clasificación (las facetas que se extraen de cada paper) se edita en `project.yaml`, bajo `extraction_form`.

### Evaluación con Claude real

`pnpm eval:summaries` corre una evaluación opcional contra la CLI real de Claude, sobre una copia temporal y descartable de un proyecto real (nunca escribe en el proyecto original):

```bash
EVAL_PROJECT=~/ruta/a/mi/proyecto pnpm eval:summaries
```

**Consume cuota real de Claude.** Variables opcionales: `EVAL_MODEL` (modelo a usar, por defecto `sonnet`) y `EVAL_LIMIT` (cuántos papers resumir como máximo, por defecto 5). Sin `EVAL_PROJECT` la prueba aparece como omitida y `pnpm test`/`pnpm check` nunca la incluyen.

## Desarrollo

```bash
pnpm test        # pruebas (sin red)
pnpm typecheck
pnpm check       # ambas
./scripts/record-fixtures.sh   # vuelve a grabar las respuestas HTTP de las pruebas
```

Diseño: `docs/specs/2026-10-07-research-assistant-design.md`.
