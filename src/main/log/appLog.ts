import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'

/**
 * The app's own log: what happened in the main process (start, projects, jobs, HTTP failures, crashes), for when
 * something goes wrong. It never holds secrets (every string is redacted) nor content: no paper text, abstracts,
 * notes or Claude prompts and answers, only ids, sizes, codes and the services' own error messages.
 */

export const LOG_FILE = 'main.log'
export const LOG_MAX_BYTES = 5 * 1024 * 1024
/** main.log plus main.1.log and main.2.log. */
export const LOG_FILES = 3
/** The longest string value a log entry keeps. */
const MAX_VALUE = 1000
/** Stacks are longer, but bounded too. */
const MAX_STACK = 4000

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

export interface LogSink {
  write(line: string): void
}

const SECRET_PARAMS =
  'api_key|apikey|api-key|mailto|email|token|access_token|accesstoken|refresh_token|id_token|key|password|passwd|pwd|secret|client_secret|clientsecret|signature|sig|auth|code'

/** A secret-looking name followed by `:` or `=` (`API key: …`, `"accessToken":"…"`, `client_secret=…`, `Password = "…"`). */
const NAMED_SECRET =
  /((?:access|refresh|id|auth|bearer|session)?[_-]?token|client[_-]?secret|secret|api[ _-]?key|private[_-]?key|password|passwd|pwd)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',&;}]+)/gi

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Credentials inside a URL (https://user:password@host, https://token@host).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1redacted@'],
  // Secret parameters of a query or a fragment (?api_key=…&mailto=…, #access_token=…).
  [new RegExp(`([?&;#](?:${SECRET_PARAMS})=)[^&#\\s"']*`, 'gi'), '$1redacted'],
  // An Authorization header, as text or JSON.
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;}]+/gi, '$1redacted'],
  [/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer redacted'],
  // Known token shapes (Anthropic, OpenAI-style sk-/sk-proj-, GitHub, GitLab, Slack).
  [/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]+|glpat-[a-z0-9_-]{16,}|xox[abprs]-[a-z0-9-]{10,})/gi, '[token]'],
  // `password=…`, `API key: …`, `"accessToken":"…"` and the like outside a URL; a quoted value is replaced whole.
  [
    NAMED_SECRET,
    (_m: string, name: string, sep: string, value: string) => {
      if (/^["']?redacted["']?$/i.test(value) || value === '[token]') return `${name}${sep}${value}`
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      return `${name}${sep}${quote}redacted${quote}`
    }
  ],
  // The contact email in a User-Agent, then any other email address.
  [/mailto:[^\s)"'>]+/gi, 'mailto:redacted'],
  [/(?<![a-z0-9._%+-])(?!redacted(?:@|%40))[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]']
]

/** The secrets the app holds (API keys, the contact email), replaced literally before any pattern runs. */
let knownSecrets: string[] = []

/** Shorter values would replace ordinary words. */
const MIN_SECRET = 6

/** Registers the app's own secrets (and their URL-encoded forms) for `redact`; replaces the previous list. */
export function setLogSecrets(values: readonly (string | null | undefined)[]): void {
  const all = new Set<string>()
  for (const raw of values) {
    const value = raw?.trim()
    if (!value || value.length < MIN_SECRET) continue
    all.add(value)
    all.add(encodeURIComponent(value))
  }
  knownSecrets = [...all].sort((a, b) => b.length - a.length)
}

/** Replaces each of `secrets` (exact text, any case) with `[secret]`. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret) continue
    out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[secret]')
  }
  return out
}

/** Removes the app's known secrets, then API keys, emails, tokens, Authorization headers and passwords by their shape. */
export function redact(text: string): string {
  let out = scrubSecrets(text, knownSecrets)
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as string)
  return out
}

const bound = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

function clean(value: unknown, depth = 0, key = ''): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value ?? null
  if (typeof value === 'string') return bound(redact(value), key === 'stack' ? MAX_STACK : MAX_VALUE)
  if (typeof value === 'function') return '[function]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = { error: bound(redact(`${value.name}: ${value.message}`), MAX_VALUE) }
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') out.code = code
    if (value.stack) out.stack = bound(redact(value.stack), MAX_STACK)
    return out
  }
  if (depth >= 2) return '[object]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, clean(v, depth + 1, k)]))
  return bound(redact(String(value)), MAX_VALUE)
}

/** `<iso> <LEVEL> <event> <fields as JSON>`, one line, every string redacted and bounded. */
export function formatEntry(at: string, level: LogLevel, event: string, fields: LogFields = {}): string {
  const json = JSON.stringify(clean(fields)) ?? '{}'
  return `${at} ${level.toUpperCase()} ${event} ${json}\n`
}

/** Appends to `<dir>/main.log`; past `maxBytes` it becomes main.1.log (main.1 → main.2 …), keeping `files` files. */
export class RotatingFileSink implements LogSink {
  private size: number | null = null
  private readonly maxBytes: number
  private readonly files: number

  constructor(
    readonly dir: string,
    opts: { maxBytes?: number; files?: number } = {}
  ) {
    this.maxBytes = opts.maxBytes ?? LOG_MAX_BYTES
    this.files = Math.max(1, opts.files ?? LOG_FILES)
  }

  write(line: string): void {
    // Logging must never break what it logs.
    try {
      const bytes = Buffer.byteLength(line)
      if (this.size === null) {
        mkdirSync(this.dir, { recursive: true })
        this.size = fileSize(this.path(0))
      }
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
      appendFileSync(this.path(0), line)
      this.size += bytes
    } catch {
      this.size = null
    }
  }

  private path(n: number): string {
    return join(this.dir, n === 0 ? LOG_FILE : `main.${n}.log`)
  }

  private rotate(): void {
    rmSync(this.path(this.files - 1), { force: true })
    for (let n = this.files - 2; n >= 0; n--) {
      try {
        renameSync(this.path(n), this.path(n + 1))
      } catch {
        // A missing older file is fine.
      }
    }
    this.size = 0
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Keeps the lines in memory (tests). */
export class MemorySink implements LogSink {
  readonly lines: string[] = []
  write(line: string): void {
    this.lines.push(line)
  }
}

export class AppLog {
  private sink: LogSink | null = null
  private dir: string | null = null

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  setSink(sink: LogSink | null): void {
    this.sink = sink
    this.dir = sink instanceof RotatingFileSink ? sink.dir : null
  }

  /** The folder of main.log, when the log writes to files. */
  directory(): string | null {
    return this.dir
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields)
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields)
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields)
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (!this.sink) return
    try {
      this.sink.write(formatEntry(this.now(), level, event, fields))
    } catch {
      // Never let the log break the app.
    }
  }
}

/** The process-wide log; it writes nothing until `index.ts` gives it a file (tests give it a MemorySink). */
export const appLog = new AppLog()

/** What a job's log entries say about it: its type and ids (and sizes), never a path, a search string or content. */
export function jobFields(spec: JobSpec): LogFields {
  const out: LogFields = { type: spec.type }
  if ('paperId' in spec) out.paperId = spec.paperId
  if ('mappingId' in spec) out.mappingId = spec.mappingId
  if ('recordId' in spec) out.recordId = spec.recordId
  if ('batchId' in spec && spec.batchId) out.batchId = spec.batchId
  if ('model' in spec && spec.model) out.model = spec.model
  if (spec.type === 'mapping_search') {
    out.queryChars = spec.query.length
    out.cap = spec.cap
  }
  if (spec.type === 'mapping_snowball') out.direction = spec.direction
  if (spec.type === 'screen_suggest') out.records = spec.recordIds.length
  return out
}

/** At most `limit` renderer errors per `windowMs`: a render loop throwing on every frame must not fill the log. */
export class RendererErrorGate {
  private start = -Infinity
  private count = 0
  private dropped = 0

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  allow(): boolean {
    const now = this.now()
    if (now - this.start > this.windowMs) {
      this.start = now
      this.count = 0
    }
    if (this.count >= this.limit) {
      this.dropped++
      return false
    }
    this.count++
    return true
  }

  /** How many were dropped since the last call. */
  takeDropped(): number {
    const n = this.dropped
    this.dropped = 0
    return n
  }
}
