# Guía de uso

Esta app es una biblioteca de papers para la tesis *Método computacional para la desensibilización de logs y generación trazable de post-mortems de incidentes de software asistida por modelos de lenguaje locales*. Es una aplicación personal y autónoma: no depende de ningún otro servicio salvo Claude para los resúmenes.

## Para qué sirve

- Guardar los papers de la tesis en una carpeta de proyecto, con su BibTeX, para citarlos desde LaTeX u org-cite.
- Buscar en títulos, autores y el texto completo de los papers (incluida la literatura gris: páginas web sin PDF).
- Generar, con Claude, un resumen de cada paper: sus campos (problema, contribución, método, evaluación…), una clasificación según el formulario de extracción de la tesis, y su relación con la tesis, todo con evidencia (citas textuales con página) y un estado de revisión por campo.
- Un modo de revisión rápido para repasar uno por uno todos los campos y facetas que Claude generó.

Próximamente (no implementado todavía): relaciones entre papers y grafo, chat sobre la biblioteca, y mapeo sistemático de literatura.

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

Al arrancar sin un proyecto abierto, la app pide crear uno nuevo (nombre y carpeta vacía) o abrir uno existente (una carpeta que ya tenga `project.yaml`). El proyecto queda abierto para la próxima vez que arranques la app.

### Sincronizar el proyecto entre equipos

La carpeta del proyecto es texto plano (YAML, Markdown) pensado para versionarse con git o sincronizarse con una herramienta como Syncthing. Los archivos se recargan solos cuando cambian por fuera de la app (un `git pull`, una sincronización, un editor externo) — no hace falta reiniciar. Si dos equipos editan el mismo archivo a la vez, la app lo detecta como conflicto (ver «Problemas comunes» más abajo).

## Agregar papers

En la barra de arriba de la biblioteca podés:

- **Pegar un DOI, un ID de arXiv o una URL** y tocar «Agregar». Una URL que no sea DOI ni arXiv se trata como página web (literatura gris): la app guarda su texto legible si lo encuentra, y si no, avisa que «La página no tiene un artículo legible.».
- **Arrastrar uno o varios PDFs** a la biblioteca.

La app completa los metadatos automáticamente a partir del identificador. Si el paper queda con «Metadatos incompletos», podés pegar un DOI o ID de arXiv en el aviso para completarlos, o tocar «Reintentar» si ya tenía uno.

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
  - *Sin resumen*: todavía no se resumió (y ya tiene texto indexado).
  - *Por revisar (N)*: el resumen tiene N campos, facetas o la relación con la tesis todavía sin verificar ni editar.
  - *Revisado*: todo lo generado ya fue verificado o editado.
  - *Desactualizado*: el resumen quedó desactualizado porque cambió el formulario de extracción o la tesis (ver «Resúmenes con Claude»).
  - *Resumen falló*: el último intento de resumir terminó en error.
- **Filtros**: por estado del resumen (todos, sin resumen, por revisar, revisados, desactualizados, con error) y por modelo con el que se generó («Resumido con» / «Cualquier modelo»).
- **Acciones por lotes**:
  - *Resumir pendientes*: encola todos los papers sin resumen (o con resumen desactualizado o fallido) dentro del presupuesto por lote. Antes de encolarlos muestra una confirmación con la cantidad de papers, el costo estimado y el tope del lote; si no hay ninguno pendiente, avisa «No hay papers pendientes de resumir.».
  - *Regenerar filtrados con…*: con un filtro de estado activo (no «Todos»), regenera con el modelo elegido todos los papers visibles que tengan texto indexado.
- **Panel de actividad**: lista los trabajos en curso y recientes (agregar un identificador o PDF, completar metadatos, resumir), con su estado (en cola, en curso, listo, falló, cancelado) y, si corresponde, el resultado (agregado, actualizado, ya estaba en la biblioteca, resumido). Un trabajo en cola o en curso se puede cancelar. Tocar el nombre de un trabajo abre su paper.

## Detalle del paper

Al seleccionar un paper se abren sus pestañas (solo las que apliquen):

- **Resumen**: ver «Resúmenes con Claude» abajo.
- **PDF**: el visor del PDF, cuando el paper tiene uno (local o descargable al abrirlo).
- **Contenido**: el texto legible extraído, para páginas web sin PDF.
- **Notas**: notas propias en Markdown, con guardado automático (`notes.md`). Si el archivo cambió por fuera de la app mientras había cambios sin guardar, avisa el conflicto y deja elegir entre recargar (descarta lo propio) o sobrescribir con la versión propia.

Arriba del detalle: la clave de cita (con botón para copiarla), el enlace al DOI o la URL original, «Mostrar en carpeta» (abre `papers/<clave>/` en el explorador de archivos) y el estado del texto indexado (indexando, texto indexado, PDF sin texto/escaneado, sin texto, error al extraer).

## Resúmenes con Claude

Un resumen (`summary.md`) tiene estos campos: en pocas palabras, problema, contribución, método, evaluación, resultados, limitaciones (declaradas e inferidas), trabajo futuro y tipo de investigación (propuesta de solución, validación, evaluación, experiencia, filosófico u opinión). Junto con el resumen se genera una clasificación (`extraction.yaml`) según las facetas del formulario del proyecto, y, si la tesis tiene tema definido, la relación de ese paper con la tesis.

Cada campo, faceta y la relación con la tesis llevan:

- **Evidencia**: una o más citas textuales, con el número de página cuando aplica. Tocar una cita resalta esa página en el PDF (o, si no se encuentra el texto exacto, muestra el pasaje extraído con la cita marcada igual).
- **Estado**: *generado* (recién creado por Claude, sin revisar), *verificado* (confirmaste que está bien) o *editado* (lo corregiste a mano). Un valor editado ya se considera tuyo y no vuelve a *generado* salvo que lo desverifiques desde *verificado*.
- **Procedencia**: el modelo y la fecha con que se generó ese campo en particular, o los del resumen completo si el campo no tiene los suyos propios.

Acciones sobre cada campo: **Verificar** (pasa a verificado), **Desverificar** (vuelve a generado) y **Editar** (abre un editor y guarda como editado). **Verificar todo** marca como verificado todo lo que esté en *generado* en ese paper de una sola vez.

**Valores propuestos**: si Claude devuelve, para una faceta de una u varias opciones, un valor que no está en la lista permitida, queda como «propuesto» bajo esa faceta. Podés **Aceptar** (lo agrega como valor permitido de la faceta) o **Mapear a…** (lo asocia a un valor ya existente, como alias). Ambas acciones se aplican a todos los papers que tengan esa misma propuesta, no solo al que estás viendo.

**Regenerar y modelo**: «Regenerar» vuelve a resumir el paper con el modelo configurado; «Regenerar con…» deja elegir el modelo para esa vez sin cambiar el de Ajustes. Volver a generar nunca pisa un campo ya verificado o editado — solo actualiza lo que seguía en *generado*.

**Forzar y truncamiento**: si el texto del paper supera el tamaño máximo de entrada configurado, el botón «Resumir»/«Regenerar» se deshabilita y aparece «Forzar», que resume usando solo el comienzo del texto hasta ese máximo. El resumen resultante queda marcado como «Resumido solo con el comienzo del texto: el paper supera el máximo de caracteres».

**Desactualizado**: un resumen pasa a *Desactualizado* cuando cambia el formulario de extracción (agregar, quitar o modificar una faceta o su descripción — agregar o quitar *valores* permitidos de una faceta, o editar los alias, no lo desactualiza) o cuando cambia el tema de la tesis (título, descripción o preguntas de investigación). La próxima vez que se regenere, se vuelve a generar todo lo que seguía en *generado*; lo verificado o editado se conserva. Si la relación con la tesis ya estaba verificada o editada cuando la tesis cambió, no se regenera: queda marcada «La tesis cambió; revisa esta relación» y espera tu revisión en vez de perder tu edición.

**Costos**: cada llamada a Claude registra su costo estimado en USD. Como la cuenta es por suscripción (no por uso facturado), estos números son solo una estimación de cuánta cuota consumís, no un cargo real.

## Modo Revisar

«Revisar pendientes», en la biblioteca, abre un repaso secuencial de todos los campos, facetas y relaciones con la tesis que sigan en estado *generado* (o, para la relación con la tesis, que haya quedado desactualizada tras revisarla) entre los papers visibles con los filtros activos.

Atajos de teclado (no funcionan mientras se escribe en un campo de texto):

- **V**: verificar el elemento actual.
- **E**: editar el elemento actual.
- **U**: desverificar el elemento actual.
- **→ / ←**: siguiente / anterior.
- **Esc**: si hay un editor abierto, lo cierra; si no, sale del modo revisar.

El panel derecho muestra el PDF con la cita resaltada cuando el paper tiene uno y la cita se encuentra en el texto; si no (sin PDF, PDF no disponible, o la cita no aparece en el PDF), muestra el pasaje de texto extraído de esa página en su lugar.

## Ajustes

Los ajustes se organizan en pestañas.

### Proyecto

- **Nombre**: el nombre del proyecto, visible en la app.
- **Carpeta**: la ruta de la carpeta del proyecto (solo lectura).
- **Idioma del contenido generado**: inglés o español. Lo usan los resúmenes y, en etapas siguientes, otras respuestas generadas.
- **PDFs**: cómo se guardan los PDFs nuevos — versionarlos con git, versionarlos con git LFS, guardarlos fuera de git (para sincronizarlos aparte, p. ej. con Syncthing) o no guardarlos y descargarlos al abrirlos (solo para papers de acceso abierto). Cambiar esta opción no mueve los PDFs ya guardados, solo afecta a los nuevos.

### Claude

- **Modelo**: Sonnet (recomendado), Haiku (más rápido, menor calidad) u Opus (máxima calidad, consume más cuota). Es el modelo por defecto para resumir; se puede elegir otro puntualmente con «Regenerar con…» o al confirmar un lote.
- **Resumir automáticamente al agregar papers**: si está activo, cada paper nuevo se resume solo en cuanto termina de indexarse su texto.
- **Tope por paper (USD est.)**: el máximo estimado que puede costar un solo resumen.
- **Tope por lote (USD est.)**: el máximo estimado acumulado dentro de una misma operación por lotes (resumir pendientes o regenerar filtrados). Al alcanzarlo, el lote se detiene sin seguir encolando.
- **Tope mensual (USD est., vacío = sin tope)**: el máximo estimado acumulado en el mes, sumando el gasto de todos tus equipos (ver «Gasto estimado este mes» más abajo). Dejar el campo vacío quita el tope.
- **Tamaño máximo de entrada (caracteres)**: cuánto texto del paper se manda a Claude como máximo. Un paper más largo no se puede resumir sin usar «Forzar» (ver «Resúmenes con Claude»).
- **Gasto estimado este mes (todos tus equipos)**: suma de los costos estimados registrados este mes en `costs/`, de cualquier dispositivo que sincronice este proyecto. Con una suscripción, estos costos son estimaciones de la cuota que consumís, no cargos reales.

### Tesis

- **Título** y **Descripción** (problema, enfoque, alcance): el tema de la tesis que Claude usa para explicar la relación de cada paper con ella. Mientras falten, el resumen no incluye esa sección («Define el tema de tu tesis en Ajustes para obtener esta sección.»); alcanza con completar estos dos campos para empezar a tener relaciones.
- **Preguntas de investigación**: se agregan y quitan con sus botones; cada una tiene un identificador propio que **nunca se renumera** aunque borres otras — así una pregunta sigue siendo la misma referencia en los resúmenes ya generados aunque cambie su posición en la lista.
- Cambiar cualquiera de estos campos desactualiza los resúmenes existentes (ver «Desactualizado» en «Resúmenes con Claude»).

### Formulario

El formulario de extracción define las facetas (columnas) con las que Claude clasifica cada paper. Se edita desde esta pestaña; también se puede ver el YAML crudo con «Mostrar project.yaml».

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

- **Clave**: en inglés, minúsculas y guiones bajos (p. ej. `dataset_public`). Solo se puede cambiar al crear la faceta; una vez guardada, la clave queda fija.
- **Tipo**: una opción, varias opciones, texto libre o escala. También solo editable al crearla.
- **Descripción**: lo que Claude lee para entender qué clasificar ahí.
- **Valores permitidos** (una/varias opciones): se agregan y quitan con sus botones; el texto debe ser en inglés, minúsculas y guiones bajos.
- **Mínimo / Máximo** (escala): límites enteros de la escala; el mínimo no puede ser mayor que el máximo.
- **Alias aprendidos**: valores propuestos por Claude que ya mapeaste a un valor permitido (ver «Valores propuestos» en «Resúmenes con Claude»); se pueden quitar uno por uno.

**Qué desactualiza los resúmenes y qué no**: agregar o quitar una faceta, o cambiar su clave, tipo o descripción, desactualiza los resúmenes existentes. Agregar o quitar un *valor* permitido, o editar los alias, no los desactualiza.

Al guardar cambios, la app muestra primero el impacto (cuántos resúmenes quedarán desactualizados, y si algún valor que vas a quitar sigue en uso en algún paper — ese valor se conserva en esos papers aunque lo quites de la lista) antes de pedir confirmación.

**Quitar y recrear una faceta**: lo ya extraído para esa faceta se conserva en los archivos de cada paper aunque la quites del formulario, y vuelve a aparecer si recreás una faceta con la misma clave (aunque con otro tipo, lo guardado que no coincida con el tipo nuevo se trata como ausente).

**Restaurar formulario por defecto** vuelve a dejar el formulario como la tabla de arriba; lo ya extraído se conserva igual en los archivos.

Si el formulario cambió por fuera de este editor (otro equipo, un `git pull`) mientras tenías cambios propios sin guardar, aparece un aviso para descartar los tuyos y recargar.

### Aplicación

- **Correo de contacto para Crossref y OpenAlex**: opcional. Si lo completás, esos servicios atienden tus consultas de metadatos con prioridad. Solo se envía a ellos, a nadie más.
- **Cerrar proyecto**: vuelve a la pantalla de bienvenida para crear o abrir otro proyecto.

## Archivos del proyecto

```
project.yaml              configuración del proyecto (nombre, idioma, política de PDFs, Claude, tesis, formulario de extracción)
papers/<clave>/           un paper por carpeta; <clave> es su clave de cita y nunca cambia
  paper.yaml              metadatos y BibTeX
  summary.md              campos del resumen, con evidencia y estado por campo
  extraction.yaml         clasificación según el formulario, y relación con la tesis
  notes.md                tus notas
  content.md              texto legible (literatura gris, páginas sin PDF)
  paper.pdf                el PDF, según la política configurada
costs/<dispositivo>.jsonl  costos estimados de cada llamada a Claude, uno por dispositivo (para que sincronizar entre equipos nunca choque)
exports/library.bib        BibTeX de toda la biblioteca; generado, no lo edites
.cache/                    índice local de búsqueda y PDFs descargados on-demand; se puede borrar sin perder nada, se reconstruye solo
```

Todo lo de arriba, salvo `.cache/`, está pensado para versionarse con git o sincronizarse entre equipos. `notes.md` y `project.yaml` (fuera de `extraction_form`) se pueden editar a mano con confianza; `paper.yaml`, `summary.md` y `extraction.yaml` también, pero con cuidado de no romper su formato. Un archivo editado por fuera de la app (o actualizado por una sincronización) se recarga solo, sin reiniciar la app.

## Problemas comunes / FAQ

**«No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.»**
Instalá la CLI `claude` y ejecutá `claude login` en una terminal.

**«Se alcanzó el presupuesto configurado.»**
Se llegó al tope por paper, por lote o mensual configurado en Ajustes → Claude. Subí el tope correspondiente (o dejá el mensual vacío para quitarlo) y reintentá.

**«Se agotó la cuota de tu suscripción de Claude. Intenta más tarde.»**
Es un límite de la cuenta de Claude, no de esta app; esperá a que se renueve la cuota.

**El paper es demasiado largo**
El botón para resumir se deshabilita y aparece «Forzar», que resume usando solo el comienzo del texto hasta el tamaño máximo configurado (ver «Tamaño máximo de entrada» en Ajustes → Claude). El resumen queda marcado como hecho con texto truncado.

**PDF escaneado sin texto**
El estado del paper muestra «PDF sin texto (escaneado)»; esta app no hace OCR, así que ese paper no se puede resumir hasta que consigas una versión con texto.

**«El formulario cambió fuera de este editor»**
Otro equipo (o un `git pull`) cambió `project.yaml` mientras tenías cambios propios sin guardar en el editor del formulario. Usá «Descartar mis cambios y recargar» para ver la versión nueva, y volvé a aplicar tus cambios si seguían siendo necesarios.

**Conflictos cuando dos equipos editan**
Si `notes.md`, `paper.yaml`, `summary.md` o `extraction.yaml` cambiaron en disco entre que la app los leyó y los quiso guardar (por ejemplo, dos equipos sincronizando a la vez), la app avisa el conflicto en vez de pisar el cambio ajeno: en notas, deja elegir entre recargar o sobrescribir con tu versión; en el resto, revisá el archivo a mano (buscá marcas de conflicto de git si usás git) antes de reintentar.
