import { parseInput } from '../ingest/identifiers'

/** What the tray does with the clipboard's text: «Agregar desde el portapapeles» or «Abrir en el navegador de la app». */
export type ClipboardAction = { kind: 'add'; input: string } | { kind: 'browse'; url: string } | { kind: 'none' }

/** Longer than any identifier or address worth adding: a copied paragraph is not one. */
const MAX_CLIPBOARD_CHARS = 4000

/**
 * `add`: a DOI, an arXiv or OpenAlex id, or an http(s) address, as the «Agregar» box accepts them (`parseInput`).
 * `browse`: an http(s) address only. Anything else (empty, several lines, plain text) is `none`.
 */
export function clipboardAction(text: string, mode: 'add' | 'browse'): ClipboardAction {
  const value = text.trim()
  if (!value || value.length > MAX_CLIPBOARD_CHARS || /\s/.test(value.replace(/^doi:\s*|^arxiv:\s*/i, ''))) return { kind: 'none' }
  if (mode === 'add') return parseInput(value).kind === 'invalid' ? { kind: 'none' } : { kind: 'add', input: value }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'browse', url: value } : { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}
