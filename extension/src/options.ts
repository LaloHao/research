/**
 * The options page: pairing with the app (the one-time code from Settings, then «Aceptar» in the app's window), the
 * local API's address, «Probar conexión» and «Desvincular». The token is kept in this browser's extension storage.
 */
import { call, ConnectorError, DEFAULT_API_URL, normalizeApiUrl } from './api'
import { ext } from './browser'
import { errorMessage } from './errors'
import { connection } from './flow'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function say(id: string, text: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
  const node = $(id)
  node.textContent = text
  node.className = kind
}

const codeOf = (error: unknown): string => (error instanceof ConnectorError ? error.code : 'failed')

async function load(): Promise<void> {
  const conn = await connection()
  $<HTMLInputElement>('api-url').value = conn.apiUrl
  say('pair-status', conn.token ? 'Vinculada con Research.' : 'Todavía no está vinculada.', conn.token ? 'ok' : 'muted')
}

$('pair-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $<HTMLInputElement>('code')
  const code = input.value.trim()
  if (!code) return
  const submit = $<HTMLButtonElement>('pair')
  submit.disabled = true
  say('pair-status', 'Confirma en la ventana de Research…')
  void (async () => {
    try {
      const conn = await connection()
      const { token } = await call<{ token: string }>({ ...conn, token: null }, 'pair', { code })
      await ext().storage.local.set({ token })
      input.value = ''
      say('pair-status', 'Vinculada con Research.', 'ok')
    } catch (error) {
      say('pair-status', errorMessage(codeOf(error)), 'error')
    } finally {
      submit.disabled = false
    }
  })()
})

$('test').addEventListener('click', () => {
  say('test-status', 'Probando…')
  void (async () => {
    try {
      const res = await call<{ version: string; project: string | null }>(await connection(), 'ping', {})
      say('test-status', res.project ? `Conectada con Research ${res.version}: proyecto «${res.project}».` : `Conectada con Research ${res.version}, sin proyecto abierto.`, 'ok')
    } catch (error) {
      say('test-status', errorMessage(codeOf(error)), 'error')
    }
  })()
})

$('forget').addEventListener('click', () => {
  void ext()
    .storage.local.remove(['token'])
    .then(() => {
      say('pair-status', 'Desvinculada en este navegador. Para quitarle el acceso también en la app, revócala en Research (Ajustes → Aplicación).')
      say('test-status', '')
    })
})

$('url-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const raw = $<HTMLInputElement>('api-url').value || DEFAULT_API_URL
  const url = normalizeApiUrl(raw)
  if (!url) return say('url-status', 'Escribe una dirección de este equipo, como http://127.0.0.1:47823.', 'error')
  $<HTMLInputElement>('api-url').value = url
  void ext()
    .storage.local.set({ apiUrl: url })
    .then(() => say('url-status', 'Guardada.', 'ok'))
})

void load()
