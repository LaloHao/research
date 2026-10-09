# Research

App de escritorio personal para la investigación de una tesis: biblioteca de papers con BibTeX, búsqueda de texto completo, resúmenes con Claude y, en etapas siguientes, relaciones, chat y mapeo sistemático.

## Requisitos

- Node.js 24 o superior y pnpm 12 (`corepack enable`)
- Para resumir papers: la CLI `claude` instalada y con sesión iniciada (`claude login`)

## Uso

```bash
pnpm install
pnpm dev
```

Guía completa de uso (qué hace la app, cómo agregar papers, resúmenes, modo revisar, cada ajuste, archivos del proyecto): [`docs/guia.md`](docs/guia.md).

## Desarrollo

```bash
pnpm test        # pruebas (sin red)
pnpm typecheck
pnpm check       # ambas
./scripts/record-fixtures.sh   # vuelve a grabar las respuestas HTTP de las pruebas
```

### Evaluación con Claude real

`pnpm eval:summaries` corre una evaluación opcional contra la CLI real de Claude, sobre una copia temporal y descartable de un proyecto real (nunca escribe en el proyecto original):

```bash
EVAL_PROJECT=~/ruta/a/mi/proyecto pnpm eval:summaries
```

**Consume cuota real de Claude.** Variables opcionales: `EVAL_MODEL` (modelo a usar, por defecto `sonnet`) y `EVAL_LIMIT` (cuántos papers resumir como máximo, por defecto 5). Sin `EVAL_PROJECT` la prueba aparece como omitida y `pnpm test`/`pnpm check` nunca la incluyen.
