# Guía de uso

*[English version](./guide.md)*

Esta app es una biblioteca de papers para la tesis *Método computacional para la desensibilización de logs y generación trazable de post-mortems de incidentes de software asistida por modelos de lenguaje locales*. Es una aplicación personal y autónoma: no necesita cuentas ni servidores propios; usa Claude para los resúmenes y servicios públicos (doi.org/Crossref, OpenAlex, arXiv) para los metadatos.

## Para qué sirve

- Guardar los papers de la tesis en una carpeta de proyecto, con su BibTeX, para citarlos desde LaTeX u org-cite.
- Buscar en títulos, autores y el texto completo de los papers (incluida la literatura gris: páginas web sin PDF).
- Generar, con Claude, un resumen de cada paper: sus campos (problema, contribución, método, evaluación…), una clasificación según el formulario de extracción de la tesis, y su relación con la tesis, todo con evidencia (citas textuales con página) y un estado de revisión por campo.
- Un modo de revisión rápido para repasar uno por uno todos los campos y facetas que Claude generó.
- Traer de OpenAlex las referencias de cada paper y proponer **candidatos por citas** (*snowballing*): trabajos que tus papers citan, o que los citan, y que todavía no están en tu biblioteca.
- Encontrar **papers similares** combinando referencias en común, citas compartidas, facetas en común y un modelo local de contenido, con las razones de cada parecido.
- Ver el área en la vista **Mapa**: un grafo de papers con dos lentes (área y tesis) y gráficas por faceta.

Próximamente (no implementado todavía): relaciones tipadas entre papers sugeridas por Claude (extiende, usa el método de, compara con, contradice…), chat sobre la biblioteca y mapeo sistemático de literatura.

## Primeros pasos

### Instalación y arranque

```bash
pnpm install
pnpm dev
```

Requiere Node.js 24 o superior y pnpm (`corepack enable`).

### La CLI de Claude

Resumir papers necesita la CLI `claude` instalada en el sistema y con sesión iniciada:

```bash
claude login
```

La app la invoca localmente, en modo no interactivo y sin herramientas ni MCP; no abre red propia ni manda nada a otro sitio que no sea Claude. Si la CLI no está instalada o no tiene sesión, cualquier intento de resumir falla con «No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.».

### Crear o abrir un proyecto

Al arrancar sin un proyecto abierto, la app pide crear uno nuevo (nombre y una carpeta que todavía no tenga un proyecto) o abrir uno existente (una carpeta que ya tenga `project.yaml`). Si eliges una carpeta que ya tiene un proyecto para crear uno nuevo, avisa «Esa carpeta ya tiene un proyecto; ábrelo en lugar de crear otro.». El proyecto queda abierto para la próxima vez que arranques la app.

### Sincronizar el proyecto entre equipos

La carpeta del proyecto es texto plano (YAML, Markdown) pensado para versionarse con git o sincronizarse con una herramienta como Syncthing. Los archivos se recargan solos cuando cambian por fuera de la app (un `git pull`, una sincronización, un editor externo) — no hace falta reiniciar. Si dos equipos editan el mismo archivo a la vez, la app lo detecta como conflicto (ver «Problemas comunes» más abajo).

## Agregar papers

En la barra de arriba de la biblioteca puedes:

- **Pegar un DOI, un ID de arXiv o una URL** y tocar «Agregar». También acepta un id de OpenAlex (`W2741809807` o `https://openalex.org/W2741809807`); es lo que usa «Agregar» en Candidatos para los trabajos sin DOI. Con una URL que no sea DOI ni arXiv, la app mira qué hay detrás: si sirve un PDF, se agrega como PDF; si la página tiene un DOI o un ID de arXiv, se usa ese identificador; si no, se guarda como página web (literatura gris), con su texto legible si lo encuentra, y si no, avisa que «La página no tiene un artículo legible.».
- **Arrastrar uno o varios PDFs** a la biblioteca.

La app completa los metadatos automáticamente a partir del identificador. Si el paper queda con «Los metadatos están incompletos.», puedes pegar un DOI o ID de arXiv en el aviso y tocar «Completar», o tocar «Reintentar» si ya tenía uno.

Al agregar un paper (o completar sus metadatos), la app consulta en segundo plano sus referencias en OpenAlex (ver «Citas y candidatos»); no consume cuota de Claude.

Agregar un identificador o PDF que ya está en la biblioteca actualiza el paper existente en vez de duplicarlo («ya estaba en la biblioteca» / «actualizado» en el panel de actividad).

Cada paper recibe una **clave de cita** (su carpeta en `papers/`) que nunca cambia, aunque edites sus metadatos. Se puede copiar con el botón «Copiar» junto a la clave, en el detalle del paper.

La app mantiene `exports/library.bib` con el BibTeX de todos los papers, listo para citar desde LaTeX u org-cite. Es un archivo generado: no lo edites a mano.

## Biblioteca

La lista de la izquierda muestra todos los papers que coinciden con la búsqueda y los filtros activos.

- **Buscar**: el cuadro de arriba busca en títulos, autores y el texto completo indexado de cada paper.
- **Insignias** (bajo el título de cada paper):
  - *Error en archivo*: `paper.yaml` no se pudo leer (marcas de conflicto de git, YAML inválido o le faltan campos).
  - *Metadatos incompletos*: falta completar título, autores u otros datos.
  - *Web*: el paper es una página web (sin PDF, con texto extraído).
  - *Sin PDF*: no es un paper web y no tiene PDF adjunto.
  - *Sin resumen*: todavía no se resumió (y ya tiene texto indexado). Un paper demasiado largo para resumir sin «Forzar» (ver «Resúmenes con Claude») no muestra esta insignia mientras no tenga resumen.
  - *Por revisar (N)*: el resumen tiene N campos, facetas o la relación con la tesis todavía sin verificar ni editar, o una relación con la tesis ya revisada que quedó pendiente de volver a revisar porque cambió la tesis.
  - *Revisado*: todo lo generado ya fue verificado o editado.
  - *Desactualizado*: el resumen quedó desactualizado porque cambió el formulario de extracción, o porque cambió la tesis y la relación con ella seguía en *generado* (ver «Resúmenes con Claude»).
  - *Resumen falló*: el último intento de resumir terminó en error.
  - *Sin citas*: no se encontró el paper en OpenAlex (no tiene DOI y no hubo una coincidencia exacta por título y año), así que no tiene citas ni candidatos.
- **Filtros**: por estado del resumen (todos, sin resumen, por revisar, revisados, desactualizados, con error) y por modelo con el que se generó (el selector se llama «Resumido con» para lectores de pantalla; sus opciones visibles son «Cualquier modelo», Sonnet, Haiku y Opus).
- **Filtro por faceta**: al hacer clic en una barra o una burbuja de las gráficas (vista Mapa), la biblioteca se abre filtrada por ese valor (o ese par de valores), con una etiqueta `faceta = valor` que se quita con ✕.
- **Actualizar citas**: vuelve a consultar en OpenAlex las referencias de todos los papers o, si hay una búsqueda o algún filtro activo, solo de los que se ven. Los trabajos aparecen en el panel de actividad.
- **Acciones por lotes**: encolan de una sola vez todos los papers elegibles visibles con la búsqueda y los filtros activos (los demasiado largos se omiten salvo que ya tuvieran un resumen forzado); ambas piden confirmación antes de encolar. Todos los trabajos del lote se encolan de entrada; si se llega al tope del lote (o a la cuota de Claude) mientras corre, los trabajos que todavía estaban en cola para ese lote se cancelan.
  - *Resumir pendientes*: encola los papers sin resumen (o con resumen desactualizado o fallido) dentro del presupuesto por lote, usando el modelo elegido en el selector «Modelo del lote». La confirmación muestra la cantidad de papers, el costo estimado y el tope del lote; si no hay ninguno pendiente, avisa «No hay papers pendientes de resumir.».
  - *Regenerar filtrados con…*: con un filtro de estado activo (no «Todos»), regenera con el modelo elegido en su propio selector todos los papers visibles que tengan texto indexado.
- **Panel de actividad**: lista los trabajos en curso y recientes (agregar un identificador o PDF, completar metadatos, resumir, citas, quién cita a un paper, similitud de un paper, descargar el modelo de similitud), con su estado (en cola, en curso, listo, falló, cancelado) y, si corresponde, el resultado (agregado, actualizado, ya estaba en la biblioteca, resumido, citas actualizadas, no se encontró en OpenAlex, citas entrantes actualizadas, modelo descargado). La descarga del modelo muestra su avance en porcentaje. Un trabajo en cola o en curso se puede cancelar. Tocar el nombre de un trabajo abre su paper.

## Detalle del paper

Al seleccionar un paper se abren sus pestañas (solo las que apliquen):

Aparecen en este orden: Resumen, Contenido, PDF, Texto, Relaciones, Notas.

- **Resumen**: ver «Resúmenes con Claude» abajo.
- **Contenido**: el texto legible extraído, siempre que haya (típicamente páginas web sin PDF), mostrado como un documento legible (encabezados, párrafos, listas, tablas, citas en bloque, código). Los enlaces abren en el navegador del sistema; las imágenes no se cargan, se muestran como una pequeña ficha que enlaza a la imagen. Seguir un enlace de evidencia en un paper web abre esta pestaña con la cita resaltada y centrada en la vista; si el texto exacto no se encuentra, se muestra un pequeño aviso.
- **PDF**: el visor del PDF. Aparece para todo paper que no sea una página web, aunque todavía no tenga PDF adjunto: en ese caso muestra «Este paper no tiene PDF. Arrastra el archivo a la biblioteca para adjuntarlo.» en vez del visor.
- **Texto**: el texto extraído del PDF, página a página, dispuesto para leer. Aparece cuando el paper tiene PDF y su texto está indexado (ver «Leer el texto» abajo).
- **Relaciones**: el estado de las citas (sin consultar, consultadas en tal fecha con N citas en OpenAlex, o *Sin citas*) con el botón «Actualizar citas»; «Cita a (en tu biblioteca)» y «Citado por (en tu biblioteca)» (solo papers de tu biblioteca; un clic los abre); cuántas referencias no están en tu biblioteca, con «Ver candidatos», que abre la pestaña Candidatos filtrada por este paper; y «Similares»: los 10 papers más parecidos, con su puntuación y sus razones (por ejemplo «6 referencias en común · citados juntos por 3 papers · technique: ner · similitud de contenido 0.82»).
- **Notas**: notas propias en Markdown, con guardado automático (`notes.md`). Si el archivo cambió por fuera de la app mientras había cambios sin guardar, avisa el conflicto y deja elegir entre recargar (descarta lo propio) o sobrescribir con la versión propia.

### Leer el texto

La pestaña Texto muestra una página a la vez, con «Página N de M», «Anterior» / «Siguiente» y un campo para ir a una página. El texto se rearma para leerlo: las palabras cortadas con guion al final de una línea se unen, las líneas de un mismo párrafo se juntan, las líneas cortas con forma de título (como «1 Introduction», «2.3 Results» o líneas en mayúsculas) se ven como encabezados, y los encabezados, pies y números de página que se repiten entre páginas se atenúan. El buscador busca en todas las páginas, sin distinguir mayúsculas ni acentos, y muestra cuántos resultados hay; las flechas pasan de un resultado a otro, cambiando de página si hace falta, con cada coincidencia resaltada.

Arriba del detalle: la clave de cita (con botón para copiarla), el enlace al DOI o la URL original, «Mostrar en carpeta» (abre `papers/<clave>/` en el explorador de archivos) y el estado del texto indexado (indexando, texto indexado, PDF sin texto/escaneado, sin texto, error al extraer).

## Resúmenes con Claude

Un resumen (`summary.md`) tiene estos campos: en pocas palabras, problema, contribución, método, evaluación, resultados, limitaciones (declaradas e inferidas), trabajo futuro y tipo de investigación (propuesta de solución, validación, evaluación, experiencia, filosófico u opinión). Junto con el resumen se genera una clasificación (`extraction.yaml`) según las facetas del formulario del proyecto, y, si la tesis tiene tema definido, la relación de ese paper con la tesis. Si el proyecto todavía no tiene formulario de extracción, resumir crea primero el formulario por defecto (ver «Formulario» en Ajustes) automáticamente.

Cada campo, faceta y la relación con la tesis llevan:

- **Evidencia**: una o más citas textuales, con el número de página cuando aplica. Cada cita con página muestra un enlace «p. N ↗» que abre la pestaña PDF en esa página con la cita resaltada (en una página web, abre la pestaña Contenido en su lugar, con la cita resaltada ahí también). Si el texto exacto no se encuentra, no hay enlace; el pasaje extraído alrededor de esa cita solo se ve en Modo Revisar (ver abajo).
- **Estado**: *generado* (recién creado por Claude, sin revisar), *verificado* (confirmaste que está bien), *editado* (lo corregiste a mano) o *evidencia no encontrada* (Claude generó el campo con una cita que no se encuentra en el texto: revísalo con cuidado). Un valor editado ya se considera tuyo y no vuelve a *generado* salvo que lo desverifiques desde *verificado*.
- **Procedencia**: el modelo y la fecha con que se generó ese campo en particular, o los del resumen completo si el campo no tiene los suyos propios.

Acciones sobre cada campo: **Verificar** (pasa a verificado), **Desverificar** (vuelve a generado) y **Editar** (abre un editor y guarda como editado). **Verificar todo** marca como verificado todo lo que esté en *generado* en ese paper de una sola vez.

**Valores propuestos**: si Claude devuelve, para una faceta de una o varias opciones, un valor que no está en la lista permitida, queda como «propuesto» bajo esa faceta. Puedes **Aceptar** (lo agrega como valor permitido de la faceta) o **Mapear a…** (lo asocia a un valor ya existente, como alias). Ambas acciones se aplican a todos los papers que tengan esa misma propuesta, no solo al que estás viendo.

**Regenerar y modelo**: «Regenerar» vuelve a resumir el paper con el modelo configurado; «Regenerar con…» deja elegir el modelo para esa vez sin cambiar el de Ajustes. Volver a generar nunca pisa un campo ya verificado o editado — solo actualiza lo que seguía en *generado*.

**Forzar y truncamiento**: si el texto del paper supera el tamaño máximo de entrada configurado, el botón «Resumir» (cuando el paper todavía no tiene resumen) se deshabilita y muestra «El texto es demasiado largo», con «Forzar» al lado para resumir usando solo el comienzo del texto hasta ese máximo. Si el paper ya tiene un resumen, «Regenerar» sigue habilitado: al tocarlo, falla con «El texto supera el tamaño máximo configurado.» y ahí aparece «Forzar». Un resumen ya hecho con el texto truncado vuelve a forzarse solo cuando se regenera (sea de forma individual o dentro de un lote), sin tener que tocar «Forzar» de nuevo. El resumen resultante queda marcado como «Resumido solo con el comienzo del texto: el paper supera el máximo de caracteres».

**Desactualizado**: un resumen pasa a *Desactualizado* cuando cambia el formulario de extracción (agregar o quitar una faceta, o cambiar su clave, tipo, descripción o — en una escala — su mínimo o máximo; agregar o quitar *valores* permitidos de una faceta, o editar los alias, no lo desactualiza) o cuando cambia el tema de la tesis (título, descripción o preguntas de investigación; basta con que uno de título o descripción esté definido para que haya relación con la tesis). La próxima vez que se regenere, se vuelve a generar todo lo que seguía en *generado*; lo verificado o editado se conserva. Si la relación con la tesis ya estaba verificada o editada cuando cambió la tesis, el resumen entero no pasa a Desactualizado: la relación con la tesis queda marcada «La tesis cambió; revisa esta relación» y el paper pasa a «Por revisar», en vez de perder tu edición o verificación.

**Costos**: cada llamada a Claude registra su costo estimado en USD. Como la cuenta es por suscripción (no por uso facturado), estos números son solo una estimación de cuánta cuota consumes, no un cargo real.

## Modo Revisar

«Revisar pendientes», en la biblioteca, abre un repaso secuencial de todos los campos, facetas y relaciones con la tesis que sigan en estado *generado* entre los papers visibles con los filtros activos, más las relaciones con la tesis ya revisadas que quedaron pendientes porque cambió la tesis (ver «La tesis cambió; revisa esta relación» en «Resúmenes con Claude»); para estas últimas vuelve a aparecer el botón **Verificar**.

Atajos de teclado (se muestran en pantalla como «V verificar · E editar · U desverificar · → siguiente · ← anterior · Esc salir»; se ignoran mientras se escribe en un campo de texto):

- **V**: verificar el elemento actual.
- **E**: editar el elemento actual.
- **U**: desverificar el elemento actual.
- **→ / ←**: siguiente / anterior.
- **Esc**: si hay un editor abierto, no hace nada (cierra el editor con su propio botón «Cancelar»); si no hay ninguno abierto, sale del modo revisar.

El panel derecho muestra el PDF con la cita resaltada cuando el paper tiene uno y la cita se encuentra en el texto. Si no, muestra el pasaje, dispuesto para leer: en una página web, su contenido como en la pestaña **Contenido**, con la cita resaltada (o un pequeño aviso si el texto exacto no se encuentra); si la cita no aparece en el PDF, el texto de esa página como en la pestaña **Texto** (encabezados, párrafos, encabezados y pies de página atenuados), con la cita marcada donde aún se pueda ubicar. Si el PDF no se puede cargar (o no hay contenido que mostrar), se muestra el texto extraído de esa página tal cual.

## Citas y candidatos

Las citas vienen de [OpenAlex](https://openalex.org), sin usar Claude. Para cada paper, la app busca su obra en OpenAlex por su id de OpenAlex, si no por su DOI y, si no tiene DOI, por su título exacto y año (solo si hay una coincidencia inequívoca; nunca para páginas web). Guarda en `paper.yaml` la lista completa de lo que cita, esté o no en tu biblioteca, y el total de citas que tiene en OpenAlex. Si no la encuentra, el paper queda con la insignia *Sin citas*. Si la obra que encuentra por id tiene otro DOI que el paper, manda el DOI del paper. Al completar o cambiar el DOI de un paper («Completar» o «Reintentar»), se descartan las citas de la obra anterior y se vuelven a buscar solas.

OpenAlex limita las consultas por día. Sin clave alcanza de sobra para unos cientos de papers; si llegas al límite (en un trabajo de citas o al cargar los datos de los candidatos), los trabajos de citas pendientes se cancelan y aparece «Se alcanzó el límite diario de OpenAlex. Reintenta mañana o agrega una clave de API en Ajustes.». Una clave gratuita (Ajustes → Aplicación) da un presupuesto mayor.

**Candidatos** (vista Mapa → Candidatos) son trabajos que no están en tu biblioteca y que:

- **Referencias de tus papers**: son citados por al menos N de tus papers.
- **Trabajos que citan a tus papers**: citan al menos N de tus papers. Para verlos, primero toca «Buscar quién cita a mis papers», que consulta en OpenAlex quién cita cada paper (un trabajo por paper, en el panel de actividad). Se saltan los papers consultados en los últimos 7 días, así que volver a tocarlo no gasta dos veces el presupuesto diario; pasada esa semana los vuelve a consultar.

La tabla muestra título (enlace al DOI o a OpenAlex), año, autores, «Citado por tus papers», «Cita a tus papers» y «Citas en OpenAlex». **Agregar** lo ingresa como cualquier DOI (o por su id de OpenAlex si no tiene DOI); **Descartar** lo guarda en `project.yaml` y no vuelve a aparecer (en ningún equipo). Los que ya están en tu biblioteca (por id de OpenAlex o DOI) nunca aparecen.

## Similitud

Cada par de papers recibe una puntuación entre 0 y 1 que combina:

| Señal | Qué mide | Razón que se muestra |
|---|---|---|
| Contenido | parecido del título, el abstract y (si hay resumen) el problema, la contribución y el método, según un modelo local | «similitud de contenido 0.82» |
| Acoplamiento bibliográfico | referencias en común | «6 referencias en común» |
| Facetas | valores en común en las facetas de opción única o múltiple | «technique: ner · task: anonymization» |
| Co-citación | papers de tu biblioteca que citan a ambos | «citados juntos por 3 papers» |
| Cita directa | uno cita al otro | «zhu2020loghub cita a he2017drain» |

La razón de cita directa muestra las claves de cita de ambos papers (las de la columna «Clave de cita»). Se guardan los 10 más parecidos de cada paper. Sin el modelo local, la puntuación usa solo las demás señales. Todo se actualiza solo cuando cambian las citas, los resúmenes o el texto de un paper: un cambio suelto actualiza solo lo que toca a ese paper, y un lote (por ejemplo «Actualizar citas» de toda la biblioteca) recalcula todo al terminar. Si un lote se cancela a mitad de camino, el recálculo completo queda pendiente y se hace con el próximo cambio de un paper. Cambiar el formulario de extracción (que cambia las facetas de todos los papers) también recalcula todo, solo si de verdad cambió algún valor de faceta.

## Mapa

La vista **Mapa** (barra lateral) tiene tres pestañas:

- **Grafo**: un nodo por paper (más grande cuantas más citas tiene en OpenAlex) y dos tipos de aristas: citas (flecha sólida) y similitud (punteada, más gruesa cuanto más parecidos). Pasa el cursor por una arista punteada para ver sus razones; haz clic en un nodo para abrir su detalle al costado. Controles: **Lente** «Área» (color por la faceta que elijas; un paper con varios valores toma el más frecuente en la biblioteca) o «Tesis» (color por la relevancia 1–5 de la relación con la tesis; gris sin relación); mostrar u ocultar citas y similitud; «Umbral de similitud»; «Aplicar los filtros de la biblioteca» (usa los papers visibles la última vez que abriste la biblioteca); «Exportar PNG» (el grafo solo se exporta a PNG).
- **Gráficas**: «Barras por valor», «Burbujas faceta × faceta» (las celdas vacías se ven como huecos) y «Papers por año». Con «Solo revisadas» apagado cuentan todas las facetas y lo no revisado se dibuja más tenue; encendido, solo las verificadas o editadas. Las entradas que ya no encajan con el tipo actual de su faceta no cuentan. Un clic en una barra o burbuja abre la biblioteca filtrada. Se exportan a SVG, PNG y CSV.
- **Candidatos**: ver «Citas y candidatos».

## Ajustes

Los ajustes se organizan en pestañas, navegables con ←/→/Inicio/Fin; la app recuerda la última pestaña abierta. La mayoría de los campos se guardan solos al salir de ellos (de inmediato en selectores y casillas) y muestran «Guardado»; el editor del formulario de extracción es la excepción — ahí los cambios quedan pendientes hasta tocar «Guardar cambios» (ver «Formulario» abajo).

Valores por defecto de un proyecto nuevo: idioma del contenido generado en inglés; PDFs «Versionarlos con git»; modelo Sonnet; resumir automáticamente desactivado; tope por paper 0,5 USD; tope por lote 10 USD; tope mensual vacío (sin tope); tamaño máximo de entrada 400000 caracteres.

### Proyecto

- **Nombre**: el nombre del proyecto, visible en la app.
- **Carpeta**: la ruta de la carpeta del proyecto (solo lectura).
- **Idioma del contenido generado**: inglés o español. Lo usan los resúmenes y, en etapas siguientes, otras respuestas generadas. Cambiarlo no desactualiza los resúmenes existentes (siguen en el idioma con el que se generaron); se aplica a los resúmenes nuevos.
- **PDFs**: cómo se guardan los PDFs nuevos — versionarlos con git, versionarlos con git LFS, guardarlos fuera de git (para sincronizarlos aparte, p. ej. con Syncthing) o no guardarlos y descargarlos al abrirlos (solo para papers de acceso abierto). Cambiar esta opción no mueve los PDFs ya guardados, solo afecta a los nuevos. Con «Guardarlos fuera de git», la app se encarga de añadir `papers/*/paper.pdf` a `.gitignore`; con «Versionarlos con git LFS», se encarga del `.gitattributes` correspondiente — no hace falta tocar ninguno de los dos a mano.

### Claude

- **Modelo**: Sonnet (recomendado), Haiku (más rápido, menor calidad) u Opus (máxima calidad, consume más cuota). Es el modelo por defecto para resumir; se puede elegir otro puntualmente con «Regenerar con…» o al confirmar un lote.
- **Resumir automáticamente al agregar papers**: si está activo, al terminar un trabajo de agregar, fusionar o completar metadatos, cada paper que quede con texto indexado, sin resumen (o con uno desactualizado o fallido) y con el formulario válido se encola para resumirse solo; los papers demasiado largos para el tamaño máximo de entrada no se resumen solos (hace falta «Forzar» a mano).
- **Tope por paper (USD est.)**: el máximo estimado que puede costar un solo resumen. No puede quedar vacío ni ser 0 o negativo. Se aplica por cada llamada a Claude (como `--max-budget-usd`); un resumen puede hacer hasta dos intentos de llamada.
- **Tope por lote (USD est.)**: el máximo estimado acumulado dentro de una misma operación por lotes (resumir pendientes o regenerar filtrados). Al alcanzarlo, los trabajos de ese lote que todavía estaban en cola se cancelan. No puede quedar vacío ni ser 0 o negativo.
- **Tope mensual (USD est., vacío = sin tope)**: el máximo estimado acumulado en el mes, sumando el gasto de todos tus equipos (ver «Gasto estimado este mes» más abajo). Es el único de los tres topes que puede quedar vacío, y vacío significa sin tope. El mes se cuenta por mes calendario en UTC, sumando todos los dispositivos que sincronizan el proyecto.
- **Tamaño máximo de entrada (caracteres)**: cuánto texto del paper se manda a Claude como máximo. Un paper más largo no se puede resumir sin usar «Forzar» (ver «Resúmenes con Claude»).
- **Gasto estimado este mes (todos tus equipos)**: suma de los costos estimados registrados este mes en `costs/`, de cualquier dispositivo que sincronice este proyecto. Con una suscripción, estos costos son estimaciones de la cuota que consumes, no cargos reales.

### Tesis

- **Título** y **Descripción** (problema, enfoque, alcance): el tema de la tesis que Claude usa para explicar la relación de cada paper con ella. Basta con completar uno de los dos para empezar a tener relaciones; mientras falten los dos, el resumen no incluye esa sección («Define el tema de tu tesis en Ajustes para obtener esta sección.»). Los resúmenes generados antes de completar alguno de los dos quedan *Desactualizados* y muestran «Regenera el resumen para obtener la relación con la tesis.».
- **Preguntas de investigación**: se agregan y quitan con sus botones; cada una tiene un identificador propio (RQ1, RQ2…) que **nunca se renumera ni se reutiliza**, aunque borres la pregunta con el número más alto — así una pregunta sigue siendo la misma referencia en los resúmenes ya generados aunque cambie su posición en la lista. Esos identificadores se ven como chips en la tarjeta de la relación con la tesis del resumen, no en esta pestaña.
- Cambiar el título, la descripción o las preguntas desactualiza los resúmenes existentes (ver «Desactualizado» en «Resúmenes con Claude»).

### Formulario

El formulario de extracción define las facetas (columnas) con las que Claude clasifica cada paper. Se edita desde esta pestaña; también se puede ver el YAML crudo con «Mostrar project.yaml» (que abre `project.yaml` en el explorador de archivos), botón que solo aparece cuando el formulario es válido.

Si el proyecto no tiene formulario todavía, un botón ofrece «Crear formulario por defecto», que es el formulario pensado para esta tesis:

| Faceta | Tipo | Qué clasifica |
| --- | --- | --- |
| `sanitization_technique` | varias opciones | Cómo se eliminan o transforman los datos sensibles en los logs (reglas/regex, NER, pseudonimización, privacidad diferencial, basado en LLM, ninguna) |
| `data_type` | varias opciones | Tipo de dato operacional que procesa el trabajo (logs, trazas, tickets, postmortems, código, chats) |
| `llm_usage` | una opción | Cómo se usan los modelos de lenguaje, si se usan (ninguno, API en la nube, local, afinado) |
| `task` | varias opciones | Tarea principal (anonimización, parseo de logs, análisis de causa raíz, generación de postmortems, resumen) |
| `traceability` | texto libre | Si los resultados se pueden rastrear hasta su evidencia de origen, y cómo |
| `privacy_evaluation` | texto libre | Cómo se evalúa la privacidad o la fuga de datos (métricas, datasets) |
| `rigor` | escala (1 a 5) | Rigor metodológico: diseño de la evaluación, datasets, líneas base y reproducibilidad |

Si el `project.yaml` tiene un formulario con errores, se listan los problemas detectados y hay que corregirlos a mano en el archivo antes de poder editarlo aquí.

Por cada faceta se puede editar:

- **Clave**: en inglés, minúsculas y guiones bajos (p. ej. `dataset_public`). Solo se puede cambiar al crear la faceta; en una faceta ya guardada, la clave y el tipo quedan fijos y no se pueden editar.
- **Tipo**: una opción, varias opciones, texto libre o escala. También solo editable al crearla.
- **Descripción**: lo que Claude lee para entender qué clasificar ahí.
- **Valores permitidos** (una/varias opciones): se agregan y quitan con sus botones; el texto debe ser en inglés, minúsculas y guiones bajos. Quitar un valor también quita sus alias aprendidos.
- **Mínimo / Máximo** (escala): límites enteros de la escala; el mínimo no puede ser mayor que el máximo.
- **Alias aprendidos**: valores propuestos por Claude que ya mapeaste a un valor permitido (ver «Valores propuestos» en «Resúmenes con Claude»); se pueden quitar uno por uno.

**Qué desactualiza los resúmenes y qué no**: agregar o quitar una faceta; cambiar su clave, tipo o descripción; o, en una escala, cambiar el mínimo o el máximo — todo esto desactualiza los resúmenes existentes. Agregar o quitar un *valor* permitido, o editar los alias, no los desactualiza. Reordenar las facetas (a mano, editando el YAML) también cambia el hash que determina si un resumen está desactualizado.

Al guardar cambios, la app muestra primero el impacto (cuántos resúmenes quedarán desactualizados, y si algún valor que vas a quitar sigue en uso en algún paper — ese valor se conserva en esos papers aunque lo quites de la lista) antes de pedir confirmación.

**Quitar y recrear una faceta**: lo ya extraído para esa faceta se conserva en los archivos de cada paper aunque la quites del formulario, y vuelve a aparecer si recreas una faceta con la misma clave (aunque con otro tipo, lo guardado que no coincida con el tipo nuevo se trata como ausente). Quitar la faceta también quita sus alias aprendidos.

**Restaurar formulario por defecto** vuelve a dejar el formulario como la tabla de arriba y borra todos los alias aprendidos; lo ya extraído se conserva igual en los archivos. A diferencia de guardar cambios en una faceta, esta acción no muestra una vista previa del impacto antes de confirmar, y puede dejar resúmenes desactualizados.

Si el formulario cambió por fuera de este editor (otro equipo, un `git pull`) mientras tenías cambios propios sin guardar, aparece un aviso para descartar los tuyos y recargar.

### Aplicación

- **Correo de contacto para Crossref y OpenAlex**: opcional. Crossref atiende con prioridad las consultas que lo incluyen (OpenAlex ya no lo usa). Solo se envía a esos servicios. Es un ajuste de la app por dispositivo, no se guarda en `project.yaml` y por lo tanto no se sincroniza entre equipos.
- **Clave de API de OpenAlex**: opcional y gratuita. Sin clave, OpenAlex permite unas 1000 consultas al día; con ella, más. Se guarda solo en este equipo y solo se envía a OpenAlex.
- **Modelos locales**: el modelo de similitud de contenido (multilingual-e5-small, unos 470 MB) corre en tu equipo. Muestra si está descargado y cuánto ocupa, con «Descargar» (el avance se ve en Actividad) y «Borrar». Se guarda en la carpeta de datos de la app, nunca en el proyecto, así que cada equipo lo descarga una vez. La descarga corre como un trabajo del proyecto abierto (hace falta tener uno abierto); si cierras el proyecto o la app a mitad de camino, se retoma la próxima vez que abras ese proyecto. «Borrar» cancela los cálculos de similitud que estaban en cola.
- **Cerrar proyecto**: vuelve a la pantalla de bienvenida para crear o abrir otro proyecto.

## Archivos del proyecto

```
project.yaml               configuración del proyecto (nombre, idioma, política de PDFs, Claude, tesis, formulario de extracción, candidatos descartados)
papers/<clave>/            un paper por carpeta; <clave> es su clave de cita y nunca cambia
  paper.yaml               metadatos, BibTeX y citas (OpenAlex)
  summary.md               campos del resumen, con evidencia y estado por campo
  extraction.yaml          clasificación según el formulario, y relación con la tesis
  notes.md                 tus notas
  content.md               texto legible (literatura gris, páginas sin PDF)
  paper.pdf                el PDF, según la política configurada
costs/<dispositivo>.jsonl  costos estimados de cada llamada a Claude, uno por dispositivo (para que sincronizar entre equipos nunca choque)
exports/library.bib        BibTeX de toda la biblioteca; generado, no lo edites
.cache/                    índice local de búsqueda, PDFs descargados bajo demanda, citas entrantes, datos de candidatos, vectores y similares; se puede borrar sin perder nada, se reconstruye solo
```

Todo lo de arriba, salvo `.cache/`, está pensado para versionarse con git o sincronizarse entre equipos. `notes.md` y `project.yaml` (fuera de `extraction_form`) se pueden editar a mano con confianza; `paper.yaml`, `summary.md` y `extraction.yaml` también, pero con cuidado de no romper su formato. Un archivo editado por fuera de la app (o actualizado por una sincronización) se recarga solo, sin reiniciar la app.

## Problemas comunes / FAQ

**«No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.»**
Instala la CLI `claude` y ejecuta `claude login` en una terminal.

**«Se alcanzó el presupuesto configurado.»**
Se llegó al tope por paper, por lote o mensual configurado en Ajustes → Claude. Sube el tope correspondiente (o deja el mensual vacío para quitarlo) y reintenta.

**«Se agotó la cuota de tu suscripción de Claude. Intenta más tarde.»**
Es un límite de la cuenta de Claude, no de esta app; espera a que se renueve la cuota.

**«Claude devolvió una respuesta inválida dos veces.»**
Claude no devolvió una respuesta que la app pudiera interpretar, en los dos intentos permitidos por resumen. Reintenta más tarde; si persiste, puede ser un problema de la CLI `claude`.

**«Claude tardó demasiado y se canceló.»**
Cada llamada a Claude tiene un límite de 5 minutos; si lo supera, se cancela sola. Reintenta.

**El paper es demasiado largo**
El botón para resumir se deshabilita y aparece «Forzar», que resume usando solo el comienzo del texto hasta el tamaño máximo configurado (ver «Tamaño máximo de entrada» en Ajustes → Claude). El resumen queda marcado como hecho con texto truncado.

**PDF escaneado sin texto**
El estado del paper muestra «PDF sin texto (escaneado)»; esta app no hace OCR, así que ese paper no se puede resumir hasta que consigas una versión con texto.

**«Los metadatos están incompletos.»**
Falta completar título, autores u otros datos del paper. Pega un DOI o ID de arXiv junto al aviso y toca «Completar», o «Reintentar» si ya tenía uno.

**«El formulario cambió fuera de este editor»**
Otro equipo (o un `git pull`) cambió `project.yaml` mientras tenías cambios propios sin guardar en el editor del formulario. Usa «Descartar mis cambios y recargar» para ver la versión nueva, y vuelve a aplicar tus cambios si seguían siendo necesarios.

**«El formulario de extracción en project.yaml tiene errores.»**
El formulario guardado en `project.yaml` no es válido (por ejemplo, lo editaste a mano y quedó mal formado). Corrígelo directamente en el archivo; la pestaña Formulario de Ajustes lista los problemas detectados y no deja editarlo hasta que estén resueltos.

**«El archivo cambió fuera de la app.»**
Es el aviso general de conflicto: otro equipo o una sincronización cambió un archivo del paper mientras la app lo tenía abierto. Ver «Conflictos cuando dos equipos editan» abajo.

**Conflictos cuando dos equipos editan**
Si `notes.md`, `paper.yaml`, `summary.md` o `extraction.yaml` cambiaron en disco entre que la app los leyó y los quiso guardar (por ejemplo, dos equipos sincronizando a la vez), la app avisa el conflicto en vez de pisar el cambio ajeno: en notas, deja elegir entre recargar o sobrescribir con tu versión; en el resto, revisa el archivo a mano (busca marcas de conflicto de git si usas git) antes de reintentar.

**«Se alcanzó el límite diario de OpenAlex. Reintenta mañana o agrega una clave de API en Ajustes.»**
OpenAlex limita cuántas consultas se pueden hacer por día. Los trabajos de citas pendientes se cancelan; vuelve a tocar «Actualizar citas» al día siguiente, o agrega una clave gratuita en Ajustes → Aplicación.

**Un paper tiene la insignia «Sin citas»**
No se encontró en OpenAlex: no tiene DOI y la búsqueda por título y año no dio una coincidencia exacta. Completa su DOI (aviso de metadatos o «Completar»): sus citas se vuelven a buscar solas.

**«El modelo local de similitud no está descargado. Descárgalo en Ajustes → Aplicación.»**
La similitud de contenido necesita el modelo local. Mientras no esté, la similitud usa solo citas y facetas.

**«No se pudo cargar el modelo local de similitud. Bórralo y vuelve a descargarlo en Ajustes → Aplicación.»**
Los archivos del modelo están incompletos o dañados (por ejemplo, una descarga interrumpida). Usa «Borrar» y luego «Descargar».
