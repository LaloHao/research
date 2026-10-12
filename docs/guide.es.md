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
- Pedir a Claude **relaciones tipadas** entre papers (extiende, usa el método de, compara con, contradice, replica, mismo problema), con justificación y citas de ambos papers que Claude busca por sí mismo con herramientas de solo lectura sobre tu biblioteca; tú las confirmas, rechazas o cambias de tipo.
- Pedir a Claude **facetas sugeridas** para el formulario de extracción: facetas nuevas, valores nuevos y alias que unen los valores propuestos sueltos, con su justificación y ejemplos citados de tus papers. Las revisas en Ajustes → Formulario; una faceta nueva se llena en los papers ya resumidos sin regenerar sus resúmenes.
- **Conversar con Claude** sobre tu biblioteca o sobre un paper: responde mientras escribe, busca en tus papers con herramientas de solo lectura y cita cada afirmación con la frase textual y su página, que la app verifica contra el texto y que abre el PDF resaltado. Las conversaciones se guardan en el proyecto y se sincronizan entre tus equipos. Si lo activas en una conversación, Claude también puede hacer cambios en la biblioteca: lo que es gratis y se puede deshacer, cuando tu mensaje lo pide; lo que cuesta, quita o borra, solo con tu aprobación.
- **Sincronizar** el proyecto entre tus equipos con git desde la app: guarda tus cambios en un commit, trae los del otro equipo, los mezcla y los sube, sin dejar nunca marcadores de conflicto en tus archivos; lo que no sabe mezclar solo te lo pregunta.
- Hacer **mapeos sistemáticos** sobre tu biblioteca: un protocolo con criterios, búsquedas en OpenAlex e importaciones de las bases de datos (todas registradas), deduplicación, cribado en dos fases con sugerencias de Claude que tú decides, y el diagrama PRISMA 2020.

Próximamente (no implementado todavía): segundo revisor, evaluación de calidad y reporte de los mapeos (tablas, gráficas y exportaciones).

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

La carpeta del proyecto es texto plano (YAML, Markdown) pensado para versionarse con git. La app sincroniza sola con git (ver «Sincronizar con git» más abajo); también puedes usar git a mano o una herramienta como Syncthing. Los archivos se recargan solos cuando cambian por fuera de la app (una sincronización, un `git pull`, un editor externo): no hace falta reiniciar. Si dos equipos editan el mismo archivo a la vez sin pasar por la sincronización de la app, la app lo detecta como conflicto (ver «Problemas comunes» más abajo). La papelera (`.trash/`) también se sincroniza: un paper que quitas en un equipo aparece en la Papelera del otro, y desde ahí se restaura o se elimina igual.

## Agregar papers

En la barra de arriba de la biblioteca puedes:

- **Pegar un DOI, un ID de arXiv o una URL** y tocar «Agregar». También acepta un id de OpenAlex (`W2741809807` o `https://openalex.org/W2741809807`); es lo que usa «Agregar» en Candidatos para los trabajos sin DOI. Con una URL que no sea DOI ni arXiv, la app mira qué hay detrás: si sirve un PDF, se agrega como PDF; si la página tiene un DOI o un ID de arXiv, se usa ese identificador; si no, se guarda como página web (literatura gris), con su texto legible si lo encuentra, y si no, avisa que «La página no tiene un artículo legible.».
- **Arrastrar uno o varios PDFs** a la biblioteca.

La app completa los metadatos automáticamente a partir del identificador. Si el paper queda con «Los metadatos están incompletos.», puedes pegar un DOI o ID de arXiv en el aviso y tocar «Completar», o tocar «Reintentar» si ya tenía uno.

Al agregar un paper (o completar sus metadatos), la app consulta en segundo plano sus referencias en OpenAlex (ver «Citas y candidatos»); no consume cuota de Claude.

Agregar un identificador o PDF que ya está en la biblioteca actualiza el paper existente en vez de duplicarlo («ya estaba en la biblioteca» / «actualizado» en el panel de actividad). Un PDF que sueltas en la biblioteca se asocia por el DOI o el ID de arXiv impreso en él, o por su título: si no coincide con ninguno, se crea un paper nuevo, y si el paper ya tiene PDF, el que soltaste se ignora. Para darle su PDF a un paper concreto, usa su pestaña PDF (ver «Adjuntar o reemplazar un PDF» más abajo).

### Adjuntar o reemplazar un PDF

Para agregar el PDF de un paper que ya está en la biblioteca (por ejemplo, uno agregado por DOI sin PDF de acceso abierto), abre el paper y, en su pestaña **PDF**, toca «Adjuntar PDF…» para elegir el archivo, o suéltalo sobre la pestaña. En una página web sin PDF, el botón «Adjuntar PDF…» está arriba en la pestaña **Contenido**, que también acepta el archivo soltado. Se acepta un solo archivo `.pdf` a la vez, de hasta 200 MB. Un PDF soltado sobre una pestaña PDF o Contenido abierta se adjunta a ese paper en vez de agregarse como paper nuevo. Un PDF adjuntado siempre se guarda en la carpeta del paper (`papers/<clave>/paper.pdf`, versionado o ignorado por git según la política de PDFs), incluso con «No guardarlos: descargarlos al abrirlos», porque no se puede volver a descargar; la copia descargada antes en `.cache/` se borra.

Cuando el paper ya tiene PDF, la pestaña PDF tiene arriba un botón «Reemplazar PDF…» (también puedes soltar el archivo ahí). Antes de reemplazarlo, la app pregunta: «Se reemplaza el PDF y se vuelve a extraer el texto. Los resúmenes no cambian.».

Adjuntar corre como un trabajo en el panel de actividad («Adjuntar PDF a <clave>», resultado «PDF adjuntado»). Solo cambia el PDF: los metadatos del paper no se vuelven a buscar ni a combinar, y el texto del PDF reemplaza al texto indexado antes (búsqueda, pestaña Texto, resúmenes que se generen desde ahora). Los resúmenes existentes se quedan como están, así que después de un reemplazo sus citas de evidencia y números de página pueden apuntar a otro lugar del PDF nuevo; regenera el resumen si eso importa. Si el archivo no es un PDF, está dañado o el `paper.yaml` del paper tiene un problema, el trabajo falla y no cambia nada.

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
  - *Por revisar (N)*: el resumen tiene N campos, facetas o la relación con la tesis todavía sin verificar ni editar, o una relación con la tesis ya revisada que quedó pendiente de volver a revisar porque cambió la tesis. N también cuenta las relaciones tipadas sugeridas que tocan al paper y que aún no confirmas ni rechazas; por eso la insignia puede aparecer aunque el resumen ya esté revisado.
  - *Revisado*: todo lo generado ya fue verificado o editado.
  - *Desactualizado*: el resumen quedó desactualizado porque cambió el formulario de extracción, o porque cambió la tesis y la relación con ella seguía en *generado* (ver «Resúmenes con Claude»).
  - *Resumen falló*: el último intento de resumir terminó en error.
  - *Sin citas*: no se encontró el paper en OpenAlex (no tiene DOI y no hubo una coincidencia exacta por título y año), así que no tiene citas ni candidatos.
- **Filtros**: por estado del resumen (todos, sin resumen, por revisar, revisados, desactualizados, con error, con relaciones por revisar) y por modelo con el que se generó (el selector se llama «Resumido con» para lectores de pantalla; sus opciones visibles son «Cualquier modelo», Sonnet, Haiku y Opus).
- **Filtro por faceta**: al hacer clic en una barra o una burbuja de las gráficas (vista Mapa), la biblioteca se abre filtrada por ese valor (o ese par de valores), con una etiqueta `faceta = valor` que se quita con ✕.
- **Actualizar citas**: vuelve a consultar en OpenAlex las referencias de todos los papers o, si hay una búsqueda o algún filtro activo, solo de los que se ven. Los trabajos aparecen en el panel de actividad.
- **Sugerir relaciones**: pide a Claude relaciones tipadas para los papers cuyos candidatos cambiaron desde su último análisis (todos o, si hay una búsqueda o algún filtro activo, solo los que se ven). Antes de encolar muestra la cantidad de papers, el costo estimado y el tope del lote; si no hay ninguno, avisa «No hay papers con candidatos nuevos por analizar.». Ver «Relaciones tipadas».
- **Acciones por lotes**: encolan de una sola vez todos los papers elegibles visibles con la búsqueda y los filtros activos (los demasiado largos se omiten salvo que ya tuvieran un resumen forzado); ambas piden confirmación antes de encolar. Todos los trabajos del lote se encolan de entrada; si se llega al tope del lote (o a la cuota de Claude) mientras corre, los trabajos que todavía estaban en cola para ese lote se cancelan.
  - *Resumir pendientes*: encola los papers sin resumen (o con resumen desactualizado o fallido) dentro del presupuesto por lote, usando el modelo elegido en el selector «Modelo del lote». La confirmación muestra la cantidad de papers, el costo estimado y el tope del lote; si no hay ninguno pendiente, avisa «No hay papers pendientes de resumir.».
  - *Regenerar filtrados con…*: con un filtro de estado activo (no «Todos»), regenera con el modelo elegido en su propio selector todos los papers visibles que tengan texto indexado.
- **Panel de actividad**: lista los trabajos en curso y recientes (agregar un identificador o PDF, adjuntar un PDF a un paper, completar metadatos, resumir, citas, quién cita a un paper, similitud de un paper, descargar el modelo de similitud, sugerir relaciones), con su estado (en cola, en curso, listo, falló, cancelado) y, si corresponde, el resultado (agregado, actualizado, ya estaba en la biblioteca, PDF adjuntado, resumido, citas actualizadas, no se encontró en OpenAlex, citas entrantes actualizadas, modelo descargado, relaciones sugeridas, sin candidatos para analizar). La descarga del modelo muestra su avance en porcentaje. Un trabajo en cola o en curso se puede cancelar. Tocar el nombre de un trabajo abre su paper.

## Quitar papers y papelera

**Quitar de la biblioteca** no borra nada: mueve la carpeta completa del paper (`paper.yaml`, PDF, resumen, extracción, notas y texto) de `papers/<clave>/` a `.trash/<clave>/`, dentro del proyecto, y anota cuándo y en qué equipo en `.trash/<clave>/trashed.yaml`.

- **Un paper:** en su detalle (en la biblioteca o en el grafo), «Quitar de la biblioteca» pide confirmación con su título.
- **Varios:** con una búsqueda o algún filtro activo, el botón «Quitar de la biblioteca» de la lista quita todos los papers visibles; la confirmación dice cuántos son. Sin búsqueda ni filtro, el botón no aparece.
- Antes de moverlo se cancelan sus trabajos pendientes (resumen, citas, quién lo cita, similitud, relaciones y adjuntar PDF).
- Durante unos segundos aparece «N papers movidos a la papelera» con **Deshacer**, que los restaura.

Un paper en la papelera desaparece de la biblioteca, la búsqueda, el grafo, las gráficas, los similares, el modo Revisar y `exports/library.bib`. Sus relaciones tipadas se conservan en `relations.yaml`, pero quedan ocultas (en la app y para Claude) hasta que lo restaures. Su clave queda reservada: un paper nuevo nunca la reutiliza.

Si otro programa tiene abierto un archivo del paper (por ejemplo, su PDF en un visor), la app reintenta unos instantes y, si sigue ocupado, avisa «Otro programa tiene abierto un archivo de ese paper…».

### Papelera

La vista **Papelera** (🗑 en la barra lateral) lista los papers quitados con título, autores, año, el día en que se quitaron y en qué equipo («este equipo» u «otro equipo»), con una búsqueda simple y casillas para elegir varios.

- **Restaurar** devuelve la carpeta a `papers/<clave>/` tal como estaba, con sus relaciones; si su PDF no cambió, no se vuelve a extraer el texto.
- Si mientras tanto **otro paper distinto** tomó esa clave, se restaura con la siguiente libre (por ejemplo `he2017draina`), con su BibTeX y sus relaciones ajustados; el aviso dice con qué clave quedó.
- Si **el mismo paper** (mismo DOI, arXiv o título) volvió a la biblioteca, la app avisa y ofrece **Fusionar** o **Cancelar**. Fusionar deja un solo paper, el de la biblioteca: junta ambas notas (las de la papelera al final), se queda con el resumen y la extracción con más entradas verificadas o editadas, toma los archivos de la papelera que la biblioteca no tiene y pasa sus relaciones a la clave de la biblioteca. Ninguna copia distinta se pierde: la que no gana queda junto a la otra como `<nombre>.trashed.<ext>` (de la papelera) o `<nombre>.before-merge.<ext>` (de la biblioteca), por ejemplo `paper.trashed.pdf`.
- Si quedó una carpeta `papers/<clave>/` sin `paper.yaml` (restos de una sincronización), restaurar mete los archivos en ella sin pisar ninguno: el que choca queda como `<nombre>.trashed.<ext>`.
- Lo que la app no mueve (una subcarpeta o un archivo como `.DS_Store`) sigue en la papelera y el aviso lo dice («Algo de … sigue en la papelera»). El paper vuelve igual a la biblioteca, con sus relaciones y sus trabajos; elimina definitivamente lo que quedó cuando ya no lo necesites.
- **Eliminar definitivamente** (uno o varios) y **Vaciar papelera** piden confirmación con el número de papers y de relaciones que se borrarán de `relations.yaml`, y se borran exactamente esos papers. Si `relations.yaml` tiene un conflicto de git, no se borra nada hasta resolverlo. Lo eliminado solo se recupera desde el historial de git, y los PDF que guardas fuera de git (política «Guardarlos fuera de git» o «No guardarlos») no se pueden recuperar.
- Una carpeta de la papelera que no se puede restaurar aparece con el motivo, por ejemplo «No se puede restaurar: le falta paper.yaml.»; revísala en la carpeta `.trash` del proyecto. «Restaurar (N)» (para los marcados) cuenta y restaura solo los que se pueden restaurar.

En **Candidatos** (vista Mapa), un trabajo que corresponde a un paper de tu papelera (por id de OpenAlex o DOI) aparece «En la papelera» con **Restaurar** en lugar de «Agregar».

## Sincronizar con git

La app sincroniza la carpeta del proyecto con un repositorio git: guarda tus cambios en un commit, trae los del otro equipo, los mezcla y sube el resultado. Usa el git instalado en tu equipo y sus credenciales (ssh-agent o el gestor de credenciales de git): nunca pide ni guarda contraseñas. Si tu clave SSH tiene frase de paso, tiene que estar cargada en el ssh-agent (`ssh-add`) antes de sincronizar; la app no puede escribirla por ti.

- **En la barra lateral**, sobre ⚙, el botón ⟳ sincroniza en ese momento (o abre la vista Sincronización si no puede, o si esa sincronización terminó en error o en conflictos); debajo aparece un estado corto («ahora», «3 min», «sin subir», «sin red», «conflictos»…) y, al pasar el cursor, el completo: «Sincronizado hace 3 min», «Cambios sin subir», «Sin conexión», «Conflictos por resolver» o «Sincronizando…». Tocar el estado abre la vista **Sincronización**, con el repositorio, la rama, el último error y el botón «Sincronizar».
- **Qué se sube**: solo los archivos de la carpeta del proyecto (respetando `.gitignore`; `.cache/` nunca), en un commit «research: sync from <equipo>» que lista los papers tocados. Si no cambió nada, no hace commit. Si el proyecto está dentro de un repositorio mayor (por ejemplo, el de tu tesis), lo que tengas fuera de la carpeta, preparado o no, no se toca ni entra en el commit; los commits que hayas hecho tú con git sí se suben con la rama. Si habías preparado (`git add`) algún cambio dentro del proyecto a mano, la sincronización lo incluye en su commit igual: no se pierde, pero deja de aparecer como «preparado» por separado.
- **Cómo mezcla**: nunca reescribe la historia (mezcla, no rebase: los commits del otro equipo quedan tal cual) y nunca deja marcadores de conflicto en tus archivos, porque calcula la mezcla aparte y solo cambia los archivos cuando el resultado está completo. Mezcla sola `relations.yaml` (une por `id`; si una relación cambió en ambos equipos gana el cambio más reciente, y una que se borró en un equipo sin tocarse en el otro queda borrada), `facet-suggestions.yaml` (igual, por `id`: una sugerencia que cambió en un solo equipo toma la versión de ese equipo, y si cambió en ambos gana el cambio más reciente), los registros de gasto `costs/` (une las líneas), las conversaciones de `chats/` (si en un equipo solo se agregaron mensajes, o se renombró o archivó la conversación, se mezclan; si los dos equipos siguieron la misma conversación, se conservan las dos: la del otro equipo aparece como «(copia de <equipo>)»), `project.yaml` clave por clave (los candidatos descartados se suman), el `trashed.yaml` de un paper quitado en ambos equipos (gana la fecha más reciente) y `exports/library.bib` (la app la vuelve a generar). Un archivo que agregaste y que git reubicó por una carpeta renombrada en el otro equipo no se pierde ni se pregunta: queda junto al original como `<nombre>.conflict` (o `.conflict-2`, etc., si ya existe uno).
- **Conflictos**: si un archivo cambió en ambos equipos y la app no sabe mezclarlo (un `summary.md`, `extraction.yaml`, `paper.yaml` o `notes.md`, o la misma clave de `project.yaml`), la sincronización se detiene sin tocar tus archivos y la vista Sincronización muestra «Conflictos por resolver»: cada archivo con el paper al que pertenece, qué hizo cada equipo, «Ver diferencias» (las dos versiones lado a lado) y «Quedarme con la mía» / «Usar la del otro equipo». Si un equipo quitó un paper a la papelera mientras el otro lo editaba, eliges «Conservar el paper» (vuelve a la biblioteca con las ediciones y sale de la papelera) o «Aceptar que se quitó» (se queda en la papelera, con las ediciones que git pudo llevar ahí). Nada se sube hasta que elijas en todos («Terminar sincronización» se activa recién entonces); «Cancelar» deja todo como estaba (tus cambios quedan en un commit local, sin subir). Si algo cambia mientras decides (se guarda algo nuevo aquí o el otro equipo sube cambios), la app te lo vuelve a preguntar antes de seguir. La versión que no elijas no se pierde: queda en el historial de git.
- **Fuera de la carpeta del proyecto**: si el proyecto vive dentro de un repositorio mayor y el otro equipo cambió los mismos archivos de fuera, o si tienes un merge o un rebase hecho a mano sin terminar, la sincronización se detiene sin tocar nada; resuélvelo con git y vuelve a sincronizar.
- **Automática**: «Sincronizar automáticamente» (Ajustes → Aplicación, encendida por defecto) sincroniza al abrir el proyecto y cada 10 minutos (o el intervalo que elijas, de 5 a 120) si el repositorio tiene remoto. Se salta un intervalo si hay conflictos esperando tu decisión o si en ese momento se están moviendo papers a o desde la papelera, y nunca abre ventanas: si falla (sin red, credenciales), solo lo muestra la barra lateral y lo vuelve a intentar en el siguiente intervalo.
- **Al cerrar**: si quedan cambios sin commit en el proyecto, commits sin subir o decisiones pendientes, la app pregunta «Sincronizar y cerrar», «Cerrar sin sincronizar» o «Cancelar». La ventana se cierra solo si esa sincronización termina bien; si encuentra conflictos o falla, se queda abierta y puedes ir a «Ver sincronización». Si en ese momento corría una sincronización automática, la espera y vuelve a sincronizar, para que se suba también lo último que guardaste. Mientras sincroniza puedes elegir «Cerrar sin sincronizar»: la subida se detiene y lo que no alcanzó a subirse queda en tu equipo para la próxima vez.
- **Primer uso**: si la carpeta no está en un repositorio, la vista Sincronización ofrece «Inicializar repositorio» (`git init` en la carpeta del proyecto, en la rama `main`, con el `.gitignore` que la app ya mantiene) y un campo para la URL de un repositorio remoto vacío (en GitHub, GitLab o una carpeta compartida); una URL con contraseña se rechaza. Con la URL, al terminar sube el proyecto. Si el repositorio no tiene remoto, la misma URL con «Agregar remoto y sincronizar»; si la rama no sigue a ninguna rama remota, «Conectar y sincronizar» la conecta con la rama del mismo nombre (o la publica si no existe). Esa URL solo se puede corregir mientras ese remoto nunca llegó a funcionar (no se usó para sincronizar todavía); una vez que funcionó, para cambiarla hay que usar `git remote set-url origin <url>` a mano. Si el remoto tiene una historia distinta de la de este repositorio, la app lo rechaza (ver «Problemas comunes» más abajo). Para un segundo equipo, clona el repositorio con git y abre esa carpeta como proyecto.
- **PDFs con git LFS**: con la política «Versionarlos con git LFS» hace falta tener git-lfs instalado; si falta, la sincronización lo avisa. La app prepara git-lfs en el repositorio y sube los PDF antes que los commits que apuntan a ellos, así que funciona aunque tengas desactivados los hooks de git (`core.hooksPath`); si la subida falla, no se sube nada.

## Detalle del paper

Al seleccionar un paper se abren sus pestañas (solo las que apliquen):

Aparecen en este orden: Resumen, Contenido, PDF, Texto, Relaciones, Chat, Notas.

- **Resumen**: ver «Resúmenes con Claude» abajo.
- **Contenido**: el texto legible extraído, siempre que haya (típicamente páginas web sin PDF), mostrado como un documento legible (encabezados, párrafos, listas, tablas, citas en bloque, código). Los enlaces abren en el navegador del sistema; las imágenes no se cargan, se muestran como una pequeña ficha que enlaza a la imagen. Seguir un enlace de evidencia en un paper web abre esta pestaña con la cita resaltada y centrada en la vista; si el texto exacto no se encuentra, se muestra un pequeño aviso. Al seleccionar texto aparece «Preguntar a Claude» (ver «Chat con Claude»).
- **PDF**: el visor del PDF. Aparece para todo paper que no sea una página web, aunque todavía no tenga PDF adjunto: en ese caso muestra «Este paper no tiene PDF. Usa «Adjuntar PDF…» o suelta el archivo aquí.» en vez del visor. Ver «Adjuntar o reemplazar un PDF» más arriba. Al seleccionar texto aparece «Preguntar a Claude» (ver «Chat con Claude»).
- **Texto**: el texto extraído del PDF, página a página, dispuesto para leer. Aparece cuando el paper tiene PDF y su texto está indexado (ver «Leer el texto» abajo).
- **Relaciones**: arriba, la sección «Relaciones tipadas» (ver «Relaciones tipadas»); debajo, el estado de las citas (sin consultar, consultadas en tal fecha con N citas en OpenAlex, o *Sin citas*) con el botón «Actualizar citas»; «Cita a (en tu biblioteca)» y «Citado por (en tu biblioteca)» (solo papers de tu biblioteca; un clic los abre); cuántas referencias no están en tu biblioteca, con «Ver candidatos», que abre la pestaña Candidatos filtrada por este paper; y «Similares»: los 10 papers más parecidos, con su puntuación y sus razones (por ejemplo «6 referencias en común · citados juntos por 3 papers · technique: ner · similitud de contenido 0.82»).
- **Chat**: las conversaciones con Claude sobre este paper y «Nueva conversación» (ver «Chat con Claude»).
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

**Desactualizado**: un resumen pasa a *Desactualizado* cuando cambia el formulario de extracción (quitar una faceta que el paper tiene, o cambiar su clave, tipo, descripción o — en una escala — su mínimo o máximo; agregar una faceta no lo desactualiza: en ese paper la faceta queda «Faceta nueva sin llenar», ver «Facetas sugeridas por Claude» — salvo que el paper todavía guarde valores de una faceta anterior con esa misma clave, quitada y vuelta a agregar, que sí lo desactualiza; agregar o quitar *valores* permitidos de una faceta, o editar los alias, tampoco) o cuando cambia el tema de la tesis (título, descripción o preguntas de investigación; basta con que uno de título o descripción esté definido para que haya relación con la tesis). La próxima vez que se regenere, se vuelve a generar todo lo que seguía en *generado*; lo verificado o editado se conserva. Si la relación con la tesis ya estaba verificada o editada cuando cambió la tesis, el resumen entero no pasa a Desactualizado: la relación con la tesis queda marcada «La tesis cambió; revisa esta relación» y el paper pasa a «Por revisar», en vez de perder tu edición o verificación.

**Costos**: cada llamada a Claude registra su costo estimado en USD. Como la cuenta es por suscripción (no por uso facturado), estos números son solo una estimación de cuánta cuota consumes, no un cargo real. Una llamada que se corta antes de informar su costo (se pasó del tiempo máximo o cancelaste el trabajo) se registra por el tope por paper, marcada como estimada (`estimated: true`), para que cuente en los topes por lote y mensual.

## Modo Revisar

«Revisar pendientes», en la biblioteca, abre un repaso secuencial de todos los campos, facetas y relaciones con la tesis que sigan en estado *generado* entre los papers visibles con los filtros activos, más las relaciones con la tesis ya revisadas que quedaron pendientes porque cambió la tesis (ver «La tesis cambió; revisa esta relación» en «Resúmenes con Claude»); para estas últimas vuelve a aparecer el botón **Verificar**.

Atajos de teclado (se muestran en pantalla como «V verificar · E editar · U desverificar · → siguiente · ← anterior · Esc salir»; se ignoran mientras se escribe en un campo de texto):

- **V**: verificar el elemento actual.
- **E**: editar el elemento actual.
- **U**: desverificar el elemento actual.
- **→ / ←**: siguiente / anterior.
- **Esc**: si hay un editor abierto, no hace nada (cierra el editor con su propio botón «Cancelar»); si no hay ninguno abierto, sale del modo revisar.

El panel derecho muestra el PDF con la cita resaltada cuando el paper tiene uno y la cita se encuentra en el texto. Si no, muestra el pasaje, dispuesto para leer: en una página web, su contenido como en la pestaña **Contenido**, con la cita resaltada (o un pequeño aviso si el texto exacto no se encuentra); si la cita no aparece en el PDF, el texto de esa página como en la pestaña **Texto** (encabezados, párrafos, encabezados y pies de página atenuados), con la cita marcada donde aún se pueda ubicar. Si el PDF no se puede cargar (o no hay contenido que mostrar), se muestra el texto extraído de esa página tal cual.

La cola también incluye las relaciones tipadas sugeridas, cada una una sola vez, junto al primero de sus dos papers en la lista. En una relación los atajos son «V confirmar · R rechazar · E elegir otro tipo · U deshacer · → siguiente · ← anterior · Esc cerrar la lista o salir»: **V** la confirma, **R** la rechaza, **E** abre la lista de tipos (solo los que ese par todavía no tiene; **Esc** la cierra) y **U** deshace la última decisión; la tarjeta también ofrece «Invertir dirección» en los tipos con dirección. Después de cada decisión aparece unos segundos «Decisión guardada.» con «Deshacer», que deja la relación como estaba y la vuelve a poner en la cola. Mientras ese aviso se ve, **U** deshace esa decisión aunque estés en un campo del resumen; si no hay nada que deshacer, **U** desverifica como siempre. El panel derecho muestra lado a lado la evidencia de los dos papers (el PDF con la cita resaltada o, si no, el pasaje, como en el resto del modo Revisar).

## Citas y candidatos

Las citas vienen de [OpenAlex](https://openalex.org), sin usar Claude. Para cada paper, la app busca su obra en OpenAlex por su id de OpenAlex, si no por su DOI y, si no tiene DOI, por su título exacto y año (solo si hay una coincidencia inequívoca; nunca para páginas web). Guarda en `paper.yaml` la lista completa de lo que cita, esté o no en tu biblioteca, y el total de citas que tiene en OpenAlex. Si no la encuentra, el paper queda con la insignia *Sin citas*. Si la obra que encuentra por id tiene otro DOI que el paper, manda el DOI del paper. Al completar o cambiar el DOI de un paper («Completar» o «Reintentar»), se descartan las citas de la obra anterior y se vuelven a buscar solas.

OpenAlex limita las consultas por día. Sin clave alcanza de sobra para unos cientos de papers; si llegas al límite (en un trabajo de citas o al cargar los datos de los candidatos), los trabajos de citas pendientes se cancelan y aparece «Se alcanzó el límite diario de OpenAlex. Reintenta mañana o agrega una clave de API en Ajustes.». Una clave gratuita (Ajustes → Aplicación) da un presupuesto mayor.

**Candidatos** (vista Mapa → Candidatos) son trabajos que no están en tu biblioteca y que:

- **Referencias de tus papers**: son citados por al menos N de tus papers.
- **Trabajos que citan a tus papers**: citan al menos N de tus papers. Para verlos, primero toca «Buscar quién cita a mis papers», que consulta en OpenAlex quién cita cada paper (un trabajo por paper, en el panel de actividad). Se saltan los papers consultados en los últimos 7 días, así que volver a tocarlo no gasta dos veces el presupuesto diario; pasada esa semana los vuelve a consultar.

La tabla muestra título (enlace al DOI o a OpenAlex), año, autores, «Citado por tus papers», «Cita a tus papers» y «Citas en OpenAlex». **Agregar** lo ingresa como cualquier DOI (o por su id de OpenAlex si no tiene DOI); **Descartar** lo guarda en `project.yaml` y no vuelve a aparecer (en ningún equipo). Los que ya están en tu biblioteca (por id de OpenAlex o DOI) nunca aparecen. Un trabajo que está en tu papelera aparece «En la papelera» y se restaura con «Restaurar» (ver «Quitar papers y papelera»).

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

## Relaciones tipadas

Claude puede sugerir cómo se relaciona un paper con otros de tu biblioteca:

- **Extiende**: construye directamente sobre el otro (lo extiende, mejora o generaliza).
- **Usa el método de**: aplica un método, herramienta, dataset o técnica del otro, sin extenderlo.
- **Compara con**: se comparan directamente (uno es línea base del otro, o se evalúan lado a lado). No tiene dirección.
- **Contradice**: reporta resultados o afirmaciones que chocan con los del otro.
- **Replica**: reproduce el estudio o los experimentos del otro.
- **Mismo problema**: abordan el mismo problema con enfoques distintos, sin construir uno sobre el otro. No tiene dirección.

**Cómo se sugieren.** Para cada paper la app elige hasta 12 *candidatos*: los papers de tu biblioteca que cita o que lo citan y, después, los más similares (ver «Similitud»). Claude recibe el paper con su resumen (o su resumen de autor), los candidatos con un resumen corto y las relaciones ya registradas **de ese paper** (nunca las del resto de la biblioteca), incluidas las rechazadas para no repetirlas. Luego busca la evidencia él mismo con herramientas de **solo lectura** sobre tu biblioteca: búsqueda en el texto, búsqueda por significado (si el modelo local está descargado), búsqueda de un texto literal dentro de un paper (sin distinguir mayúsculas ni acentos), lectura de páginas, datos y resumen de un paper, sus citas y sus similares. No puede escribir nada ni ver archivos fuera del proyecto; las herramientas existen solo mientras dura esa consulta y puede usarlas como mucho 12 veces por paper. Cada cita que devuelve se busca en el texto de su paper, como en los resúmenes; las que no aparecen se ven subrayadas con una onda.

**Cuándo.** Con «Sugerir relaciones» en la pestaña Relaciones de un paper (lo analiza siempre, con todos sus candidatos), con el lote «Sugerir relaciones» de la biblioteca o automáticamente, si activas «Sugerir relaciones automáticamente» en Ajustes → Claude. El lote y el disparo automático solo analizan un paper si apareció algún candidato que su último análisis no vio, y nunca vuelven a mirar un par que ya se analizó desde el otro paper (si Loghub ya se analizó con Drain como candidato, al analizar Drain no se vuelve a mirar Loghub). Se analiza un paper a la vez, con el modelo configurado y los mismos topes que los resúmenes; el costo queda en `costs/`. Si un paper llega a su tope por paper, falla solo ese paper y el lote sigue; el lote se detiene si se agota la cuota de Claude o se llega al tope del lote o al mensual. Los disparos automáticos de un mismo día cuentan como un solo lote para el tope por lote. Si el análisis de un paper falla, el disparo automático no lo reintenta durante 24 horas (o hasta que reinicies la app); el botón del paper sí. Si tocas «Sugerir relaciones» mientras ese paper ya espera en cola un análisis del lote o del disparo automático, ese trabajo pasa a ser el tuyo (con todos los candidatos y fuera del lote); si ya hay uno corriendo, el tuyo se encola después.

**Revisarlas.** En la pestaña Relaciones de cada paper, la sección «Relaciones tipadas» muestra:

- «Sugeridas», con «Confirmar», «Rechazar», «Cambiar tipo» (solo ofrece los tipos que ese par todavía no tiene), «Invertir dirección» (en los tipos con dirección) y «Editar justificación». Las citas de este paper llevan su página y abren el PDF con la cita resaltada; junto a las del otro paper, «Abrir» abre ese paper.
- «Confirmadas»: se pueden devolver a sugeridas («Devolver a sugerida»), rechazar o cambiar de tipo.
- «Rechazadas (N)», plegada: rechazar nunca borra; «Restaurar» la devuelve a sugeridas y «Confirmar» la confirma.

Cambiar el tipo o invertir la dirección deja la relación confirmada y marcada como *editada*; ningún tipo anterior se vuelve a sugerir. Editar la justificación la marca como *editada* sin cambiar su estado. Tras cada decisión aparece unos segundos «Deshacer». Volver a analizar un paper reemplaza solo las sugerencias sin revisar que produjo un análisis anterior de ese mismo paper con los candidatos que mira esta vez (Claude puede repetirlas si siguen justificadas); las de un par que esta vez se salta porque ya se analizó desde el otro paper se conservan; las que sugirió el análisis del otro paper, las confirmadas, las rechazadas y las editadas no se tocan.

**`relations.yaml`.** Todas las relaciones se guardan en un solo archivo en la raíz del proyecto, ordenadas por `id` (las dos claves en orden alfabético más el tipo, por ejemplo `he2017drain__zhu2020loghub__extends`), con su estado (`suggested`, `confirmed` o `rejected`), la justificación, las citas con su página y si se encontraron, y el modelo, la fecha y el paper cuyo análisis la sugirió; además, en `analyzed`, con qué candidatos se analizó cada paper por última vez (así un índice reconstruido nunca vuelve a gastar en lo ya analizado). Está pensado para versionarse con git. Si un `git pull` le deja marcadores de conflicto, la app no lo modifica y muestra, en un aviso abajo de la ventana, «relations.yaml tiene marcadores de conflicto de git: la app no lo modifica hasta que se resuelva.» con «Resolver automáticamente» (une ambas versiones por `id`; si una misma relación cambió en los dos lados, gana el cambio más reciente; conserva las claves que no conoce y, si tuvo que descartar entradas inválidas, lo avisa) y «Mostrar archivo». Si el archivo no se puede leer por otro motivo, se muestra «relations.yaml no se puede leer: …» y hay que corregirlo a mano.

## Facetas sugeridas por Claude

Claude puede proponer cómo mejorar el formulario de extracción a partir de tu tesis (título, descripción y preguntas de investigación), del formulario actual y de lo que hay en la biblioteca: un inventario de los papers, cómo se usa cada faceta y los valores «propuestos» que quedaron sin asignar en los resúmenes. Para comprobar lo que propone lee la biblioteca con herramientas de solo lectura (las de las relaciones tipadas, más listar los papers, leer el resumen y las facetas de uno y ver cómo se usa cada faceta); nunca escribe nada.

Sugiere tres cosas:

- **Faceta nueva**: clave, tipo, descripción y valores (o mínimo y máximo, en una escala), con una justificación de cómo sirve a tus preguntas de investigación y ejemplos citados de tus papers.
- **Valor nuevo** para una faceta de una o varias opciones, típicamente uno que varios papers propusieron.
- **Alias**: une valores propuestos que significan lo mismo en un valor existente o nuevo.

**Sugerir.** En Ajustes → Formulario, la sección «Sugerencias de Claude» tiene el botón «Sugerir facetas»; antes de encolarlo muestra cuántos papers revisará, el costo estimado y el tope de la ejecución. Corre como un trabajo en Actividad, uno a la vez. Cada ejecución nueva reemplaza solo las sugerencias que seguían sin revisar: las aceptadas y las rechazadas se conservan, y Claude ve las rechazadas para no repetirlas. También puede correr sola con «Sugerir facetas automáticamente» (ver «Claude» en Ajustes).

**Revisar.** Cada sugerencia muestra su tipo, la propuesta, la justificación y los ejemplos; tocar una cita abre el pasaje con la cita resaltada (en el PDF, si el paper lo tiene). Una cita que no se encontró en el texto queda marcada «cita no encontrada en el texto». Los botones:

- «Aceptar»: aplica la sugerencia al formulario. Una faceta nueva se agrega y la sección ofrece llenarla en los papers ya resumidos, con el costo estimado; un valor nuevo se agrega a su faceta; un alias se agrega (con el valor destino, si es nuevo). En los papers cuya faceta sigue en *generado*, el valor nuevo o el alias reemplazan ese valor propuesto; lo verificado o editado no se toca.
- «Editar y aceptar»: abre la propuesta en el mismo recuadro (clave, tipo, descripción, valores o rango; el valor; o el valor en el que se unen los alias), con las mismas reglas que el editor del formulario, y la acepta con tus cambios («Guardar y aceptar»).
- «Rechazar»: la pliega en «N rechazadas», desde donde «Restaurar» la devuelve a revisar.
- «Deshacer» aparece unos segundos después de cada decisión. Deshacer una aceptación devuelve el formulario y los papers que cambió a como estaban, siempre que nada haya cambiado desde entonces.

Mientras tengas cambios sin guardar en el editor del formulario no se puede aceptar ni editar y aceptar («Guarda o descarta los cambios del formulario antes de aceptar sugerencias.»). Si el formulario cambió desde la sugerencia (por ejemplo, ya agregaste esa faceta, o ningún paper propone ya esos valores), la sugerencia dice por qué ya no aplica y solo se puede rechazar. Las aceptadas quedan plegadas en «N aceptadas». La pestaña muestra «Formulario (N)» y la sección «N sugerencias por revisar».

**Llenar facetas nuevas.** Agregar una faceta (aceptando una sugerencia o a mano en el editor) no desactualiza los resúmenes: los papers ya resumidos muestran «Faceta nueva sin llenar» (en la lista y en la pestaña Resumen, con «Facetas nuevas sin llenar: …») y se llenan con un trabajo barato por paper que le pide a Claude solo las facetas nuevas, con evidencia, sin regenerar el resumen ni tocar nada verificado o editado. Los valores llenados quedan *generados*, para revisar como los demás. Se ofrece llenar justo después de aceptar una faceta nueva, con «Llenar en N papers»; desde el paper, con «Llenar facetas nuevas (~$x)», que abre una confirmación con el costo estimado y el tope del lote antes de encolar; o en lote con «Llenar facetas nuevas» en la biblioteca (todos los papers con resumen al día que lo necesitan, o solo los visibles si hay una búsqueda o un filtro; el filtro «Con facetas sin llenar» los muestra), siempre pidiendo confirmación con el costo estimado y el tope del lote. Usa el mismo texto que el resumen: un paper resumido solo con el comienzo de su texto se llena con ese mismo comienzo. Un paper con el resumen desactualizado no se llena (al regenerarlo recibe todas las facetas), y los papers que resumas después reciben las facetas nuevas con su resumen.

**`facet-suggestions.yaml`.** Las sugerencias viven en un archivo en la raíz del proyecto, ordenado por `id` (el tipo más lo que cambia, p. ej. `new_facet__data_source`), con su estado (`suggested`, `accepted` o `rejected`), la justificación, los ejemplos y la última ejecución. Se versiona con el proyecto, y la sincronización de la app lo mezcla sola.

**Costos.** Cada ejecución se registra en `costs/` como `suggest_facets` (sin paper) y cada llenado como `fill_facets`.

## Chat con Claude

Puedes conversar con Claude sobre tu biblioteca en dos lugares:

- **La vista Chat** (💬 en la barra lateral): todas tus conversaciones, las más recientes primero, con un buscador (busca en títulos y mensajes, sin distinguir mayúsculas ni acentos), un filtro por paper y las archivadas plegadas al final («N archivadas»). «Nueva conversación» empieza una sobre toda la biblioteca.
- **La pestaña Chat de un paper**: las conversaciones sobre ese paper y «Nueva conversación». Claude recibe los metadatos y el resumen del paper, y puede buscar también en el resto de la biblioteca.

**Cómo responde.** Cada mensaje que envías (Enter envía; Mayús+Enter hace un salto de línea) se manda a Claude con tu tesis, el paper (en su pestaña) y la conversación hasta ahí: los mensajes más recientes completos y, de los anteriores, una línea por mensaje. Claude busca en tu biblioteca con las mismas herramientas de solo lectura que usa para las relaciones tipadas (buscar texto, buscar por significado, encontrar una frase en un paper, leer páginas, ver el resumen, las citas y los papers parecidos), como mucho 12 veces por respuesta y durante 10 minutos como máximo, y, mientras no actives las acciones de la conversación, nunca escribe nada (ver «Acciones desde el chat»). Lo que devuelven las herramientas se le pasa como datos, nunca como instrucciones. La respuesta aparece mientras se escribe; mientras tanto el campo de mensaje se desactiva y «Detener» la corta: lo que alcanzó a escribir queda guardado como «respuesta detenida».

**Citas verificadas.** Claude debe acompañar cada afirmación sobre un paper con una cita: la clave, la página y la frase copiada tal cual. La app comprueba cada frase contra el texto del paper, con la misma tolerancia que la evidencia de los resúmenes, y la muestra como una ficha «clave, p. N». Si no la encuentra, la ficha dice «no encontrada»; si el paper está en la papelera, «paper en la papelera»; si no se sabe a qué paper se refiere, «paper desconocido». Bajo la respuesta se indica cuántas citas no se verificaron. Al hacer clic en una ficha se abre a la derecha el PDF (o el contenido web) del paper en esa página, con la frase resaltada; si no se puede resaltar, se muestra el texto de la página.

**Bajo cada respuesta** aparecen su modelo y su costo, y tres botones; ninguno escribe sin tu clic:

- «Copiar»: la respuesta en Markdown, con las citas como texto (`"frase" [clave, p. N]`).
- «Guardar en notas del paper»: la agrega al final de `notes.md`, con un encabezado con la fecha y el título de la conversación. En la pestaña de un paper va a ese paper; en la vista Chat eliges el paper (primero los citados).
- «Copiar BibTeX de las citas»: las entradas BibTeX de los papers citados que están en tu biblioteca.

**Preguntar sobre una selección.** Al seleccionar texto en la pestaña PDF o en Contenido aparece «Preguntar a Claude»: abre la pestaña Chat del paper con ese fragmento y su página encima del campo de mensaje (lo puedes quitar con «Quitar fragmento»), y se envía citado con tu siguiente pregunta. La pestaña Texto no lo ofrece. Una selección más larga se corta a 1000 caracteres. Si la selección no se puede citar tal cual (muy corta), el botón se convierte en un aviso: «Esta selección no se puede citar: selecciona un poco más de texto.».

**El encabezado de la conversación** tiene el selector de modelo (una conversación nueva empieza con el modelo de Ajustes → Claude; cambiarlo vale para las respuestas siguientes), el costo acumulado, «Renombrar», «Archivar» / «Desarchivar» y «Borrar» (pide confirmación; el historial de git conserva el archivo). El título se toma de la primera pregunta.

**Errores.** Si Claude no está disponible, se agotó la cuota, se alcanzó un tope o tardó demasiado, el aviso aparece en la conversación con «Reintentar». Tu pregunta queda guardada sin respuesta (también si cierras la app) y «Reintentar» la vuelve a mandar. Si el tope mensual ya no alcanza, el mensaje no se envía y su texto queda en el campo.

**Gasto.** Cada respuesta tiene su propio tope, «Tope por mensaje de chat (USD est.)» (0,5 por defecto, en Ajustes → Claude), y cuenta para el tope mensual. Una respuesta detenida, o que tardó demasiado, se cuenta por su tope como estimación.

**Dónde se guardan.** Cada conversación es un archivo `chats/<id>.md`, Markdown legible y editable a mano: arriba, sus datos (título, paper, modelo, fechas, si está archivada y el costo); después, los mensajes con encabezados `## Tú — <fecha>` y `## Claude — <fecha> · <modelo> · <costo>`, con las citas escritas como `[[clave|p. N|"frase"]]`. Las acciones quedan entre los mensajes bajo `## Acción — <fecha> · <herramienta> · <estado> · <id>`, con un bloque YAML de lo que se pidió y lo que pasó. El texto que escribas antes del primer encabezado se pierde la próxima vez que la app escriba el archivo. Se versionan y sincronizan con git (ver «Cómo mezcla» en «Sincronizar con git»). Si quitas un paper a la papelera, sus conversaciones se conservan y su encabezado indica que el paper está en la papelera.

## Acciones desde el chat

Toda conversación empieza solo leyendo tu biblioteca. En su encabezado hay dos interruptores, apagados por defecto, que se guardan en la conversación (y se sincronizan con ella):

- **Acciones**: Claude puede, desde esta conversación, agregar papers (DOI, arXiv o URL), adjuntar un PDF, escribir notas, confirmar, rechazar, devolver a sugeridas, cambiar de tipo o invertir relaciones tipadas, verificar o editar campos y facetas de un resumen, aceptar o unir valores propuestos, aceptar, rechazar o restaurar sugerencias de facetas, lanzar resúmenes, sugerencias de relaciones y de facetas y el llenado de facetas nuevas, quitar papers a la papelera, restaurarlos y eliminarlos definitivamente.
- **Sincronizar con git**: Claude puede ver el estado de la sincronización y sus conflictos (es gratis) y, si lo decides, sincronizar ahora o resolver conflictos (siempre te preguntan primero). No necesita «Acciones».

**Quién decide.** La regla la aplica la app, no Claude:

- **Sin preguntarte** solo hace lo que es gratis y se puede deshacer —una nota, una decisión de revisión (verificar, desverificar), confirmar o rechazar una relación, aceptar o rechazar una sugerencia de faceta, agregar un paper (si no tienes «Resumir automáticamente al agregar» activado) o restaurar de la papelera— y solo cuando la acción trae palabras de **tu último mensaje**: cada acción cita una frase tuya, y la app comprueba que esté, tal cual (sin importar mayúsculas, acentos ni espacios, con al menos unas pocas letras o números; un «sí» suelto no alcanza), en el mensaje con el que empezó esa respuesta. Como mucho hace 3 de estas acciones sin preguntarte por mensaje; de la cuarta en adelante, pregunta igual. Agregar un paper sin preguntarte además exige que su identificador (el DOI, el id de arXiv o el enlace) esté en tu último mensaje tal como lo escribiste (no importan las mayúsculas de un DOI ni una barra final); un enlace o un id que Claude encontró en otra parte, por ejemplo en un paper, siempre pregunta. Editar un valor de un resumen y resolver un valor propuesto **siempre** te preguntan, aunque cites tus propias palabras: cambian algo que ya revisaste.
- **Siempre te pregunta** lo que cuesta dinero (resúmenes, sugerencias de relaciones y de facetas, llenar facetas, y agregar un paper cuando tienes activado «Resumir automáticamente al agregar»), lo que quita o borra (papelera, eliminar definitivamente), adjuntar un PDF y sincronizar con git (sincronizar ahora, resolver conflictos). Consultar el estado de la sincronización es libre.

La app solo comprueba que las palabras que cita Claude estén en algún lugar de tu último mensaje; no tienen que ser sobre esa acción. Cualquier frase tuya de unas pocas palabras puede habilitar hasta 3 acciones gratis y reversibles en ese mensaje, aunque no tengan nada que ver con lo que pediste, así que un texto que Claude lee —un paper, el resultado de una herramienta, una respuesta anterior— podría llevarlo a hacerlas sin que las pidas. La frase también puede estar dentro de una negación («no agregues una nota a Drain» contiene «agregues una nota a Drain») o de una pregunta. Agregar un paper es la excepción: sin preguntarte, además necesita su identificador en tu mensaje, porque descarga lo que ese identificador indica. Por eso existe el límite de 3 acciones por mensaje, que editar un resumen o resolver un valor propuesto siempre pregunten, y que toda acción hecha sin preguntarte se pueda deshacer.

**La pregunta** aparece dentro de la conversación: qué se hará, tus palabras (cuando las usó), por qué pregunta, los papers con su título y, si cuesta, el costo estimado, el tope por llamada, el del lote y lo gastado este mes; al eliminar definitivamente, cuántas relaciones se borran; al resolver conflictos, qué versión queda de cada archivo. Respondes con «Aprobar» o «Rechazar». Para adjuntar un PDF el botón es «Elegir PDF y adjuntar»: el archivo lo eliges tú en el diálogo de la app; Claude nunca indica una ruta de tu equipo. Si no respondes en 5 minutos, la acción se cancela. «Detener», cerrar el proyecto o apagar el interruptor correspondiente rechazan las que estén esperando.

**Lo que queda en la conversación.** Cada acción hecha, rechazada o fallida aparece entre los mensajes con lo que se hizo y por qué se permitió («lo pediste», con tus palabras, o «lo aprobaste»). Las que se pueden deshacer muestran «Deshacer»: una nota se quita si no la cambiaste después; las decisiones de relaciones, de resúmenes, de valores propuestos y de sugerencias se deshacen igual que con «Deshacer» en Revisar y en Ajustes (si nada cambió desde entonces); un paper agregado o restaurado vuelve a la papelera, y uno quitado vuelve a la biblioteca. «Deshacer» dura mientras el proyecto siga abierto en la app, para esa conversación. No tienen «Deshacer»: adjuntar un PDF, eliminar definitivamente y sincronizar con git; los trabajos con costo (resumir, sugerir relaciones o facetas, llenar facetas) se cancelan desde Actividad, no desde la conversación.

**Las mismas reglas que los botones.** Las acciones usan los mismos servicios que la interfaz: los mismos topes de gasto, las mismas validaciones y el mismo bloqueo durante la sincronización. Los trabajos lanzados desde el chat aparecen en Actividad, se lanzan como un lote (con su tope) y su costo cuenta para el tope mensual como cualquier otro; el costo de la respuesta de Claude sigue siendo el de su tope por mensaje. Las sugerencias de relaciones pedidas desde el chat se hacen aunque el paper ya se haya analizado, como el botón del paper.

**Límites.** Claude puede usar las acciones como mucho 20 veces por respuesta (además de sus 12 consultas de lectura). Desde el chat todavía no se configura la sincronización (repositorio y remoto), no se edita una sugerencia de faceta antes de aceptarla, no se fusiona un paper restaurado con otro igual ni se cambian metadatos, citas o campos del formulario: eso se hace en la interfaz. Si una respuesta falla después de hacer acciones, «Reintentar» le dice a Claude cuáles ya se hicieron para que no las repita.

**En el archivo.** Cada acción queda en `chats/<id>.md` como `## Acción — <fecha> · <herramienta> · ejecutada|rechazada|fallida · <id>` seguido de un bloque YAML con `approval` (`request` si lo pediste, `user` si lo aprobaste), `request` (tus palabras, o nada si lo aprobaste), `args` y `result`. Un «Deshacer» agrega otra acción, `undo`, que nombra la que deshizo. La ruta de un PDF adjuntado no se guarda.

## Mapeo sistemático

La vista **Mapeos** (📋 en la barra lateral) guarda los mapeos sistemáticos del proyecto. Puedes tener varios sobre la misma biblioteca: excluir un estudio de un mapeo nunca lo quita de la biblioteca, y un paper que ya está en ella no se vuelve a analizar. «Nuevo mapeo» pide un título; cada mapeo tiene cuatro pestañas.

**Protocolo.** Título, objetivo, preguntas de investigación («Copiar las preguntas de la tesis» agrega las de Ajustes → Tesis que falten), criterios de inclusión y de exclusión, y los años y tipos de publicación aceptados. Cada criterio recibe un identificador estable (`I1`, `E2`) que no se reutiliza aunque lo quites. El cribado tiene dos fases: primero título y resumen, luego texto completo. Mientras no hayas decidido nada ni pedido sugerencias a Claude, «Guardar protocolo» simplemente lo cambia (sigue en la versión 1); después, cada cambio del cuerpo crea una versión nueva (la anterior queda en «Versiones anteriores» con la fecha en que se reemplazó) y las decisiones y sugerencias tomadas con una versión anterior se marcan «Tomada con la versión N del protocolo», con la redacción que el criterio tenía entonces aunque hoy esté reescrito o ya no exista. Así, si al leer las sugerencias corriges un criterio, las sugerencias anteriores quedan marcadas y «Sugerir cribado» vuelve a ofrecer esos registros.

**Búsquedas.** Cuatro formas de traer registros, y todas quedan en el **registro de búsquedas**:

- **Buscar en OpenAlex**: escribes la cadena y eliges los años y los tipos (parten del protocolo) y el tope de resultados (500 por defecto, hasta 5000). Antes de correrla ves cuántas páginas de 100 trae como máximo y que no cuesta dinero (usa la cuota diaria de OpenAlex); solo corre si confirmas. El registro guarda la cadena exacta, los filtros, la consulta (sin tu correo de contacto ni tu clave de API), la fecha, cuántos resultados trajo y cuántos dice OpenAlex que hay en total, con un aviso si el tope dejó resultados fuera.
- **Importar una exportación**: eliges el archivo en el diálogo de la app (como para adjuntar un PDF: la app solo recibe la ruta que tú elegiste ahí), la base de datos (Scopus, IEEE Xplore, ACM Digital Library, Web of Science u otra que escribas) y la cadena que usaste en ella. El formato se detecta por la extensión o el contenido: BibTeX, RIS o CSV (como máximo 20 MB). La app dice cuántos registros leyó, cuántos eran nuevos, cuántos ya estaban, cuántos son posibles duplicados, cuántos ya están en tu biblioteca y cuántos omitió por no tener título; si el archivo traía más entradas de las que se leen de una vez, avisa que solo importó las primeras y que elijas el archivo otra vez para seguir con el resto.
- **Desde la biblioteca**: marcas papers de tu biblioteca y entran como registros vinculados a ellos; no cuesta nada ni necesita confirmación.
- **Snowballing**: desde los estudios incluidos a texto completo que son papers de tu biblioteca, hacia atrás (sus referencias en OpenAlex), hacia adelante (los trabajos que los citan) o en ambas direcciones, con un tope de 2000 trabajos por iteración. No cuesta dinero; solo corre si confirmas. Cada iteración queda en el registro con su número (las veces que ya hiciste snowballing en este mapeo, más uno) y los registros de los que partió.

Las búsquedas nunca se borran: «Descartar» pide un motivo y la marca como descartada; nunca desaparece del registro, pero los registros que solo ella trajo salen del cribado y del diagrama PRISMA. Si alguien edita `searches.yaml` a mano y deja una cuenta de resultados menor que los registros que de verdad la tienen como fuente, la búsqueda lo señala en el registro y el diagrama PRISMA avisa que sus cuentas no cuadran.

**Registros y deduplicación.** Los resultados no son papers: son registros ligeros (título, autores, año, venue, resumen, DOI, arXiv u OpenAlex). Al entrar, un registro se une solo a otro ya existente cuando comparten un identificador sin que ningún otro identificador choque entre ellos (por ejemplo, el mismo DOI, aunque uno lo tenga como URL); si no hay identificadores en conflicto, también se une solo cuando el título normalizado es igual, el año es igual y conocido, y ambos tienen autores con el mismo apellido del primero (o, sin identificadores en ninguno de los dos, cuando título, año, venue y primer autor coinciden exactamente, o cuando ninguno de los dos tiene autores: una reimportación exacta). Fuera de esos casos, la app nunca une dos registros por su cuenta: te pregunta. Quedan como **posibles duplicados** en «Cribado»: identificadores que chocan entre sí (un preprint y su versión publicada), el mismo título y año sin que el primer autor coincida o sin autores en alguno de los dos, o títulos casi iguales (similitud de palabras de al menos 0.9) con un año de diferencia como máximo. «Es el mismo» conserva el registro que ya estaba y le suma las fuentes y los datos que le falten del otro (y sus decisiones de cribado, si el otro no tenía ya una igual); «Son distintos» los separa para siempre, en ambos sentidos. Mientras no respondas, el registro recién llegado del par queda fuera de la cola de cribado y del diagrama PRISMA. Un par que la sincronización unió porque dos equipos le dieron ids distintos al mismo identificador aparece con el motivo «Mismo identificador (llegó por la sincronización)». Un registro que ya es un paper de tu biblioteca queda vinculado a él.

**Cribado.** Elige la fase y la lista («Sin decidir», «Dudosos», «Incluidos», «Excluidos», «No conseguidos», «En conflicto», «Todos») y decide registro por registro: «Incluir», «Excluir» (eligiendo el criterio de exclusión), «Dudoso» y, a texto completo, «No se pudo conseguir». Atajos (se ignoran si estás escribiendo en un campo): `I` incluir, `E` excluir (con varios criterios abre la lista y `1`–`9` elige), `D` dudoso, `N` no se pudo conseguir (texto completo), `A` aceptar la sugerencia de Claude, `U` deshacer, `→`/`←` siguiente y anterior, `Esc` cierra la lista de criterios. Tras cada decisión aparece «Deshacer» unos segundos; deshacer agrega una decisión nueva que vuelve a la anterior (nada se borra). Cada decisión guarda la fase, quién decide (`main` en esta etapa), si fue tuya o aceptaste una sugerencia, el criterio, la fecha, el equipo y la versión del protocolo con la que se tomó.

- **Sugerir cribado**: para los registros sin decidir, Claude propone incluir, excluir o dudoso, con el criterio, una justificación y una cita que la app busca en el título y el resumen (o, a texto completo, en el texto del paper) y marca si no la encuentra. Antes de correr, ves cuántos registros y llamadas son, el costo estimado, el tope por llamada, el del lote y lo gastado este mes; solo corre si confirmas. En título y resumen hace una llamada por cada 20 registros; a texto completo hace una llamada por registro, con las herramientas de solo lectura de la biblioteca. **La decisión siempre es tuya:** Claude solo sugiere, nunca decide, y «Aceptar sugerencia» toma exactamente lo que Claude propuso (decisión y criterio). No vuelve a sugerir para un registro que ya tiene una sugerencia hecha con la versión vigente del protocolo. Su costo cuenta para los topes de gasto como `screening`.
- **Agregar a la biblioteca**: los registros incluidos en título y resumen pasan a la fase de texto completo. Los que todavía no son un paper de tu biblioteca ofrecen «Agregar N a la biblioteca» (todos) o «Agregar a la biblioteca» (uno), y piden tu confirmación antes de correr; si tienes activado «Resumir automáticamente al agregar», la confirmación dice cuánto costarán los resúmenes. Se agregan con la ingesta de siempre (metadatos, BibTeX y el PDF de acceso abierto si existe); junto al registro ves el detalle del paper, con su PDF y «Adjuntar PDF» si falta, o marcas «No se pudo conseguir» si no vas a conseguirlo.
- **Conflictos**: si decidiste el mismo registro de forma distinta en dos equipos antes de sincronizar, aparece en «Decisiones distintas en dos equipos» con cada opción, su equipo y su fecha; «Quedarme con esta» la deja como la vigente.

**PRISMA.** El diagrama de flujo PRISMA 2020 se calcula del registro de búsquedas y de las decisiones vigentes y se actualiza solo: registros identificados por fuente, duplicados quitados, cribados y excluidos en título y resumen, buscados a texto completo y no conseguidos, evaluados y excluidos por criterio, e incluidos. Las búsquedas en bases de datos (OpenAlex e importaciones) van en una columna, snowballing y los papers tomados de la biblioteca en «Otros métodos»; los registros aún sin decidir se indican en cada caja, y una búsqueda descartada deja de contar. «Exportar SVG» y «Exportar PNG» lo guardan donde elijas con el diálogo de siempre.

**En los archivos.** Cada mapeo vive en `mappings/<id>/`: `protocol.yaml` (el protocolo y sus versiones), `searches.yaml` (el registro de búsquedas, que solo se agrega), `records.yaml` (los registros con sus fuentes), `decisions.yaml` (las decisiones, que solo se agregan) y `suggestions.yaml` (las sugerencias de Claude, que solo se agregan). Se sincronizan con git y la app mezcla sola lo que puede: una búsqueda, decisión o sugerencia nueva en un equipo nunca se pierde, y un registro cambiado solo en un equipo se conserva tal cual. Cuando el **protocolo** se edita en los dos equipos a la vez y las dos ediciones cambian su cuerpo de forma distinta, la app no puede mezclarlas sola: aparece como uno de los archivos en conflicto de «Sincronización», donde eliges qué versión se queda, igual que con cualquier otro archivo que no sabe mezclar; la versión que no elijas no se pierde, queda en el historial de git. Si un archivo del mapeo no se puede leer (por ejemplo, con marcadores de conflicto de git puestos a mano), el mapeo lo indica en la lista hasta que se corrija.

## Mapa

La vista **Mapa** (barra lateral) tiene tres pestañas:

- **Grafo**: un nodo por paper (más grande cuantas más citas tiene en OpenAlex) y dos tipos de aristas: citas (flecha sólida) y similitud (punteada, más gruesa cuanto más parecidos). Pasa el cursor por una arista punteada para ver sus razones; haz clic en un nodo para abrir su detalle al costado. Controles: **Lente** «Área» (color por la faceta que elijas; un paper con varios valores toma el más frecuente en la biblioteca) o «Tesis» (color por la relevancia 1–5 de la relación con la tesis; gris sin relación); mostrar u ocultar citas y similitud; «Umbral de similitud»; «Aplicar los filtros de la biblioteca» (usa los papers visibles la última vez que abriste la biblioteca); «Exportar PNG» (el grafo solo se exporta a PNG). Las relaciones tipadas se dibujan con un color por tipo: sólidas las confirmadas, punteadas las sugeridas, con flecha salvo en los tipos sin dirección. La fila «Relaciones:» tiene un interruptor por tipo y «Ocultar sugeridas»; al pasar el cursor por una relación se ve su tipo.
- **Gráficas**: «Barras por valor», «Burbujas faceta × faceta» (las celdas vacías se ven como huecos) y «Papers por año». Con «Solo revisadas» apagado cuentan todas las facetas y lo no revisado se dibuja más tenue; encendido, solo las verificadas o editadas. Las entradas que ya no encajan con el tipo actual de su faceta no cuentan. Un clic en una barra o burbuja abre la biblioteca filtrada. Se exportan a SVG, PNG y CSV.
- **Candidatos**: ver «Citas y candidatos».

## Ajustes

Los ajustes se organizan en pestañas, navegables con ←/→/Inicio/Fin; la app recuerda la última pestaña abierta. La mayoría de los campos se guardan solos al salir de ellos (de inmediato en selectores y casillas) y muestran «Guardado»; el editor del formulario de extracción es la excepción — ahí los cambios quedan pendientes hasta tocar «Guardar cambios» (ver «Formulario» abajo).

Valores por defecto de un proyecto nuevo: idioma del contenido generado en inglés; PDFs «Versionarlos con git»; modelo Sonnet; resumir automáticamente desactivado; sugerir relaciones automáticamente desactivado; tope por paper 0,5 USD; tope por lote 10 USD; tope mensual vacío (sin tope); tamaño máximo de entrada 400000 caracteres.

### Proyecto

- **Nombre**: el nombre del proyecto, visible en la app.
- **Carpeta**: la ruta de la carpeta del proyecto (solo lectura).
- **Idioma del contenido generado**: inglés o español. Lo usan los resúmenes y, en etapas siguientes, otras respuestas generadas. Cambiarlo no desactualiza los resúmenes existentes (siguen en el idioma con el que se generaron); se aplica a los resúmenes nuevos.
- **PDFs**: cómo se guardan los PDFs nuevos — versionarlos con git, versionarlos con git LFS, guardarlos fuera de git (para sincronizarlos aparte, p. ej. con Syncthing) o no guardarlos y descargarlos al abrirlos (solo para papers de acceso abierto). Cambiar esta opción no mueve los PDFs ya guardados, solo afecta a los nuevos. Con «Guardarlos fuera de git», la app se encarga de añadir `papers/*/paper.pdf` a `.gitignore`; con «Versionarlos con git LFS», se encarga del `.gitattributes` correspondiente — no hace falta tocar ninguno de los dos a mano.

### Claude

- **Modelo**: Sonnet (recomendado), Haiku (más rápido, menor calidad) u Opus (máxima calidad, consume más cuota). Es el modelo por defecto para resumir; se puede elegir otro puntualmente con «Regenerar con…» o al confirmar un lote.
- **Resumir automáticamente al agregar papers**: si está activo, al terminar un trabajo de agregar, fusionar o completar metadatos, cada paper que quede con texto indexado, sin resumen (o con uno desactualizado o fallido) y con el formulario válido se encola para resumirse solo; los papers demasiado largos para el tamaño máximo de entrada no se resumen solos (hace falta «Forzar» a mano).
- **Sugerir relaciones automáticamente**: si está activo (por defecto no), cuando un paper ya tiene resumen y citas, y sus candidatos cambiaron desde su último análisis, se encola sola una sugerencia de relaciones tipadas. Consume cuota de Claude.
- **Sugerir facetas automáticamente**: si está activo (por defecto no), cuando se resumieron tantos papers nuevos como indica **Papers resumidos nuevos para sugerir** (10 por defecto) desde la última sugerencia de facetas, se encola sola una («Sugerir facetas (automático)» en Actividad), como mucho una vez al día; si falla, lo vuelve a intentar al día siguiente. Nunca acepta nada: deja las sugerencias para revisar en Ajustes → Formulario. Consume cuota de Claude.
- **Tope por paper (USD est.)**: el máximo estimado que puede costar un solo resumen. No puede quedar vacío ni ser 0 o negativo. Se aplica por cada llamada a Claude (como `--max-budget-usd`); un resumen puede hacer hasta dos intentos de llamada, llenar las facetas nuevas de un paper («Llenar facetas nuevas») también hasta dos, y una sugerencia de relaciones, uno.
- **Tope por lote (USD est.)**: el máximo estimado acumulado dentro de una misma operación por lotes (resumir pendientes o regenerar filtrados). Al alcanzarlo, los trabajos de ese lote que todavía estaban en cola se cancelan. No puede quedar vacío ni ser 0 o negativo.
- **Tope por sugerencia de facetas (USD est.)**: el máximo estimado de una ejecución de «Sugerir facetas» (2 por defecto), que lee toda la biblioteca y por eso tiene su propio tope en vez del tope por paper. Cuenta también para el tope mensual; las automáticas de cada día comparten además el tope por lote con las sugerencias de relaciones automáticas.
- **Tope por mensaje de chat (USD est.)**: el máximo estimado de cada respuesta del chat (0,5 por defecto). Cuenta también para el tope mensual.
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

**Qué desactualiza los resúmenes y qué no**: quitar una faceta, o cambiar la clave, el tipo o la descripción de una faceta que un paper ya tiene, o — en una escala — el mínimo o el máximo, desactualiza ese resumen. Agregar una faceta no desactualiza nada: en los papers ya resumidos queda «Faceta nueva sin llenar» y se llena aparte (ver «Facetas sugeridas por Claude»); los papers que resumas después la reciben con su resumen. La excepción es una clave que los papers todavía guardan de una faceta anterior que quitaste (sus valores siguen en los archivos): volver a agregar una faceta con esa misma clave desactualiza esos papers. Agregar o quitar un *valor* permitido, o editar los alias, tampoco desactualiza. Reordenar las facetas (a mano, editando el YAML) sí cambia el hash que determina si un resumen está desactualizado.

Al guardar cambios, la app muestra primero el impacto (cuántos resúmenes quedarán desactualizados, y si algún valor que vas a quitar sigue en uso en algún paper — ese valor se conserva en esos papers aunque lo quites de la lista) antes de pedir confirmación.

**Quitar y recrear una faceta**: lo ya extraído para esa faceta se conserva en los archivos de cada paper aunque la quites del formulario, y vuelve a aparecer si recreas una faceta con la misma clave (aunque con otro tipo, lo guardado que no coincida con el tipo nuevo se trata como ausente). Quitar la faceta también quita sus alias aprendidos.

**Restaurar formulario por defecto** vuelve a dejar el formulario como la tabla de arriba y borra todos los alias aprendidos; lo ya extraído se conserva igual en los archivos. A diferencia de guardar cambios en una faceta, esta acción no muestra una vista previa del impacto antes de confirmar, y puede dejar resúmenes desactualizados.

Si el formulario cambió por fuera de este editor (otro equipo, un `git pull`) mientras tenías cambios propios sin guardar, aparece un aviso para descartar los tuyos y recargar.

Debajo del editor está la sección «Sugerencias de Claude» (ver «Facetas sugeridas por Claude»); la pestaña se llama «Formulario (N)» cuando hay N sugerencias por revisar.

### Aplicación

- **Correo de contacto para Crossref y OpenAlex**: opcional. Crossref atiende con prioridad las consultas que lo incluyen (OpenAlex ya no lo usa). Solo se envía a esos servicios. Es un ajuste de la app por dispositivo, no se guarda en `project.yaml` y por lo tanto no se sincroniza entre equipos.
- **Clave de API de OpenAlex**: opcional y gratuita. Sin clave, OpenAlex permite unas 1000 consultas al día; con ella, más. Se guarda solo en este equipo y solo se envía a OpenAlex.
- **Modelos locales**: el modelo de similitud de contenido (multilingual-e5-small, unos 470 MB) corre en tu equipo. Muestra si está descargado y cuánto ocupa, con «Descargar» (el avance se ve en Actividad) y «Borrar». Se guarda en la carpeta de datos de la app, nunca en el proyecto, así que cada equipo lo descarga una vez. La descarga corre como un trabajo del proyecto abierto (hace falta tener uno abierto); si cierras el proyecto o la app a mitad de camino, se retoma la próxima vez que abras ese proyecto. «Borrar» cancela los cálculos de similitud que estaban en cola.
- **Sincronizar automáticamente** y **Cada (minutos)**: la sincronización automática con git (ver «Sincronizar con git»), al abrir el proyecto y cada 5 a 120 minutos (10 por defecto). Es un ajuste de este equipo; no se guarda en `project.yaml`.
- **Cerrar proyecto**: vuelve a la pantalla de bienvenida para crear o abrir otro proyecto.

## Archivos del proyecto

```
project.yaml               configuración del proyecto (nombre, idioma, política de PDFs, Claude, tesis, formulario de extracción, candidatos descartados)
relations.yaml             relaciones tipadas entre papers (sugeridas, confirmadas y rechazadas)
facet-suggestions.yaml     facetas, valores y alias que Claude sugirió para el formulario, con su estado
chats/<id>.md              conversaciones con Claude, una por archivo
mappings/<id>/             un mapeo sistemático
  protocol.yaml            protocolo y sus versiones anteriores
  searches.yaml            registro de búsquedas (solo se agregan)
  records.yaml             registros deduplicados con sus fuentes
  decisions.yaml           decisiones de cribado (solo se agregan)
  suggestions.yaml         sugerencias de cribado de Claude (solo se agregan)
papers/<clave>/            un paper por carpeta; <clave> es su clave de cita y nunca cambia
  paper.yaml               metadatos, BibTeX y citas (OpenAlex)
  summary.md               campos del resumen, con evidencia y estado por campo
  extraction.yaml          clasificación según el formulario, y relación con la tesis
  notes.md                 tus notas
  content.md               texto legible (literatura gris, páginas sin PDF)
  paper.pdf                el PDF, según la política configurada
.trash/<clave>/            un paper quitado de la biblioteca, con todos sus archivos
  trashed.yaml             cuándo y en qué equipo se quitó
costs/<dispositivo>.jsonl  costos estimados de cada llamada a Claude, uno por dispositivo (para que sincronizar entre equipos nunca choque)
exports/library.bib        BibTeX de toda la biblioteca; generado, no lo edites
.cache/                    índice local de búsqueda, PDFs descargados bajo demanda, citas entrantes, datos de candidatos, vectores, el índice de relaciones, el de la papelera y el de los mapeos; se puede borrar sin perder nada, se reconstruye solo
```

Todo lo de arriba, salvo `.cache/`, está pensado para versionarse con git o sincronizarse entre equipos. `notes.md`, las conversaciones de `chats/` y `project.yaml` (fuera de `extraction_form`) se pueden editar a mano con confianza; `paper.yaml`, `summary.md` y `extraction.yaml` también, pero con cuidado de no romper su formato. Un archivo editado por fuera de la app (o actualizado por una sincronización) se recarga solo, sin reiniciar la app. La sincronización de la app hace commit solo de esta carpeta (sin `.cache/`) y deja sus archivos temporales en `.git/`.

## Problemas comunes / FAQ

**«No se pudo usar Claude: revisa que la CLI `claude` esté instalada y con sesión iniciada.»**
Instala la CLI `claude` y ejecuta `claude login` en una terminal.

**«Se alcanzó el presupuesto configurado.»**
Se llegó al tope por lote o al mensual configurado en Ajustes → Claude, así que la app no hizo la llamada. Sube el tope correspondiente (o deja el mensual vacío para quitarlo) y reintenta. Si un solo paper llega a su tope por paper, el mensaje es otro: «La operación llegó a su tope por paper y se detuvo…» (ver más abajo).

**«Se agotó la cuota de tu suscripción de Claude. Intenta más tarde.»**
Es un límite de la cuenta de Claude, no de esta app; espera a que se renueve la cuota.

**«Claude devolvió una respuesta inválida. Vuelve a intentarlo o prueba con otro modelo.»**
Claude no devolvió una respuesta que la app pudiera interpretar (un resumen lo intenta dos veces; una sugerencia de relaciones, una). Reintenta más tarde o con otro modelo; si persiste, puede ser un problema de la CLI `claude`.

**«Claude tardó demasiado y se canceló.»**
Cada llamada a Claude tiene un límite de 5 minutos (10 para sugerir relaciones); si lo supera, se cancela sola y se registra su costo como el tope por paper (estimado). Reintenta.

**«No se pudo mover ese paper: su carpeta en la papelera está dañada…»**
La carpeta en `.trash/` no tiene `paper.yaml` o ya existe una con esa clave. Revísala a mano en la carpeta `.trash` del proyecto (o recupérala del historial de git).

**«Otro programa tiene abierto un archivo de ese paper (por ejemplo, su PDF). Ciérralo y vuelve a intentarlo.»**
Pasa sobre todo en Windows, que no deja mover una carpeta con un archivo abierto. Cierra el visor o el editor y repite la acción.

**«Ese paper ya no está en la papelera (quizás ya se restauró).»**
«Deshacer» o «Restaurar» llegaron tarde: el paper ya volvió a la biblioteca (desde aquí o desde otro equipo).

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

**«No se pudieron preparar las herramientas de búsqueda de la biblioteca para Claude. Reintenta; si sigue fallando, reinicia la app.»**
La app no pudo abrir en tu equipo el servidor local (solo en `127.0.0.1`) con el que Claude lee tu biblioteca. No se gastó nada. Reintenta; si persiste, reinicia la app.

**«relations.yaml tiene un conflicto de git o un error; resuélvelo antes de cambiar relaciones.»**
Usa «Resolver automáticamente» en el aviso de abajo de la ventana (ver «Relaciones tipadas»), o corrige el archivo a mano.

**«La operación llegó a su tope por paper y se detuvo. Sube «Tope por paper (USD est.)» en Ajustes → Claude o reintenta con otro modelo.»**
Ese paper superó el tope por paper durante la consulta. Solo falla ese paper: un lote en curso sigue con los demás.

**«Hay conflictos en archivos fuera de la carpeta del proyecto: …»**
El proyecto está dentro de un repositorio mayor y el otro equipo cambió los mismos archivos de fuera que tú. La app no los toca: resuélvelos con git (`git pull`) y vuelve a sincronizar. Tus cambios del proyecto ya quedaron en un commit local.

**«Hay cambios locales sin commit que la sincronización sobrescribiría: …»**
El otro equipo cambió archivos que aquí tienes modificados sin commit (fuera de la carpeta del proyecto, o ignorados por git, como un PDF). Haz commit o muévelos con git y vuelve a sincronizar.

**«Hay un merge o un rebase hecho a mano sin terminar…»**
Tienes un merge o un rebase de git a medio terminar en este repositorio. Termínalo o cancélalo con git (`git merge --abort` o `git rebase --abort`) y vuelve a sincronizar.

**«El remoto rechazó tus credenciales o no tienes permiso…»**
git no pudo autenticarse. Revisa que tu clave SSH esté cargada (`ssh-add`) o que el gestor de credenciales de git tenga tu usuario; prueba un `git fetch` en una terminal. La app nunca pide contraseñas.

**«No se pudo conectar con el remoto…»**
Sin red o el servidor no responde. Tus cambios quedan en un commit local («Cambios sin subir») y la sincronización automática lo vuelve a intentar sola.

**«git tardó demasiado y se canceló…»**
Al subir o bajar, git se cancela solo si pasan 3 minutos sin ningún avance (no por tardar: la primera sincronización de una biblioteca grande con sus PDF puede llevar mucho rato y sigue mientras avanza). Suele ser una conexión que se cortó a medias: revísala y vuelve a sincronizar.

**«Este proyecto guarda los PDF con git LFS y git-lfs no está instalado…»**
Instala git-lfs (https://git-lfs.com), o cambia la política de PDFs en Ajustes → Proyecto.

**«No se pudieron subir los PDF a git LFS…»**
Los commits se quedan sin subir hasta que sus PDF estén en el remoto. Revisa que el remoto acepte git LFS (algunos servidores lo tienen desactivado) y que este equipo tenga los PDF: `git lfs push origin <rama>` en una terminal te dice cuál falta.

**«git no sabe tu nombre ni tu correo…»**
Configúralos una vez en una terminal: `git config --global user.name "Tu nombre"` y `git config --global user.email "tu@correo"`.

**«El remoto tiene una historia distinta de la de este repositorio…»**
Inicializaste un repositorio aquí y el remoto ya tenía otro proyecto. Clona el remoto en otra carpeta y abre esa carpeta como proyecto.
