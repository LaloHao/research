import type { RendererErrorReport } from '../../shared/ipc'

/** What an uncaught error of the window tells the app log: the error's name, message and stack, never more. */
export function errorReport(kind: RendererErrorReport['kind'], value: unknown, source: string | null = null): RendererErrorReport {
  if (value instanceof Error) return { kind, message: `${value.name}: ${value.message}`, stack: value.stack ?? null, source }
  return { kind, message: typeof value === 'string' ? value : safeString(value), stack: null, source }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return 'Unprintable error'
  }
}

/** Sends the window's uncaught errors and unhandled rejections to the main process's log. */
export function reportUncaughtErrors(target: Window, send: (report: RendererErrorReport) => void): void {
  const safeSend = (report: RendererErrorReport): void => {
    try {
      send(report)
    } catch {
      // Reporting must never throw again.
    }
  }
  target.addEventListener('error', (event) => {
    const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null
    safeSend(errorReport('error', event.error ?? event.message, source))
  })
  target.addEventListener('unhandledrejection', (event) => safeSend(errorReport('unhandledrejection', event.reason)))
}
