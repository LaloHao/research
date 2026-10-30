/** What the popup, the options page and the shortcut's badge say about an error code (the app's or the extension's own). */
const MESSAGES: Record<string, string> = {
  unreachable: 'Research no está abierto o la API local está apagada (en Research: Ajustes → Aplicación → API local).',
  not_paired: 'Extensión no vinculada: vincúlala en sus opciones con el código de Research (Ajustes → Aplicación → Extensión del navegador).',
  no_project: 'No hay ningún proyecto abierto en Research.',
  invalid_code: 'Código incorrecto o caducado: pide uno nuevo en Research.',
  invalid_origin: 'Research no reconoce esta extensión.',
  rejected: 'La vinculación se rechazó en Research.',
  timeout: 'No se confirmó la vinculación en Research a tiempo: inténtalo de nuevo.',
  busy: 'Research ya está esperando que confirmes otra vinculación.',
  rate_limited: 'Demasiados intentos: espera un minuto y vuelve a probar.',
  restricted: 'El navegador no deja leer esta página (páginas internas o tiendas de extensiones).',
  unreadable_page: 'Research no pudo leer esta página.',
  too_large: 'La página es demasiado grande para enviarla a Research.',
  not_a_pdf: 'El archivo no es un PDF válido.',
  unreadable_pdf: 'Research no pudo leer el PDF.',
  capture_no_pdf: 'No se pudo obtener un PDF de esta página.',
  pdf_permission: 'Para descargar el PDF hace falta permiso para este sitio. Vuelve a pulsar «Agregar» y acéptalo.',
  mismatch: 'Esta página no es la de ese artículo de la biblioteca.',
  not_found: 'No se encontró: quizá ya no está en la biblioteca o el identificador no existe.',
  invalid: 'Research rechazó los datos de la página.',
  invalid_identifier: 'Ese identificador no es válido.',
  network: 'Research no pudo conectarse para completar los datos. Revisa la conexión.',
  site_blocked: 'El sitio no deja que Research descargue la página; prueba agregarla desde el sitio del artículo.',
  access_denied: 'El sitio rechazó el acceso a Research.',
  server_error: 'Un servicio externo falló; inténtalo más tarde.',
  file_problem: 'Research no pudo escribir en el proyecto.',
  still_running: 'Research sigue trabajando en ello: míralo en Actividad.',
  failed: 'Algo falló en Research.'
}

export function errorMessage(code: string): string {
  return MESSAGES[code] ?? `Algo falló (${code}).`
}

/** Short wording for the outcome of a finished capture. */
export function outcomeMessage(outcome: string | null, key: string): string {
  switch (outcome) {
    case 'merged':
      return `Ya estaba en tu biblioteca: se completó ${key}.`
    case 'duplicate':
      return `Ya estaba en tu biblioteca como ${key}.`
    case 'pdf_updated':
      return `PDF de ${key} actualizado.`
    default:
      return `Agregado como ${key}.`
  }
}
