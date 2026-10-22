# Research

*[English version](./README.md)*

App de escritorio personal para la investigación de una tesis: biblioteca de papers con BibTeX, búsqueda de texto completo, resúmenes con Claude, citas desde OpenAlex, papers similares, un mapa del área, relaciones tipadas y facetas sugeridas por Claude, chat con Claude sobre la biblioteca con citas verificadas y acciones desde el chat con las reglas de confirmación de la app, una papelera versionada para quitar y restaurar papers, sincronización entre equipos con git desde la app, mapeos sistemáticos con protocolo, búsquedas registradas, cribado con sugerencias de Claude y diagrama PRISMA, una vista «Redacción» para la tesis (el `.bib` de un capítulo solo con las entradas que cita, la revisión de las citas de un texto y un esquema del estado del arte por facetas con sus huecos, para Org, LaTeX o Markdown), una API local en 127.0.0.1 con un paquete de Emacs (`emacs/research.el`) para citar, verificar citas, generar el `.bib`, insertar el esquema y buscar pasajes desde el editor y, en etapas siguientes, borradores, verificación de citas, redacción del esquema y revisión de estilo con Claude, segundo revisor, evaluación de calidad y reporte de los mapeos.

## Capturas

![Biblioteca con el resumen de un paper: cada campo con su cita, página y estado de revisión](docs/images/library-summary.png)

| | |
|---|---|
| ![Relación tipada sugerida por Claude](docs/images/paper-relations.png) | ![Chat sobre un paper con citas verificadas](docs/images/chat.png) |
| Relaciones tipadas sugeridas por Claude, con citas de los dos papers | Chat sobre la biblioteca, cada afirmación citada y verificada |
| ![Mapa del área](docs/images/map-graph.png) | ![Registro de búsquedas de un mapeo sistemático](docs/images/mapping-search-log.png) |
| Mapa: citas, similitud y relaciones tipadas | Mapeo sistemático: registro de búsquedas con las cadenas exactas y sus cifras |
| ![Cribado](docs/images/mapping-screening.png) | ![Diagrama PRISMA 2020](docs/images/mapping-prisma.png) |
| Cribado registro por registro, con sugerencias de Claude | Diagrama PRISMA 2020 calculado del registro |

## Requisitos

- Node.js 24 o superior y pnpm (`corepack enable`)
- Para resumir papers: la CLI `claude` instalada y con sesión iniciada (`claude login`)
- Para sincronizar desde la app: git (y git-lfs si los PDF se versionan con LFS)

## Uso

```bash
pnpm install
pnpm dev
```

Guía completa de uso (qué hace la app, cómo agregar papers, resúmenes, modo revisar, cada ajuste, archivos del proyecto): [`docs/guide.es.md`](docs/guide.es.md).

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

### Evaluación de la similitud con el modelo real

`pnpm eval:similarity` calcula los vectores de una copia temporal y descartable de un proyecto real con el modelo local real y muestra cuántos papers quedaron con vector, cuánto tardó, con qué frecuencia un paper citado de la biblioteca aparece entre los 10 más parecidos del que lo cita (con varias ponderaciones) y los papers más parecidos de algunos papers con sus razones:

```bash
EVAL_PROJECT=~/ruta/a/mi/proyecto pnpm eval:similarity
```

La primera vez descarga el modelo (unos 470 MB) en `EVAL_MODELS_DIR` (por defecto `~/.cache/research-eval-models`). `EVAL_FETCH_CITATIONS=1` actualiza antes las citas desde OpenAlex (usa parte del presupuesto diario de OpenAlex). Sin `EVAL_PROJECT` la prueba aparece como omitida; `pnpm test`/`pnpm check` nunca la incluyen.

### Evaluación de las relaciones tipadas con Claude real

`pnpm eval:relations` le pide a la CLI real de Claude (como agente con las herramientas de solo lectura de la biblioteca) relaciones tipadas para algunos papers de una copia temporal y descartable de un proyecto real, e imprime, por paper, los candidatos, las relaciones sugeridas y sus tipos, las llamadas a herramientas, cuántas citas se encontraron, qué se descartó, el costo y el tiempo. No escribe nada de vuelta:

```bash
EVAL_PROJECT=~/ruta/a/mi/proyecto pnpm eval:relations
```

**Consume cuota real de Claude.** Variables opcionales: `EVAL_MODEL` (por defecto `sonnet`) y `EVAL_LIMIT` (papers a analizar, por defecto 3). Sin `EVAL_PROJECT`, la prueba aparece como omitida; `pnpm test`/`pnpm check` nunca la incluyen.
