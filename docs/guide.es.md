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
- **Escribir** con la biblioteca en la vista «Redacción»: un `.bib` solo con las entradas que cita un capítulo (siguiendo lo que incluye), una revisión de las citas de un texto pegado (claves desconocidas, papers en la papelera o sin texto, y con Claude si cada paper citado respalda su oración), borradores de una sección que Claude escribe a partir de los papers que elijas, con cada cita verificada contra el texto del paper, un esquema del estado del arte agrupado por facetas con sus huecos, la redacción del esquema propuesta por Claude con citas verificadas y sugerencias de estilo de Claude que nunca tocan citas ni matemáticas, para Org, LaTeX o Markdown.

Próximamente (no implementado todavía): segundo revisor y evaluación de calidad en los mapeos, y el reporte de los mapeos (tablas, gráficas y exportaciones).

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
- **Abrir una URL en el navegador de la app** con «Abrir en navegador», junto a «Agregar»; ver «Sitios que bloquean las descargas» más abajo.

La app completa los metadatos automáticamente a partir del identificador. Si el paper queda con «Los metadatos están incompletos.», puedes pegar un DOI o ID de arXiv en el aviso y tocar «Completar», o tocar «Reintentar» si ya tenía uno.

Al agregar un paper (o completar sus metadatos), la app consulta en segundo plano sus referencias en OpenAlex (ver «Citas y candidatos»); no consume cuota de Claude.

Agregar un identificador o PDF que ya está en la biblioteca actualiza el paper existente en vez de duplicarlo («ya estaba en la biblioteca» / «actualizado» en el panel de actividad). Un PDF que sueltas en la biblioteca se asocia por el DOI o el ID de arXiv impreso en él, o por su título: si no coincide con ninguno, se crea un paper nuevo, y si el paper ya tiene PDF, el que soltaste se ignora. Para darle su PDF a un paper concreto, usa su pestaña PDF (ver «Adjuntar o reemplazar un PDF» más abajo).

### Sitios que bloquean las descargas

Algunos sitios (muchos blogs y revistas detrás de Cloudflare u otra protección contra bots, páginas que piden iniciar sesión, páginas que arman todo con scripts) rechazan las descargas de la app. «Agregar» falla entonces con «El sitio bloquea las descargas automáticas (HTTP 403)…», nunca con el aviso de la clave de API de OpenAlex, que solo aparece cuando quien rechaza es OpenAlex. La app nunca intenta saltarse la protección de un sitio; en cambio:

- **El navegador de la app.** En el panel de actividad, la entrada fallida tiene «Abrir en el navegador de la app»; con cualquier URL también puedes escribirla junto a «Agregar» y tocar «Abrir en navegador». Se abre una ventana con la página y una barra (atrás, adelante, recargar, el título y la dirección de la página). Navégala como en cualquier navegador: si el sitio muestra una verificación («Verifica que eres humano»), resuélvela tú; inicia sesión si hace falta. Cuando la página muestre el artículo, toca «Agregar a la biblioteca». La app lee la página tal como está en ese momento y hace su PDF (ver abajo): si la página nombra un DOI o un ID de arXiv, el paper se agrega por ese identificador con el PDF impreso; si no, queda como página web con su texto legible (pestaña Contenido) y el PDF impreso (pestañas PDF y Texto, búsqueda). Si no se puede extraer un artículo, el paper queda con el título de la propia página (o uno deducido de su URL) y «Los metadatos están incompletos.»: complétalos con «Editar metadatos». «Cancelar» cierra la ventana sin agregar nada.
  **El PDF.** El menú de la barra elige cómo se hace, y la app recuerda tu elección:
  - «PDF: vista de lectura (recomendado)» (la opción por defecto): un documento limpio hecho con el artículo que la app encuentra en la página, con un encabezado (sitio, título, autores, fecha, la dirección de la página y el día en que la capturaste) y el texto del artículo, sus títulos, listas, código, tablas, citas y figuras con sus pies; letra con serifa y número de página al pie. Sin avisos de cookies, anuncios, menús ni comentarios. Sus imágenes se descargan por la misma sesión del navegador (así cargan como las viste) y quedan dentro del PDF; una imagen que no se puede descargar se omite. La búsqueda, la pestaña «Texto» y la evidencia de los resúmenes usan el texto de este PDF, así que las citas y las páginas coinciden con lo que lees.
  - «PDF: página tal como se ve»: la página impresa tal cual, ocultando antes los avisos de consentimiento de cookies (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc, Usercentrics, Sourcepoint, Osano, Termly, Complianz, CookieYes y banners parecidos, y el fondo oscuro detrás de ellos) y devolviendo el desplazamiento a la página. La app solo los oculta mientras imprime: nunca acepta ni rechaza nada en el sitio. Los anuncios y menús se quedan, como en pantalla.
  Si la app no encuentra un artículo en la página (un muro de inicio de sesión, una página hecha solo con scripts), imprime la página tal como se ve, sea cual sea la opción elegida.
  **Avisos de cookies.** Si el sitio muestra un aviso de cookies, la barra te recuerda que lo más privado es rechazar las no esenciales. El PDF en vista de lectura no depende de ese aviso: nunca forma parte del artículo.
  **«Vista de lectura».** El botón de la barra muestra, en lugar de la página, exactamente lo que tendrá el PDF en vista de lectura: el mismo documento limpio, hecho igual (el mismo encabezado, texto e imágenes incrustadas), para que lo revises antes de agregar. «Ver página» vuelve a la página, que sigue como la dejaste. La vista de lectura sigue a la página: si navega o se recarga, se vuelve a armar. Si la página no tiene un artículo que leer, se queda la página y la barra dice «Esta página no tiene un artículo legible; se guardará la página tal como se ve.». Con «PDF: página tal como se ve» el botón está desactivado (ese PDF es la página misma). La vista de lectura corre sin JavaScript y no carga nada de la web.
  **Una página que ya está en la biblioteca.** Si la página ya está en la biblioteca (la misma dirección, sin contar `http`/`https`, `www.`, un `#sección`, parámetros de seguimiento como `utm_…` ni una `/` final), la barra lo dice en cuanto carga la página: «Ya está en la biblioteca como <clave>», y el botón principal pasa a ser «Actualizar PDF de <clave>». Reemplaza el PDF de ese paper, igual que «Reemplazar PDF…»: la clave, los metadatos, los resúmenes y las notas se mantienen, y se indexa el texto nuevo. No hay «agregar como nuevo»: la biblioteca guarda un paper por dirección. (Si tocas el botón antes de que termine la comprobación y la página resulta estar en la biblioteca, la barra pregunta «Esta página ya está en la biblioteca como <clave>. ¿Actualizar su PDF?»; «No» vuelve a la página sin cambiar nada.)
  **«Volver a capturar desde la web».** Para arreglar el PDF de un paper que ya tienes (capturado con un banner encima del texto, o con la portada en lugar del artículo), abre el paper y usa «Volver a capturar desde la web» en su pestaña PDF (o en la pestaña Contenido de una página web). Aparece en todo paper con dirección: su URL o, si no tiene, su DOI (se abre en doi.org, que te lleva a la editorial). El navegador de la app se abre ahí, ligado a ese paper: la barra muestra «Recaptura: <clave>» y el botón principal es «Actualizar PDF de <clave>», que reemplaza directamente el PDF de ese paper (los resúmenes y las notas se mantienen). Si navegas a otro sitio que el del paper (el de su dirección, o el de la editorial a la que llevó el DOI; los subdominios cuentan como el mismo sitio), la barra pregunta antes: «Estás en otra página; ¿actualizar igual el PDF de <clave>?». Abrir cualquier otra dirección en el navegador de la app desliga la ventana.
  La ventana está separada de la app: la página corre aislada, sin acceso a tus archivos ni a la app, se niega todo permiso (cámara, micrófono, notificaciones, ubicación…) y las descargas están bloqueadas (descarga un archivo de ese sitio desde tu propio navegador). Las cookies y sesiones iniciadas ahí se conservan entre usos en una sesión propia, separada de la de la app.
- **Imprimir a PDF desde tu navegador.** Abre la página en tu navegador, usa Ctrl+P → «Guardar como PDF» y suelta el archivo en la biblioteca (un paper nuevo, con el título del PDF) o en la pestaña PDF o Contenido de un paper (ver más abajo).

### Editar metadatos

«Editar metadatos», bajo el título del paper en su detalle, abre un formulario con el título, los autores (uno por línea, «Apellido, Nombre»; una organización tal cual), el año (en una página web, su fecha como `AAAA`, `AAAA-MM` o `AAAA-MM-DD`, que fija el año), la revista o evento (en una página web, su sitio) y la URL. «Guardar» escribe `paper.yaml` y los mismos campos en la entrada BibTeX del paper, conservando todos los demás (páginas, volumen, editorial…), y actualiza `exports/library.bib`. La clave de cita nunca cambia. Justo después de guardar, «Deshacer» devuelve lo que cambió la edición, siempre que `paper.yaml` no haya cambiado desde entonces. Completar título, autores y año marca los metadatos como completos.

### Adjuntar o reemplazar un PDF

Para agregar el PDF de un paper que ya está en la biblioteca (por ejemplo, uno agregado por DOI sin PDF de acceso abierto), abre el paper y, en su pestaña **PDF**, toca «Adjuntar PDF…» para elegir el archivo, o suéltalo sobre la pestaña. En una página web sin PDF, el botón «Adjuntar PDF…» está arriba en la pestaña **Contenido**, que también acepta el archivo soltado. Se acepta un solo archivo `.pdf` a la vez, de hasta 200 MB. Un PDF soltado sobre una pestaña PDF o Contenido abierta se adjunta a ese paper en vez de agregarse como paper nuevo. Un PDF adjuntado siempre se guarda en la carpeta del paper (`papers/<clave>/paper.pdf`, versionado o ignorado por git según la política de PDFs), incluso con «No guardarlos: descargarlos al abrirlos», porque no se puede volver a descargar; la copia descargada antes en `.cache/` se borra.

Cuando el paper ya tiene PDF, la pestaña PDF tiene arriba un botón «Reemplazar PDF…» (también puedes soltar el archivo ahí); a su lado, «Volver a capturar desde la web» toma en cambio un PDF nuevo de la página del paper (ver «Sitios que bloquean las descargas»). Antes de reemplazarlo, la app pregunta: «Se reemplaza el PDF y se vuelve a extraer el texto. Los resúmenes no cambian.».

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
- **Cómo mezcla**: nunca reescribe la historia (mezcla, no rebase: los commits del otro equipo quedan tal cual) y nunca deja marcadores de conflicto en tus archivos, porque calcula la mezcla aparte y solo cambia los archivos cuando el resultado está completo. Mezcla sola `relations.yaml` (une por `id`; si una relación cambió en ambos equipos gana el cambio más reciente, y una que se borró en un equipo sin tocarse en el otro queda borrada), `facet-suggestions.yaml` (igual, por `id`: una sugerencia que cambió en un solo equipo toma la versión de ese equipo, y si cambió en ambos gana el cambio más reciente), los registros de gasto `costs/` (une las líneas), las conversaciones de `chats/` (si en un equipo solo se agregaron mensajes, o se renombró o archivó la conversación, se mezclan; si los dos equipos siguieron la misma conversación, se conservan las dos: la del otro equipo aparece como «(copia de <equipo>)»), los borradores de `drafts/` (igual: una versión nueva o un cambio de nombre en un equipo se mezcla; el mismo borrador cambiado en los dos se conserva dos veces, como «(copia de <equipo>)»), `project.yaml` clave por clave (los candidatos descartados se suman), el `trashed.yaml` de un paper quitado en ambos equipos (gana la fecha más reciente) y `exports/library.bib` (la app la vuelve a generar). Un archivo que agregaste y que git reubicó por una carpeta renombrada en el otro equipo no se pierde ni se pregunta: queda junto al original como `<nombre>.conflict` (o `.conflict-2`, etc., si ya existe uno).
- **Conflictos**: si un archivo cambió en ambos equipos y la app no sabe mezclarlo (un `summary.md`, `extraction.yaml`, `paper.yaml` o `notes.md`, o la misma clave de `project.yaml`), la sincronización se detiene sin tocar tus archivos y la vista Sincronización muestra «Conflictos por resolver»: cada archivo con el paper al que pertenece, qué hizo cada equipo, «Ver diferencias» (las dos versiones lado a lado) y «Quedarme con la mía» / «Usar la del otro equipo». Si un equipo quitó un paper a la papelera mientras el otro lo editaba, eliges «Conservar el paper» (vuelve a la biblioteca con las ediciones y sale de la papelera) o «Aceptar que se quitó» (se queda en la papelera, con las ediciones que git pudo llevar ahí). Nada se sube hasta que elijas en todos («Terminar sincronización» se activa recién entonces); «Cancelar» deja todo como estaba (tus cambios quedan en un commit local, sin subir). Si algo cambia mientras decides (se guarda algo nuevo aquí o el otro equipo sube cambios), la app te lo vuelve a preguntar antes de seguir. La versión que no elijas no se pierde: queda en el historial de git.
- **Fuera de la carpeta del proyecto**: si el proyecto vive dentro de un repositorio mayor y el otro equipo cambió los mismos archivos de fuera, o si tienes un merge o un rebase hecho a mano sin terminar, la sincronización se detiene sin tocar nada; resuélvelo con git y vuelve a sincronizar.
- **Automática**: «Sincronizar automáticamente» (Ajustes → Aplicación, encendida por defecto) sincroniza al abrir el proyecto y cada 10 minutos (o el intervalo que elijas, de 5 a 120) si el repositorio tiene remoto. Se salta un intervalo si hay conflictos esperando tu decisión o si en ese momento se están moviendo papers a o desde la papelera, y nunca abre ventanas: si falla (sin red, credenciales), solo lo muestra la barra lateral y lo vuelve a intentar en el siguiente intervalo.
- **Al cerrar**: si quedan cambios sin commit en el proyecto, commits sin subir o decisiones pendientes, la app pregunta «Sincronizar y cerrar», «Cerrar sin sincronizar» o «Cancelar». La ventana se cierra solo si esa sincronización termina bien; si encuentra conflictos o falla, se queda abierta y puedes ir a «Ver sincronización». Si en ese momento corría una sincronización automática, la espera y vuelve a sincronizar, para que se suba también lo último que guardaste. Mientras sincroniza puedes elegir «Cerrar sin sincronizar»: la subida se detiene y lo que no alcanzó a subirse queda en tu equipo para la próxima vez.
- **Primer uso**: si la carpeta no está en un repositorio, la vista Sincronización ofrece «Inicializar repositorio» (`git init` en la carpeta del proyecto, en la rama `main`, con el `.gitignore` que la app ya mantiene) y un campo para la URL de un repositorio remoto vacío (en GitHub, GitLab o una carpeta compartida); una URL con contraseña se rechaza. Con la URL, al terminar sube el proyecto. Si el repositorio no tiene remoto, la misma URL con «Agregar remoto y sincronizar»; si la rama no sigue a ninguna rama remota, «Conectar y sincronizar» la conecta con la rama del mismo nombre (o la publica si no existe). Esa URL solo se puede corregir mientras ese remoto nunca llegó a funcionar (no se usó para sincronizar todavía); una vez que funcionó, para cambiarla hay que usar `git remote set-url origin <url>` a mano. Si el remoto tiene una historia distinta de la de este repositorio, la app lo rechaza (ver «Problemas comunes» más abajo). Para un segundo equipo, clona el repositorio con git y abre esa carpeta como proyecto.
- **PDFs con git LFS**: con la política «Versionarlos con git LFS» hace falta tener git-lfs instalado; si falta, la sincronización lo avisa. La app prepara git-lfs en el repositorio y sube los PDF antes que los commits que apuntan a ellos, así que funciona aunque tengas desactivados los hooks de git (`core.hooksPath`); si la subida falla, no se sube nada.

## Detalle del paper

![Detalle del paper en la pestaña PDF](images/paper-pdf.png)

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

![Biblioteca con el resumen de un paper: cada campo con su cita, página y estado de revisión](images/library-summary.png)

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

![Relación tipada sugerida por Claude, con citas de los dos papers](images/paper-relations.png)

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

![Chat sobre un paper, con citas verificadas](images/chat.png)

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

- **Buscar en OpenAlex**: escribes la cadena y eliges los años y los tipos (parten del protocolo) y el tope de resultados (500 por defecto, hasta 5000). Al tocar «Buscar», la app primero le pregunta a OpenAlex cuántos resultados tiene la búsqueda (una consulta con la misma cadena y los mismos filtros; gratis, sin Claude) mientras el botón dice «Consultando el total en OpenAlex…»; «Cancelar» deja de esperarlo. La confirmación dice entonces «OpenAlex tiene N resultados; se traerán M» y que no cuesta dinero (usa la cuota diaria de OpenAlex); solo corre si confirmas. Si N supera tu tope y no pasa de 5000, «Subir el tope a N» ajusta el tope y deja la confirmación abierta; por encima de 5000 avisa que ninguna búsqueda trae tantos y sugiere afinar la cadena. Si el total no se puede consultar (sin red, OpenAlex la rechaza), la confirmación dice «No se pudo consultar el total» con el motivo, y puedes buscar igual. Cualquier cambio en el formulario descarta el total y la confirmación. Busca en el título y el resumen de cada trabajo con la búsqueda exacta (sin raíces) de OpenAlex, así que la cadena admite AND, OR, NOT, paréntesis, frases entre comillas y comodines (`anonymi*`); no puede llevar comas ni `|`, que OpenAlex usa para separar filtros (usa OR en su lugar), ni empezar con `!`, que OpenAlex lee como negación de todo el filtro (usa NOT dentro de la cadena). Los comodines (`*`, `?`) no funcionan dentro de una frase entre comillas: el formulario nombra la frase (por ejemplo `"log file*"`) y no busca hasta que escribas cada forma por separado (`"log file" OR "log files"`). El registro guarda la cadena exacta, el campo buscado (título y resumen), los filtros, la consulta (sin tu correo de contacto ni tu clave de API), la fecha, cuántos resultados trajo y cuántos dice OpenAlex que hay en total, con un aviso si el tope dejó resultados fuera.
- **Importar una exportación**: eliges el archivo en el diálogo de la app (como para adjuntar un PDF: la app solo recibe la ruta que tú elegiste ahí), la base de datos (Scopus, IEEE Xplore, ACM Digital Library, Web of Science u otra que escribas) y la cadena que usaste en ella. El formato se detecta por la extensión o el contenido: BibTeX, RIS o CSV (como máximo 20 MB). La app dice cuántos registros leyó, cuántos eran nuevos, cuántos ya estaban, cuántos son posibles duplicados, cuántos ya están en tu biblioteca y cuántos omitió por no tener título; si el archivo traía más entradas de las que se leen de un archivo, avisa que solo importó las primeras: divide la exportación en archivos más pequeños (por ejemplo, por rango de años) e importa los que faltan. Volver a elegir el mismo archivo no sirve, porque lee otra vez las mismas primeras entradas.
- **Desde la biblioteca**: marcas papers de tu biblioteca y entran como registros vinculados a ellos; no cuesta nada ni necesita confirmación.
- **Snowballing**: desde los estudios incluidos a texto completo que son papers de tu biblioteca, hacia atrás (sus referencias en OpenAlex), hacia adelante (los trabajos que los citan) o en ambas direcciones, con un tope de 2000 trabajos por iteración. No cuesta dinero; solo corre si confirmas. Cada iteración queda en el registro con su número (las veces que ya hiciste snowballing en este mapeo, más uno) y los registros de los que partió.

![Pestaña Búsquedas: formulario de OpenAlex, importación, biblioteca y snowballing](images/mapping-searches.png)

**Las cifras del registro.** Cada búsqueda muestra hasta tres cifras, por ejemplo «791 recibidos · OpenAlex informa 787 · 782 registros distintos»: las filas que llegaron («leídos» en una importación o desde la biblioteca), el total que informó OpenAlex (solo en búsquedas de OpenAlex; en el snowballing, los trabajos encontrados) y los registros distintos que el mapeo tiene hoy de esa búsqueda. Pueden diferir: el total de OpenAlex es aproximado, y al paginar los resultados puede repetirse un trabajo, que se junta con el registro que ya estaba; los registros que luego unes con «Es el mismo» también dejan de contar. Al pasar el puntero sobre las cifras se explica.

**Completar búsqueda**: una búsqueda de OpenAlex que el tope dejó corta tiene este botón. Tras una confirmación breve, vuelve a correr la misma cadena con los mismos filtros y el mismo campo, con el tope en 5000. Cuando esa búsqueda termina y trae todos los registros que tenía la anterior, la reemplaza: la anterior queda descartada y muestra «Completada con la búsqueda del <fecha>», los registros que ya tenías conservan sus decisiones (solo suman la búsqueda nueva como fuente) y PRISMA cuenta solo la búsqueda nueva. Si algunos registros de la anterior no volvieron (el índice de OpenAlex cambió entre tanto), descartarla los sacaría del cribado, así que las dos quedan vigentes: Actividad dice cuántos registros no volvieron y cuántos de ellos tenían decisiones, y la anterior muestra que ya se completó y deja de ofrecer «Completar búsqueda». Si la búsqueda nueva falla, la anterior queda como estaba. Mientras una compleción está en cola o en curso, el botón espera. Si OpenAlex informó más de 5000 resultados, el botón queda desactivado: afina la cadena en su lugar.

Las búsquedas nunca se borran: «Descartar» pide un motivo y la marca como descartada; nunca desaparece del registro, pero los registros que solo ella trajo salen del cribado y del diagrama PRISMA. Si alguien edita `searches.yaml` a mano y deja una cuenta de resultados menor que los registros que de verdad la tienen como fuente, la búsqueda lo señala en el registro y el diagrama PRISMA avisa que sus cuentas no cuadran.

![Registro de búsquedas con las cadenas exactas, filtros, cifras y búsquedas descartadas](images/mapping-search-log.png)

**Registros y deduplicación.** Los resultados no son papers: son registros ligeros (título, autores, año, venue, resumen, DOI, arXiv u OpenAlex). Al entrar, un registro se une solo a otro ya existente cuando comparten un identificador sin que ningún otro identificador choque entre ellos (por ejemplo, el mismo DOI, aunque uno lo tenga como URL); si no hay identificadores en conflicto, también se une solo cuando el título normalizado es igual, el año es igual y conocido, y ambos tienen autores con el mismo apellido del primero (o, sin identificadores en ninguno de los dos, cuando título, año, venue y primer autor coinciden exactamente, o cuando ninguno de los dos tiene autores: una reimportación exacta). Fuera de esos casos, la app nunca une dos registros por su cuenta: te pregunta. Quedan como **posibles duplicados** en «Cribado»: identificadores que chocan entre sí (un preprint y su versión publicada), el mismo título y año sin que el primer autor coincida o sin autores en alguno de los dos, o títulos casi iguales (similitud de palabras de al menos 0.9) con un año de diferencia como máximo. «Es el mismo» conserva el registro que ya estaba y le suma las fuentes y los datos que le falten del otro (y sus decisiones de cribado, si el otro no tenía ya una igual); «Son distintos» los separa para siempre, en ambos sentidos. Mientras no respondas, el registro recién llegado del par queda fuera de la cola de cribado y del diagrama PRISMA. Un par que la sincronización unió porque dos equipos le dieron ids distintos al mismo identificador aparece con el motivo «Mismo identificador (llegó por la sincronización)». Un registro que ya es un paper de tu biblioteca queda vinculado a él.

**Cribado.** Elige la fase y la lista («Sin decidir», «Dudosos», «Incluidos», «Excluidos», «No conseguidos», «En conflicto», «Todos») y decide registro por registro: «Incluir», «Excluir» (eligiendo el criterio de exclusión), «Dudoso» y, a texto completo, «No se pudo conseguir». Atajos (se ignoran si estás escribiendo en un campo): `I` incluir, `E` excluir (con varios criterios abre la lista y `1`–`9` elige), `D` dudoso, `N` no se pudo conseguir (texto completo), `A` aceptar la sugerencia de Claude, `U` deshacer, `→`/`←` siguiente y anterior, `Esc` cierra la lista de criterios. Tras cada decisión aparece «Deshacer» unos segundos; deshacer agrega una decisión nueva que vuelve a la anterior (nada se borra). Cada decisión guarda la fase, quién decide (`main` en esta etapa), si fue tuya o aceptaste una sugerencia, el criterio, la fecha, el equipo y la versión del protocolo con la que se tomó.

- **Sugerir cribado**: para los registros sin decidir, Claude propone incluir, excluir o dudoso, con el criterio, una justificación y una cita que la app busca en el título y el resumen (o, a texto completo, en el texto del paper) y marca si no la encuentra. Antes de correr, ves cuántos registros y llamadas son, el costo estimado, el tope por llamada, el del lote y lo gastado este mes; solo corre si confirmas. En título y resumen hace una llamada por cada 20 registros; a texto completo hace una llamada por registro, con las herramientas de solo lectura de la biblioteca. **La decisión siempre es tuya:** Claude solo sugiere, nunca decide, y «Aceptar sugerencia» toma exactamente lo que Claude propuso (decisión y criterio). No vuelve a sugerir para un registro que ya tiene una sugerencia hecha con la versión vigente del protocolo. Su costo cuenta para los topes de gasto como `screening`.
- **Agregar a la biblioteca**: los registros incluidos en título y resumen pasan a la fase de texto completo. Los que todavía no son un paper de tu biblioteca ofrecen «Agregar N a la biblioteca» (todos) o «Agregar a la biblioteca» (uno), y piden tu confirmación antes de correr; si tienes activado «Resumir automáticamente al agregar», la confirmación dice cuánto costarán los resúmenes. Se agregan con la ingesta de siempre (metadatos, BibTeX y el PDF de acceso abierto si existe); junto al registro ves el detalle del paper, con su PDF y «Adjuntar PDF» si falta, o marcas «No se pudo conseguir» si no vas a conseguirlo.
- **Conflictos**: si decidiste el mismo registro de forma distinta en dos equipos antes de sincronizar, aparece en «Decisiones distintas en dos equipos» con cada opción, su equipo y su fecha; «Quedarme con esta» la deja como la vigente.

![Cribado por título y resumen, registro por registro con atajos](images/mapping-screening.png)

**PRISMA.** El diagrama de flujo PRISMA 2020 se calcula del registro de búsquedas y de las decisiones vigentes y se actualiza solo: registros identificados por fuente, duplicados quitados, cribados y excluidos en título y resumen, buscados a texto completo y no conseguidos, evaluados y excluidos por criterio, e incluidos. Las búsquedas en bases de datos (OpenAlex e importaciones) van en una columna, snowballing y los papers tomados de la biblioteca en «Otros métodos»; los registros aún sin decidir (o marcados «Dudoso», o en conflicto entre dos equipos) se indican en cada caja como «sin decidir o dudosos», y una búsqueda descartada deja de contar. «Exportar SVG» y «Exportar PNG» lo guardan donde elijas con el diálogo de siempre.

![Diagrama de flujo PRISMA 2020 calculado del registro](images/mapping-prisma.png)

**En los archivos.** Cada mapeo vive en `mappings/<id>/`: `protocol.yaml` (el protocolo y sus versiones), `searches.yaml` (el registro de búsquedas, que solo se agrega), `records.yaml` (los registros con sus fuentes), `decisions.yaml` (las decisiones, que solo se agregan) y `suggestions.yaml` (las sugerencias de Claude, que solo se agregan). Se sincronizan con git y la app mezcla sola lo que puede: una búsqueda, decisión o sugerencia nueva en un equipo nunca se pierde, y un registro cambiado solo en un equipo se conserva tal cual. Cuando el **protocolo** se edita en los dos equipos a la vez y las dos ediciones cambian su cuerpo de forma distinta, la app no puede mezclarlas sola: aparece como uno de los archivos en conflicto de «Sincronización», donde eliges qué versión se queda, igual que con cualquier otro archivo que no sabe mezclar; la versión que no elijas no se pierde, queda en el historial de git. Si un archivo del mapeo no se puede leer (por ejemplo, con marcadores de conflicto de git puestos a mano), el mapeo lo indica en la lista hasta que se corrija.

## Mapa

La vista **Mapa** (barra lateral) tiene tres pestañas:

- **Grafo**: un nodo por paper (más grande cuantas más citas tiene en OpenAlex) y dos tipos de aristas: citas (flecha sólida) y similitud (punteada, más gruesa cuanto más parecidos). Pasa el cursor por una arista punteada para ver sus razones; haz clic en un nodo para abrir su detalle al costado. Controles: **Lente** «Área» (color por la faceta que elijas; un paper con varios valores toma el más frecuente en la biblioteca) o «Tesis» (color por la relevancia 1–5 de la relación con la tesis; gris sin relación); mostrar u ocultar citas y similitud; «Umbral de similitud»; «Aplicar los filtros de la biblioteca» (usa los papers visibles la última vez que abriste la biblioteca); «Exportar PNG» (el grafo solo se exporta a PNG). Las relaciones tipadas se dibujan con un color por tipo: sólidas las confirmadas, punteadas las sugeridas, con flecha salvo en los tipos sin dirección. La fila «Relaciones:» tiene un interruptor por tipo y «Ocultar sugeridas»; al pasar el cursor por una relación se ve su tipo.
- **Gráficas**: «Barras por valor», «Burbujas faceta × faceta» (las celdas vacías se ven como huecos) y «Papers por año». Con «Solo revisadas» apagado cuentan todas las facetas y lo no revisado se dibuja más tenue; encendido, solo las verificadas o editadas. Las entradas que ya no encajan con el tipo actual de su faceta no cuentan. Un clic en una barra o burbuja abre la biblioteca filtrada. Se exportan a SVG, PNG y CSV.
- **Candidatos**: ver «Citas y candidatos».

![Mapa: grafo de papers con citas, similitud y relaciones tipadas](images/map-graph.png)

![Mapa: barras por valor de faceta](images/map-charts.png)

## Redacción

La vista **Redacción** (✍️ en la barra lateral) ayuda a escribir la tesis con lo que la biblioteca ya sabe. Tiene cinco pestañas: «Borrador», «Verificar citas», «Esquema», «BibTeX» y «Estilo». Nada de aquí cambia tus papers, resúmenes ni facetas, y la app nunca escribe en tus archivos `.tex`, `.md` u `.org`: copias el resultado o guardas un archivo nuevo con el diálogo de guardado de siempre.

**Citas que reconoce.** En Org, org-cite: `[cite:@clave]`, `[cite/t:@a;@b]`, con prefijos y localizadores (`[cite:véase @clave p. 3]`). En LaTeX, los comandos de natbib y biblatex `\cite`, `\citep`, `\citet`, `\citealp`, `\citeauthor`, `\citeyear`, `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\fullcite` y `\nocite` (y sus formas con asterisco y con mayúscula), con argumentos opcionales (`\cite[p.~3]{clave}`, `\citep[véase][12]{clave}`) y varias claves separadas por comas. En Markdown, `[@clave]`, `[véase @a, p. 3; @b]` y `@clave` suelto de pandoc (una dirección de correo nunca cuenta). Se ignoran los comentarios de LaTeX (`%`, pero no `\%`), los entornos `verbatim`, `lstlisting` y `minted`, las líneas de comentario y los bloques de código, ejemplo y comentario de Org, y el código y los comentarios HTML de Markdown. Los comandos de LaTeX también se leen dentro de Org y Markdown, porque ambos dejan pasar LaTeX tal cual. Cada cita se muestra con la oración que la contiene: la división en oraciones conoce las abreviaturas comunes (`et al.`, `p.`, `e.g.`, `i.e.`, `p. ej.`, `cap.`, `pág.`…), las iniciales y los números con decimales. Las claves se comparan con la clave de cita de cada paper de la biblioteca.

**Formato de salida.** Donde una pestaña produce texto, eliges Org (por defecto), LaTeX (con el comando de cita: `\cite`, `\parencite`, `\citep` o `\autocite`) o Markdown; la elección se recuerda por proyecto en este equipo.

- **«BibTeX»** (sin Claude): eliges un archivo `.tex`, `.md` u `.org` con «Elegir archivo…» o pegas texto, eliges el orden (de aparición o alfabético por clave) y tocas «Generar .bib». Con un archivo, la app lee también lo que incluye (`\input`, `\include`, `\subfile`, `#+INCLUDE` de Org), pero solo dentro de la carpeta del archivo elegido: no sigue rutas ni enlaces simbólicos que salgan de ella, ni un archivo que se incluye a sí mismo, ni más de 8 niveles, y lista cada inclusión que no siguió con su motivo. El `.bib` lleva solo las entradas citadas, las mismas que la biblioteca exporta a `exports/library.bib`. El informe lista las claves citadas que no están en la biblioteca (con una sugerencia cuando una clave o un título de la biblioteca se parece, por ejemplo por una errata), las claves de papers en la papelera y las entradas sin año, sin autores o sin venue. «Guardar .bib…» lo guarda donde elijas; «Copiar» lo copia.
- **«Borrador»** (con Claude): das el título de la sección, su propósito o indicaciones (texto libre), opcionalmente una pregunta de investigación (de Ajustes → Tesis), los papers (los eliges de la biblioteca con la lista, o tomas los que la biblioteca muestra con sus filtros actuales o los que un mapeo incluyó a texto completo; como mucho 60) y la extensión (corta ~300, media ~700 o larga ~1500 palabras). «Redactar» abre antes la misma confirmación que las demás operaciones de Claude de «Redacción»: el modelo (el del borrador, o el del proyecto si es nuevo), el costo estimado, el «Tope por borrador» y el gasto del mes; solo corre si confirmas. Claude trabaja como en el chat: lee los papers elegidos con las herramientas de solo lectura de la biblioteca, que en un borrador solo alcanzan esos papers (rechazan cualquier otra clave, y las búsquedas, listas, citas y vecinos solo devuelven papers elegidos), ve la tesis y los metadatos y el «en pocas palabras» de cada paper elegido, y escribe en el idioma de la tesis (Ajustes → Tesis; español si no elegiste otro), citando cada afirmación con el marcador del chat `[[clave|p. N|"frase"]]`, con las citas textuales en el idioma del paper. Solo puede citar los papers que elegiste; donde la sección necesita una afirmación que no respaldan, escribe `[[sin cita]]` en lugar de una cita. El texto aparece mientras se escribe, y «Detener» conserva lo que llegó como una versión detenida. Al terminar, la app verifica cada cita contra el texto del paper igual que el chat: debajo del texto, un chip por cita («clave, p. N», o «no encontrada»), marcado «fuera de la selección» cuando cita un paper que no elegiste; tocar un chip abre el PDF del paper con la frase resaltada. Los contadores dicen cuántas citas se verificaron, cuántas no, cuántas están fuera de la selección y cuántas afirmaciones no tienen cita. Puedes editar la versión actual en el cuadro de texto, conservando los marcadores tal cual: se guarda sola y sus citas se vuelven a verificar un momento después de que dejas de escribir. «Regenerar» escribe una versión nueva con el formulario como esté; las anteriores quedan, de solo lectura, en el selector «Versión». «Copiar como Org/LaTeX/Markdown» y «Guardar…» convierten los marcadores al formato de salida (`[cite:@clave p. N]`, `\cite[p.~N]{clave}` con el comando elegido, o `[@clave, p. N]`), opcionalmente con cada cita textual como comentario; una cita no verificada nunca se convierte en silencio: queda con un comentario «NO VERIFICADA» (`<!-- no verificada -->` en Markdown) y se cuenta, y `[[sin cita]]` se vuelve un `[SIN CITA]` visible. A la izquierda, la lista de borradores con búsqueda (título, propósito y texto), y para el abierto «Renombrar», «Archivar» y «Borrar» (con confirmación). Cada borrador es un archivo `drafts/<id>.md`: sus datos arriba (título, propósito, pregunta, papers, extensión, modelo, fechas, costo y el modelo, la fecha y el costo de cada versión), luego cada versión bajo un encabezado `## Versión N`. Se versionan y sincronizan con git como las conversaciones: si solo un equipo escribió una versión nueva, o renombró, archivó o cambió el formulario del borrador (cada campo se toma del equipo que lo cambió), se mezclan; si los dos lo cambiaron, se conservan los dos, el del otro equipo como «(copia de <equipo>)».
- **«Verificar citas»**: pegas hasta 30 000 caracteres; el formato se detecta (puedes elegir otro). El paso local es gratis e inmediato: cada cita con su oración, y qué claves no están en la biblioteca, están en la papelera, se citan dos veces en la misma oración o son de papers sin texto indexado (esas no se pueden verificar contra el paper).
  **«Verificar con Claude»** pregunta después a Claude si cada paper que cita una oración la respalda. Al tocar el botón, la confirmación (la misma de las demás operaciones de Claude de «Redacción») te deja elegir el modelo (el del proyecto por defecto) y muestra cuántas oraciones y citas se verificarán, en cuántas llamadas (hasta 10 oraciones por llamada), el costo estimado, el «Tope por verificación de citas» (Ajustes → Claude, 1 USD por defecto, compartido por toda la verificación) y el gasto del mes; nada corre hasta que confirmas. Para cada oración y cada paper citado con texto indexado, la app elige primero los pasajes del paper más cercanos a la oración (por sus palabras y, si el modelo local de similitud está descargado, por su sentido, así una oración en español encuentra el pasaje de un paper en inglés; la lista de referencias queda fuera), y Claude juzga sobre ellos: «respalda», «respalda en parte», «no respalda» o «no se encontró» (los pasajes no tratan lo que dice la oración), con la frase textual y la página que lo deciden y una nota breve. La app busca la frase en el texto del paper, igual que las citas del chat: si no está (o es solo una o dos palabras), el veredicto se muestra como «evidencia no encontrada». `\nocite` no afirma nada y se omite; las claves desconocidas, en la papelera o sin texto quedan «sin verificar» con su motivo. Mientras corre ves las llamadas hechas y puedes tocar «Detener»: lo verificado hasta ahí se conserva. El resultado: el texto verificado con cada cita coloreada por su veredicto más débil (al tocarla vas a su oración), un panel por oración con el veredicto, la frase y la nota de cada paper (el chip de página abre el paper con la frase resaltada), y un resumen (respaldadas, en parte, no respaldadas, no se encontró, sin verificar). «Exportar informe…» lo guarda en Markdown donde elijas. El informe vive solo en la pestaña: nada se guarda en el proyecto. Cada llamada queda registrada como `cite_check` en los costos.
- **«Esquema»** (el básico, sin Claude): eliges una pregunta de investigación (opcional, de Ajustes → Tesis), una faceta principal y opcionalmente una secundaria, los papers (toda la biblioteca, los que la biblioteca muestra con sus filtros actuales o los que un mapeo incluyó a texto completo) y «Solo revisadas» (solo cuentan las facetas que verificaste o editaste). La app arma un índice: una sección por valor de la faceta principal (subsecciones por valor de la secundaria), con cada paper con su clave, título, año, el «en pocas palabras» de su resumen y sus relaciones tipadas confirmadas con otros papers del conjunto; los valores sin papers y las combinaciones vacías se listan como huecos, y los papers sin valor van a «Sin clasificar». Se exporta como Org (encabezados `*`/`**`, `[cite:@clave]`, los huecos como líneas de comentario `# HUECO:`), LaTeX (`\section`/`\subsection`, un `\cite{}` por paper, los huecos como comentarios `% HUECO:`) o Markdown; «Copiar» o «Guardar…».
- **«Proponer redacción del esquema»** (con Claude), debajo del esquema: tras la confirmación de costo (modelo, estimación, «Tope por esquema» y el gasto del mes), Claude lee el esquema, el «en pocas palabras» de cada paper y las frases textuales de su resumen, y tu tesis (Ajustes → Tesis), y propone un título para cada sección y subsección, el orden de las secciones, una o dos frases de apertura por sección y, por cada hueco, una frase sobre por qué importa para la tesis. No puede agregar, juntar ni dividir secciones, ni citar papers fuera del esquema: una respuesta que lo hace se rechaza (se le pide una vez más y si no, se muestra el error con «Reintentar»). Cada afirmación sobre un paper lleva la cita de la app `[[clave|p. N|"frase"]]`, verificada contra el texto indexado del paper o la evidencia de su resumen; la vista previa muestra la propuesta mezclada con el esquema (el valor de la faceta junto a cada título nuevo), con un chip por cita, y cuántas no se pudieron verificar. Se exporta como el esquema básico (Org, LaTeX o Markdown, con las aperturas y las frases de los huecos como párrafos, las citas convertidas, un comentario «NO VERIFICADA» en cada una que no se verificó y, si lo marcas, cada frase textual como comentario); «Copiar» o «Guardar…». Si cambias las opciones del esquema después, la propuesta se marca como del esquema anterior. Nada se guarda en el proyecto. Hasta 300 papers por propuesta.
- **«Estilo»** (con Claude): pegas hasta 20 000 caracteres de Org, LaTeX o Markdown (se detecta; puedes elegir otro), eliges qué revisar (claridad, concisión, registro académico, ortografía y gramática, coherencia entre párrafos; todo por defecto) y, tras la confirmación de costo («Tope por revisión de estilo»), Claude devuelve sugerencias, cada una con el fragmento que cambia, el texto nuevo, el motivo y su categoría. La app conserva solo las seguras y dice cuántas descartó y por qué: el fragmento tiene que aparecer en tu texto tal cual (si aparece varias veces, Claude debe dar un fragmento más largo a su alrededor que aparezca una sola vez; si no, se descarta como ambigua, nunca se aplica a la primera), y el cambio tiene que dejar cada cita, clave, matemática (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, entornos matemáticos), comando o escape de LaTeX (`\emph`, `\%`), `\ref`, `\label`, enlace de Org, macro y línea `#+` exactamente como estaba, sin agregar ni quitar ninguno, juzgado sobre el texto completo con el cambio aplicado; tampoco puede agregar ni quitar un `%`, un `$` o una llave (en Markdown, solo `$`), que podrían comentar, tragarse o romper lo que viene después. Si dos sugerencias se solapan, queda la que empieza antes. Cada sugerencia tiene «Aceptar» y «Rechazar»; «Aceptar todas» las acepta todas. La vista «Cambios» muestra el texto con los cambios aceptados tachados e insertados y los pendientes resaltados; «Texto final» muestra el resultado y «Copiar texto final» lo copia. Nada se guarda en el proyecto.

### Desde Emacs (API local)

La app puede prestarle estas herramientas a tu editor. En **Ajustes → Aplicación → «API local»** activa **«Activar la API local»**: la app levanta un servidor pequeño (MCP sobre HTTP) que solo responde en este equipo (`127.0.0.1`, puerto 47823 por defecto, que puedes cambiar) y solo a peticiones con su token. La primera vez, la app genera el token y lo escribe con la dirección en `api.json`, en su carpeta de datos (en Linux `~/.config/research/api.json`, que solo tu usuario puede leer); «Copiar token» lo copia y «Regenerar token» lo reemplaza (el anterior deja de funcionar al instante). Viene desactivada; mientras no haya un proyecto abierto, cada herramienta responde que abras uno.

Lo que ofrece: las mismas herramientas de solo lectura de la biblioteca que usa el chat (buscar en el texto, leer páginas, los datos y el resumen de un paper…), y además los papers que puedes citar (para completar), la verificación local de las citas de un texto, el `.bib` de un texto o de un archivo (por su ruta completa, siguiendo sus inclusiones solo dentro de su carpeta, como «BibTeX»), el esquema (como lo arma «Esquema», en Org, LaTeX o Markdown), una búsqueda de pasajes en el texto completo y «abrir en la app»: la app pasa al frente con el paper en esa página y la cita resaltada. Todo esto es gratis y no cambia nada del proyecto. Con Claude, ofrece además «Borrador» (un borrador nuevo a partir de los papers que indiques, guardado en el proyecto como uno escrito en la ventana: responde enseguida con el id del borrador mientras la app lo escribe, y una consulta gratuita de su estado da el avance y, al terminar, su texto en tu formato; otra llamada gratuita lo detiene, y también se puede detener desde «Borrador» en la ventana; un borrador desde la API a la vez), «Verificar con Claude» (los veredictos de cada oración con la cita textual y la página del paper), «Proponer redacción del esquema» (el esquema con la redacción de Claude, en tu formato) y «Estilo» (las sugerencias validadas, con dónde va cada una). Se rechazan salvo que actives también **«Permitir operaciones con costo desde la API»** (desactivado por defecto); aun así, cada una responde primero su costo estimado (en la verificación, el de ese texto), los topes y el gasto del mes, y solo corre cuando se la vuelve a llamar con la confirmación. Corren igual que en la ventana (mismas verificaciones, mismos topes de Ajustes → Claude) y se cobran una sola vez, como allí. Una verificación, una propuesta de esquema o una revisión de estilo se detiene si el editor corta la conexión antes de la respuesta, y cerrar el proyecto o salir de la app detiene cualquiera de ellas. Con este interruptor activado, cualquier programa que corra con tu usuario y pueda leer el token de `api.json` puede gastar cuota de Claude hasta esos topes (por operación y por mes).

**El tutor.** Cuatro operaciones más con Claude, tras el mismo interruptor y la misma confirmación, te ayudan a escribir la tesis sin escribirla por ti: ninguna devuelve tu texto reescrito. «Tutor» lee un pasaje (hasta 8 000 caracteres) y señala lo que puede debilitarlo (una ambigüedad, un salto lógico, un conector que no dice la relación real, un sujeto perdido, el registro, la cohesión, el ritmo, la precisión): para cada cosa, el fragmento exacto, por qué puede confundir al lector y una pregunta que te lleva a encontrar tú el arreglo. Su respuesta no tiene dónde poner una reescritura, y la app descarta (y cuenta) cualquier entrada cuya explicación o pregunta cite ocho palabras o más que tú no escribiste. «Alternativas» toma una oración tuya (hasta 600 caracteres, con su párrafo solo como contexto) y ofrece dos o tres formas más de decirla, cada una con lo que cambia (énfasis, orden, ritmo, concisión, registro, precisión o el enlace con la oración anterior), para que compares y elijas, o te quedes con la tuya; cada una tiene que conservar tus citas, tu matemática y tus comandos de LaTeX exactamente (pueden moverse, no cambiar), o se descarta. «Esquema inverso» toma una sección (hasta 20 000 caracteres): la app la divide en párrafos y Claude da a cada uno su idea principal en 20 palabras como mucho, con tus propios términos, y lo marca cuando tiene dos ideas, le falta la transición con el anterior o se aparta de su encabezado, con una nota de una línea. «Cobertura de preguntas» toma un capítulo o una sección (hasta 40 000 caracteres) y dice qué preguntas de investigación de Ajustes → Tesis aborda cada encabezado, cada una con un fragmento breve de esa sección como evidencia, que la app comprueba que está de verdad en tu texto (lo que no lo tiene se descarta), y qué preguntas no aborda ningún encabezado. Todas escriben sus explicaciones en el idioma de la tesis y tienen su propio tope en Ajustes → Claude.

**«Preguntar a Claude» desde el editor.** Una operación más con Claude, tras el mismo interruptor y la misma confirmación, pide la opinión de Claude sobre un párrafo, una sección o un capítulo que estás escribiendo. Envías tu pregunta con el pasaje (hasta 30 000 caracteres), el nombre del archivo y la ruta de encabezados; Claude lo lee con el contexto de la tesis (Ajustes → Tesis) y las herramientas de solo lectura de la biblioteca, y responde como un lector exigente: qué funciona, qué cambiar y por qué, y preguntas para ayudarte a decidir. **Por defecto no reescribe tu pasaje** (como mucho, una frase breve de ejemplo para ilustrar algo). Solo cuando lo permites explícitamente en una pregunta propone además una versión, al final, separada como propuesta de Claude y nunca como tu texto. Lo que afirma sobre los papers lleva las citas del chat, comprobadas contra el texto del paper como en el chat. Cuesta una respuesta de chat (el tope «Tope por mensaje de chat») y queda como una conversación normal de la vista Chat (`chats/`, sincronizada como las demás), con tu pregunta como título y la marca «desde Emacs: archivo › sección»; su encabezado muestra el pasaje. Las preguntas de seguimiento continúan la misma conversación, desde el editor o desde la vista Chat (una pregunta hecha en la vista Chat siempre es de opinión).

**Emacs.** El paquete `emacs/research.el` del repositorio (sin dependencias, Emacs 29+) usa esta API en búferes Org, LaTeX y Markdown con `research-mode`: `research-insert-citation` (completa un paper e inserta `[cite:@clave]`, `\cite{clave}` o `[@clave]`), `research-check-citations` (claves desconocidas, en la papelera, repetidas o sin texto indexado como diagnósticos de Flymake), `research-bibtex-for-file` (el `.bib` junto al archivo; ofrece agregar `#+bibliography:` y sumarlo a `citar-bibliography`), `research-insert-outline`, `research-find-passage` (RET inserta la cita textual con su cita y página; `o` la abre en la app) y `research-open-citation-at-point`. Con Claude, tras mostrar la estimación y preguntar: `research-check-citations-with-claude` (el veredicto de cada cita en Flymake, con la cita textual y la página del paper: error si no respalda la oración o su cita no se encontró, advertencia si la respalda en parte o no se encontró un pasaje, nota si la respalda), `research-propose-outline` (inserta la propuesta) y `research-style-review` (recorre las sugerencias como `query-replace`, `y`/`n`/`!`/`q`, y se niega si el texto cambió mientras tanto). `research-draft` pide el título, el propósito, los papers, la extensión y la pregunta de investigación y vuelve enseguida: la app escribe el borrador en segundo plano mientras Emacs sigue libre, muestra el avance cada `research-draft-poll-interval` segundos (5) y, cuando está escrito, abre su texto en Org en un búfer nuevo `*research-draft*`; el borrador queda también en «Borrador». `research-draft-stop` lo detiene (se conserva lo que llegó). Mientras se escribe un borrador pedido desde Emacs, `research-draft` se niega a empezar otro, así que reintentar nunca cobra dos veces. El tutor, también tras la estimación: `research-tutor` (la región o el párrafo en el cursor; sus notas, cada una con su tipo, el porqué y una pregunta, se ven en Flymake con su propio backend), `research-alternatives` (la oración en el cursor o la región; un búfer pequeño lista las opciones con lo que cambia cada una: `RET` pone la que está bajo el cursor en lugar de tu oración solo si no la cambiaste mientras tanto, `q` conserva la tuya), `research-reverse-outline` (el subárbol de Org en el cursor o la región; un búfer lateral con una línea por párrafo, su idea principal y sus marcas; `RET` salta al párrafo) y `research-rq-coverage` (el archivo, la región o, con `C-u`, el subárbol; un informe por encabezado con la evidencia, `RET` salta a ella, y las preguntas que quedan sin abordar). `research-ask` (`?`) hace tu pregunta sobre la región o el párrafo en el cursor (`C-u`: el subárbol de Org, una sección o un capítulo; `C-u C-u`: el archivo completo), luego «¿Permitir propuesta de redacción? (y/N)» (solo `y` permite una versión propuesta), muestra la estimación y va mostrando la respuesta en un búfer lateral de Org de solo lectura, `*research-ask*`, con la pregunta, el alcance, archivo › sección, el modo y, al terminar, el costo; las citas se leen `[clave, p. N]` y se listan con su cita textual, resaltando las no verificadas. Ahí `f` hace una pregunta de seguimiento, `c` abre en la app la cita en el cursor, `a` abre la conversación en la app, `s` detiene la respuesta y `q` cierra. Tu búfer nunca se modifica.

**Revisión de la prosa, sin la app.** `emacs/research-prose.el` revisa la prosa académica en español de forma local y gratuita (Emacs Lisp puro, sin la app, sin red): `research-prose-check` revisa el búfer o la región una vez, y `research-prose-mode` mantiene la revisión mientras escribes, ambas como diagnósticos de Flymake que dicen por qué un pasaje puede leerse mal, nunca cómo reescribirlo. Señala oraciones de más de 40 palabras, una palabra con contenido repetida a menos de 30 palabras, muletillas y giros desaconsejados del registro académico («cabe mencionar», «en este sentido», «a nivel de», «en base a», «hoy en día», «el mismo» como pronombre…), más de un gerundio o más de un adverbio en -mente en una oración, la pasiva perifrástica («fueron analizados»), párrafos con legibilidad INFLESZ por debajo de 40, términos de un mismo grupo usados sin coherencia (de `research-prose-term-groups` o de una línea `#+PROSE_TERMS: desensibilización|anonimización|sanitización` en el archivo; se marcan los menos usados) y acrónimos definidos en el `acronimos.tex` de la tesis escritos a secas en vez de `\gls{…}`, o un `\gls{…}` que no está definido allí, y anota las palabras en mayúsculas que parecen una sigla pero no están definidas (salvo números romanos y las palabras de `research-prose-acronym-ignore`). Ignora encabezados, líneas de palabras clave, cajones, bloques de código, ejemplo, exportación, comentario y cita, tablas (salvo para los acrónimos: una tabla también se exporta a LaTeX), líneas de comentario, entornos, matemática y comandos de LaTeX, citas y destinos de enlaces. Cada revisión y cada umbral se pueden configurar.

Los acrónimos son lo único que escribe por ti. Con `research-prose-auto-gls-mode`, activo por defecto en los archivos de la tesis (`research-prose-auto-gls`), un acrónimo definido se vuelve `\gls{CLAVE}` en cuanto terminas de escribirlo: `Los LLMs ` queda `Los \glspl{llm} `; se reconoce por su sigla y se escribe con su clave (con `\newacronym{ner}{REN}{…}`, `REN` pasa a `\gls{ner}`), y al inicio de una oración o de una celda de tabla usa `\Gls`/`\Glspl`, porque el primer uso se desarrolla en la forma larga, que entonces debe empezar con mayúscula (`research-prose-gls-capitalize` en nil deja siempre `\gls`). Un `undo` justo después devuelve el acrónimo a secas. Nunca convierte donde las revisiones no ven prosa, justo después de un carácter que puede abrir marcado (`{`, `[`, `=`, `$`…), en encabezados ni en el propio `acronimos.tex`. Para el texto ya escrito, `research-prose-gls-fix` recorre cada acrónimo a secas de la región o del búfer como `query-replace` (`y` convierte, `n` lo salta, `!` convierte el resto, `q` termina; toda la pasada se deshace de una vez) y `research-prose-gls-at-point` convierte el del punto. `research-prose-add-acronym` define uno que falta: pide su forma larga, el plural de la forma larga (con una sugerencia en español; glossaries si no solo agrega una «s» y daría «modelo de lenguaje de gran tamaños», así que un plural distinto se escribe como `[longplural={…}]`) y su clave, agrega `\newacronym{CLAVE}{SIGLA}{forma larga}` a `acronimos.tex` (en orden si el archivo está ordenado), lo guarda y ofrece convertir el acrónimo del punto. Con Doom Emacs, agrega a `packages.el`:

```elisp
(package! research :recipe (:local-repo "~/dev/lalohao/research/emacs" :files ("research.el" "research-prose.el")))
```

y a `config.el`:

```elisp
(use-package! research
  :hook ((org-mode latex-mode LaTeX-mode markdown-mode) . research-mode)
  :init (setq research-keymap-prefix nil))

(use-package! research-prose
  :commands (research-prose-mode research-prose-check research-prose-gls-at-point research-prose-gls-fix
             research-prose-add-acronym research-prose-auto-gls-mode)
  :hook (org-mode . research-prose-maybe-enable)
  :init (setq research-prose-thesis-directories '("~/thesis/")))

(map! :after research
      :map (org-mode-map latex-mode-map LaTeX-mode-map markdown-mode-map)
      :localleader
      (:prefix ("w" . "writing (research)")
       "c" #'research-insert-citation
       "k" #'research-check-citations
       "b" #'research-bibtex-for-file
       "o" #'research-insert-outline
       "f" #'research-find-passage
       "a" #'research-open-citation-at-point
       "t" #'research-tutor
       "w" #'research-alternatives
       "r" #'research-reverse-outline
       "q" #'research-rq-coverage
       "l" #'research-prose-check
       "g" #'research-prose-gls-at-point
       "G" #'research-prose-gls-fix
       "A" #'research-prose-add-acronym
       "T" #'research-prose-auto-gls-mode
       :desc "Preguntar a Claude" "?" #'research-ask))
```

y luego `doom sync`: `SPC m w` reúne los comandos (`w` de escritura, porque Org usa `SPC m r` para reubicar; `SPC m w g` convierte el acrónimo del punto, `SPC m w G` todos, `SPC m w A` agrega uno, `SPC m w T` activa o desactiva la conversión al escribir) y `research-prose-mode` y `research-prose-auto-gls-mode` se activan en los archivos Org de la carpeta de tu tesis. `emacs/README.md` (en inglés) tiene todos los comandos, opciones y teclas.

## Bandeja y arranque

Mientras la app corre, pone un ícono en la bandeja del sistema (en KDE Plasma y otros escritorios con bandeja StatusNotifierItem). El ícono es un libro; un punto ámbar indica trabajos en cola o en curso, y uno rojo, algo que revisar: conflictos de sincronización esperando tu decisión, o trabajos que fallaron desde la última vez que miraste la ventana (cuentan como vistos cuando la ventana se muestra y tiene el foco; los fallos de antes de abrir la app no cuentan). Al pasar el ratón muestra el proyecto, el estado de la sincronización, los trabajos en curso y si la API local está encendida.

El clic izquierdo muestra la ventana, o la oculta si ya está al frente. El menú del clic derecho:

- **«Mostrar ventana» / «Ocultar ventana»**.
- **El nombre del proyecto** y **«Agregar desde el portapapeles»**: si el portapapeles tiene un DOI, un id de arXiv u OpenAlex o una dirección http(s), se agrega igual que desde la casilla «Agregar» (un trabajo que aparece en Actividad); si no, una notificación dice «El portapapeles no tiene un DOI, arXiv o URL». El portapapeles solo se lee al elegir la opción, solo se usa para eso y nunca se escribe en el registro.
- **«Abrir en el navegador de la app»**: abre la dirección http(s) del portapapeles en el navegador de la app, para capturar la página (ver «Sitios que bloquean las descargas»).
- **El estado de la sincronización** y **«Sincronizar ahora»**: lo mismo que el botón ⟳ del riel. Sincroniza en el acto cuando puede; si el repositorio no tiene remoto, hay conflictos pendientes, o la sincronización falla o termina en conflictos, la ventana se abre en la vista Sincronización. Desactivado mientras el proyecto no está en un repositorio git o hay una sincronización en curso.
- **«N trabajos en curso»**, cuando los hay.
- **«API local: encendida/apagada»**: enciende o apaga la API local, igual que el interruptor de Ajustes → Aplicación.
- **«Abrir proyecto…»**: el mismo selector de carpeta que la pantalla de bienvenida.
- **«Salir»**: cierra la app de verdad, como antes lo hacía cerrar la ventana: guarda las ediciones pendientes, pregunta «Hay cambios sin sincronizar» cuando corresponde (la ventana vuelve para preguntarlo), los trabajos en curso vuelven a la cola y la API local se detiene.

**Cerrar la ventana** con «Al cerrar la ventana, seguir en la bandeja» (activado por defecto) solo la oculta: la app sigue corriendo detrás del ícono, con la API local (Emacs sigue funcionando), los trabajos y la sincronización automática. La primera vez, una notificación avisa «research sigue en la bandeja». Para salir, usa «Salir» en el menú de la bandeja o Ctrl+Q («Archivo → Salir»). Si no hay bandeja (un escritorio sin ella, o no se pudo crear el ícono), cerrar la ventana sale de la app como antes, para que nunca quede corriendo sin nada en pantalla; Ajustes → Aplicación lo indica. Si la app arranca antes que el panel (al iniciar sesión), el ícono aparece en cuanto el panel está listo; hasta entonces cerrar sale.

**Ocultar la ventana sin botón de cerrar.** Los gestores de ventanas sin barra de título (xmonad y otros de mosaico) no tienen una ✕ que pulsar: usa **«Archivo → Ocultar en la bandeja»** o **Ctrl+W**. La ventana va a la bandeja igual que al cerrarla (diga lo que diga «Al cerrar la ventana, seguir en la bandeja»); vuelve con un clic izquierdo en el ícono o abriendo la app otra vez. Sin bandeja la opción aparece desactivada (nada podría traer la ventana de vuelta). En la ventana del navegador de la app, Ctrl+W cierra esa ventana. El atajo propio del gestor para cerrar ventanas (en xmonad, mod-shift-c) también sirve: equivale a la ✕. La barra de menú (Archivo, Editar, Ver) siempre está visible; «Ver» tiene el zoom (Ctrl+0, Ctrl++ y Ctrl+-), la pantalla completa (F11) y las herramientas de desarrollo.

**Abrir la app otra vez** mientras corre (desde un lanzador, la terminal o el inicio de sesión) trae la ventana de la que ya está abierta, también si estaba oculta en la bandeja.

**Iniciar con la sesión**: «Iniciar con la sesión» (Ajustes → Aplicación, Linux) escribe `~/.config/autostart/research.desktop` (o bajo `$XDG_CONFIG_HOME`), que KDE, GNOME y otros escritorios XDG lanzan al iniciar sesión; al desactivarlo se borra. Necesita una versión empaquetada (un ejecutable al que apuntar): la AppImage, de una versión publicada en GitHub o compilada por ti (ver «Instalar como aplicación» en el README). Actívalo desde la copia instalada, `~/Applications/research.AppImage`: la entrada ejecuta ese archivo, y al actualizar (`scripts/install-appimage.sh --release` para una versión publicada; `git pull`, `pnpm dist`, `scripts/install-appimage.sh` para una compilación local) se reemplaza en el mismo lugar, así que la entrada sigue funcionando. Si lo activas desde una AppImage en otro lugar (por ejemplo `dist/`), la entrada apunta ahí. El ícono de la entrada es el ícono `research` que el script de instalación pone en tu tema de íconos. Con `pnpm dev` no hay versión empaquetada, así que la app no escribe la entrada: explica por qué y muestra una línea de comando que arranca la última compilación (`pnpm build`) con el Electron del repositorio, que puedes agregar tú al inicio automático de tu sesión. «Iniciar oculto en la bandeja» vale solo para el inicio de la sesión: con la opción activada, el comando de la entrada termina en `--hidden`, así que al iniciar sesión la app arranca en la bandeja sin mostrar la ventana. Al abrirla desde el menú de aplicaciones o una terminal la ventana se muestra siempre; `research.AppImage --hidden` desde una terminal arranca oculta a propósito. Cambiar la opción con «Iniciar con la sesión» activado reescribe la entrada en el momento (y al arrancar, la app pone al día una entrada escrita por una versión anterior). Sin bandeja, la ventana se muestra igual, con `--hidden` o sin él. Con `pnpm dev`, la línea de comando que se muestra también lleva `--hidden` si la opción está activada.

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
- **Tope por borrador**, **Tope por verificación de citas**, **Tope por esquema** y **Tope por revisión de estilo (USD est.)**: el máximo estimado de cada operación de Claude de «Redacción» (1, 1, 0,5 y 0,5 por defecto). Cuentan también para el tope mensual. Las cuatro operaciones existen: «Borrador», «Verificar con Claude», «Proponer redacción del esquema» y «Estilo» corren cada una bajo el suyo.
- **Tope por lectura del tutor**, **Tope por alternativas de una oración**, **Tope por esquema inverso** y **Tope por cobertura de preguntas (USD est.)**: el máximo estimado de cada operación del tutor desde el editor (0,3, 0,1, 0,5 y 0,5 por defecto); cuentan también para el tope mensual.
- **Tope mensual (USD est., vacío = sin tope)**: el máximo estimado acumulado en el mes, sumando el gasto de todos tus equipos (ver «Gasto estimado este mes» más abajo). Es el único de los tres topes que puede quedar vacío, y vacío significa sin tope. El mes se cuenta por mes calendario en UTC, sumando todos los dispositivos que sincronizan el proyecto.
- **Tamaño máximo de entrada (caracteres)**: cuánto texto del paper se manda a Claude como máximo. Un paper más largo no se puede resumir sin usar «Forzar» (ver «Resúmenes con Claude»).
- **Gasto estimado este mes (todos tus equipos)**: suma de los costos estimados registrados este mes en `costs/`, de cualquier dispositivo que sincronice este proyecto. Con una suscripción, estos costos son estimaciones de la cuota que consumes, no cargos reales.

### Tesis

- **Título** y **Descripción** (problema, enfoque, alcance): el tema de la tesis que Claude usa para explicar la relación de cada paper con ella. Basta con completar uno de los dos para empezar a tener relaciones; mientras falten los dos, el resumen no incluye esa sección («Define el tema de tu tesis en Ajustes para obtener esta sección.»). Los resúmenes generados antes de completar alguno de los dos quedan *Desactualizados* y muestran «Regenera el resumen para obtener la relación con la tesis.».
- **Preguntas de investigación**: se agregan y quitan con sus botones; cada una tiene un identificador propio (RQ1, RQ2…) que **nunca se renumera ni se reutiliza**, aunque borres la pregunta con el número más alto — así una pregunta sigue siendo la misma referencia en los resúmenes ya generados aunque cambie su posición en la lista. Esos identificadores se ven como chips en la tarjeta de la relación con la tesis del resumen, no en esta pestaña.
- **Idioma de la tesis**: español (por defecto) o inglés. «Redacción» escribe en él; las citas textuales quedan en el idioma de cada paper. Cambiarlo no desactualiza los resúmenes.
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
- **API local**: deja que un editor de este equipo (Emacs, con `emacs/research.el`) use las herramientas de redacción; viene desactivada, con su puerto, «Copiar token», «Regenerar token» y «Permitir operaciones con costo desde la API». Ver «Desde Emacs (API local)» en «Redacción».
- **Bandeja y arranque**: «Al cerrar la ventana, seguir en la bandeja» (activado por defecto), «Iniciar oculto en la bandeja» e «Iniciar con la sesión». Ver «Bandeja y arranque».
- **Abrir carpeta de registros**: abre en tu explorador de archivos la carpeta del registro de la app, `main.log` (ver «Problemas comunes»).
- **Cerrar proyecto**: vuelve a la pantalla de bienvenida para crear o abrir otro proyecto.

## Archivos del proyecto

```
project.yaml               configuración del proyecto (nombre, idioma, política de PDFs, Claude, tesis, formulario de extracción, candidatos descartados)
relations.yaml             relaciones tipadas entre papers (sugeridas, confirmadas y rechazadas)
facet-suggestions.yaml     facetas, valores y alias que Claude sugirió para el formulario, con su estado
chats/<id>.md              conversaciones con Claude, una por archivo
drafts/<id>.md             borradores de «Borrador», uno por archivo, con sus versiones
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

**«El sitio bloquea las descargas automáticas…»**
El sitio respondió a la app con protección contra bots o con un 401/403. Abre la página en el navegador de la app o guárdala como PDF desde tu navegador (ver «Sitios que bloquean las descargas»).

**«El servidor negó el acceso…»** / **«OpenAlex negó el acceso…»**
Un servidor rechazó una consulta. Solo el de OpenAlex apunta a tu clave de API de OpenAlex (Ajustes → Aplicación); con cualquier otro servidor, reintenta más tarde o agrega el paper de otra forma.

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

**«OpenAlex rechazó la búsqueda: …»**
OpenAlex respondió que la cadena de búsqueda no es válida; el resto del mensaje es la explicación de OpenAlex, en inglés (por ejemplo, un paréntesis o unas comillas sin cerrar). Corrige la cadena y vuelve a buscar. No es un problema de conexión: «Error de red» solo aparece cuando la app no pudo llegar al servicio.

**El registro de la app**
Cuando algo falla y el mensaje no basta, Ajustes → Aplicación → «Abrir carpeta de registros» abre la carpeta con `main.log` (en la carpeta de datos de la app; rota al llegar a unos 5 MB y guarda los tres últimos archivos). Anota el inicio de la app, los proyectos que abres y cierras, el inicio, el fin y el fallo de cada trabajo con su error, las consultas fallidas a OpenAlex y otros servicios (con el mensaje del servicio), cada ejecución de Claude con herramientas (sugerencias de relaciones, de facetas y de cribado, respuestas del chat: su inicio, cada herramienta que llama por su nombre con solo identificadores, números de página y largos de texto, cada aprobación de una acción pedida y decidida, y su fin con turnos, costo y tiempo) y los errores inesperados. Nunca guarda claves de API, correos, tokens ni contraseñas, ni el texto de tus papers, los resúmenes o lo que envías a Claude o recibes de él. Adjúntalo si reportas un problema.

Si abres la app desde una terminal (`pnpm dev`), las mismas entradas se imprimen ahí en el momento, ya redactadas y una por línea, como `[research] 12:03:41 job:summarize ok paper=zhu2020loghub 4.2s` o `[research][chat 20261012-120310-ab12] 12:04:10 tool library.read_pages paper_id=he2017drain from=3 to=5`; los avisos y errores van a stderr. `RESEARCH_LOG_LEVEL=debug|info|warn|error` elige cuánto se imprime (`info` por defecto en desarrollo, `warn` en una versión instalada; `debug` agrega cuándo terminó cada llamada a una herramienta, que `main.log` nunca guarda) y `RESEARCH_LOG_CONSOLE=0` apaga la salida en la terminal; `main.log` se escribe igual en ambos casos.

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
