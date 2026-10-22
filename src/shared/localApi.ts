/** The local API: an MCP server on 127.0.0.1 that editors (Emacs) call with a bearer token. */

/** Fixed so an editor's configuration keeps working across launches; Settings can change it. */
export const DEFAULT_API_PORT = 47_823
/** Unprivileged ports only. */
export const API_PORTS = { min: 1024, max: 65_535 } as const

/** Why the server is not listening although it is on. */
export const API_START_ERRORS = ['port_in_use', 'start_failed'] as const
export type ApiStartError = (typeof API_START_ERRORS)[number]

/** What Settings → Aplicación → «API local» shows. The token never leaves the main process (it copies it itself). */
export interface LocalApiStatus {
  enabled: boolean
  /** Listening now. */
  running: boolean
  port: number
  /** The MCP endpoint while listening. */
  url: string | null
  allowCostly: boolean
  /** Where the connection file ({url, token}) is written. */
  file: string
  error: ApiStartError | null
}

/** `open_in_app`: the paper to show, at a page, with a quote highlighted. */
export interface ApiOpenPaper {
  paper: string
  page: number | null
  quote: string | null
}
