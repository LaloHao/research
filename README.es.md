# Research

*[English version](./README.md)*

App de escritorio personal para la investigación de una tesis: biblioteca de papers con BibTeX, búsqueda de texto completo, resúmenes con Claude, citas desde OpenAlex, papers similares, un mapa del área, relaciones tipadas y facetas sugeridas por Claude, chat con Claude sobre la biblioteca con citas verificadas y acciones desde el chat con las reglas de confirmación de la app, una papelera versionada para quitar y restaurar papers, sincronización entre equipos con git desde la app, mapeos sistemáticos con protocolo, búsquedas registradas, cribado con sugerencias de Claude y diagrama PRISMA, una vista «Redacción» para la tesis (el `.bib` de un capítulo solo con las entradas que cita, la revisión de las citas de un texto con el veredicto de Claude sobre si cada paper citado respalda su oración, borradores que Claude escribe a partir de los papers elegidos con cada cita verificada, un esquema del estado del arte por facetas con sus huecos y su redacción por Claude, y la revisión de estilo de Claude, para Org, LaTeX o Markdown), una API local en 127.0.0.1 con un paquete de Emacs (`emacs/research.el`) para citar, verificar citas (también con Claude), generar el `.bib`, insertar el esquema o su propuesta, pedir un borrador, revisar el estilo y buscar pasajes desde el editor, un tutor de escritura desde el editor que nunca escribe por ti (Claude señala lo que debilita un pasaje y te hace una pregunta, ofrece opciones de una oración para comparar, un esquema inverso de los párrafos de una sección y las preguntas de investigación que aborda cada encabezado, con evidencia verificada), un ícono en la bandeja del sistema que mantiene la app (y su API local) corriendo al cerrar la ventana, con su estado, agregar un DOI o URL desde el portapapeles, sincronizar, encender la API local e iniciar con la sesión, una revisión local de la prosa académica en español en Emacs sin la app (`emacs/research-prose.el`: oraciones largas, repeticiones, muletillas, gerundios, pasiva, legibilidad INFLESZ, coherencia de términos, acrónimos) y, en etapas siguientes, segundo revisor, evaluación de calidad y reporte de los mapeos.

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

## Instalar como aplicación (AppImage, Linux)

### Desde una versión publicada

Cada versión en la [página de Releases](https://github.com/LaloHao/research/releases) trae `research-<versión>-x86_64.AppImage` y su `.sha256`. El script de instalación descarga la más reciente, comprueba su SHA-256 y la instala (no necesita el repositorio; sí `curl`):

```bash
curl -fsSL https://raw.githubusercontent.com/LaloHao/research/master/scripts/install-appimage.sh | bash -s -- --release
# o desde el repositorio:
./scripts/install-appimage.sh --release            # la versión más reciente
./scripts/install-appimage.sh --release v0.2.0     # una en particular
```

A mano: descarga los dos archivos de la página de Releases, compruébala con `sha256sum -c research-<versión>-x86_64.AppImage.sha256` y ejecuta `./scripts/install-appimage.sh ruta/a/research-<versión>-x86_64.AppImage` (o simplemente dale `chmod +x` y ábrela, sin lanzador).

El script copia la AppImage a `~/Applications/research.AppImage` (reemplaza la anterior en un solo paso), agrega el lanzador `~/.local/share/applications/research.desktop` y el ícono (`~/.local/share/icons/hicolor/<tamaño>/apps/research.png`, sacado de la AppImage). Después abre «research» desde el menú de aplicaciones y, si la quieres al iniciar sesión, activa Ajustes → Aplicación → «Iniciar con la sesión» desde esa copia (con «Iniciar oculto en la bandeja», al iniciar la sesión queda en la bandeja).

Para actualizar: sal de la app (bandeja → «Salir», o Ctrl+Q) y vuelve a correr el mismo comando (`--release` instala la versión más reciente). La ruta no cambia, así que el lanzador y la entrada de inicio automático siguen funcionando. Los ajustes, el modelo local y el registro quedan en `~/.config/research` (los mismos que con `pnpm dev`).

### Compilarla tú

```bash
pnpm install
pnpm dist                        # genera dist/research-<versión>-x86_64.AppImage
./scripts/install-appimage.sh    # instala para tu usuario la más reciente de dist/
```

Para actualizar una compilación local: sal de la app, luego `git pull`, `pnpm install`, `pnpm dist` y otra vez `./scripts/install-appimage.sh`.

Las AppImage necesitan FUSE (`libfuse2` en Ubuntu 24.04). Sin él, ejecuta `~/Applications/research.AppImage --appimage-extract-and-run`.

## Desarrollo

```bash
pnpm test        # pruebas (sin red)
pnpm typecheck
pnpm check       # ambas
pnpm test:emacs  # las pruebas ERT de los paquetes de Emacs (EMACS=/ruta/a/emacs para elegir uno)
./scripts/record-fixtures.sh   # vuelve a grabar las respuestas HTTP de las pruebas
```

La CI (`.github/workflows/ci.yml`) corre `pnpm check` y `pnpm test:emacs` en cada push a master y en cada pull request.

### Publicar una versión

Desde master limpio y al día:

```bash
pnpm release 0.2.0          # scripts/release.sh: pone la versión en package.json, commitea «Release v0.2.0» y etiqueta v0.2.0
git push origin master
git push origin v0.2.0      # de aquí sigue el workflow Release
```

La etiqueta arranca `.github/workflows/release.yml`: comprueba que coincida con la versión de package.json, corre `pnpm check` y `pnpm test:emacs`, compila la AppImage y publica la versión en GitHub con `research-<versión>-x86_64.AppImage`, su `.sha256` y notas con los commits desde la etiqueta anterior (`scripts/release-notes.sh`) más el comando de instalación. Una versión como `0.2.0-rc.1` queda como pre-release. Los paquetes de Emacs (`emacs/*.el`) llevan su propio encabezado `Version:`. Antes de hacer push, `git tag -d v0.2.0 && git reset --hard HEAD~1` lo deshace.

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
