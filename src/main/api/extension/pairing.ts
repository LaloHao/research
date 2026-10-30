import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  browserOfOrigin,
  isExtensionOrigin,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_CONFIRM_TIMEOUT_MS,
  type PairedExtension,
  type PairingCode,
  type PairingRequest
} from '../../../shared/extension'

export const EXTENSIONS_FILE = 'extensions.json'

/** Pairing attempts accepted per minute, whatever their origin; past that the endpoint answers `rate_limited`. */
export const PAIRING_ATTEMPTS_PER_MINUTE = 10
/** Wrong codes a shown code survives; then it is dropped and Settings must show a new one. */
export const PAIRING_WRONG_CODES = 5

export type PairingFailure = 'invalid_origin' | 'invalid_code' | 'rate_limited' | 'rejected' | 'timeout' | 'busy'

export class PairingError extends Error {
  constructor(readonly code: PairingFailure) {
    super(code)
    this.name = 'PairingError'
  }
}

interface StoredExtension extends PairedExtension {
  /** sha256 of the token, hex. */
  tokenHash: string
}

export interface PairingDeps {
  /** `<userData>/extensions.json` (0600). */
  file: string
  /** Shows «¿Vincular la extensión…?» in the window; the answer comes back through `answer`. */
  ask: (request: PairingRequest) => void
  /** The request was answered or dropped: the window hides its question. */
  settled?: (id: string) => void
  /** The list or the code changed (Settings refreshes). */
  changed?: () => void
  now?: () => number
  confirmTimeoutMs?: number
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A code as the user may type it: case, spaces and dashes don't count. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]+/g, '')

export function newPairingCode(): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]
  return code
}

/**
 * Pairing the browser extension and checking its token. Settings shows a one-time code valid for five minutes; the
 * extension sends it with its own origin; the window then asks «¿Vincular la extensión…?» and only «Aceptar» issues a
 * token, bound to that origin and good only for the capture endpoints. Only the token's hash is kept, in
 * extensions.json with the app's data (never in a project). A local process that guesses at codes is slowed down by a
 * global rate limit, and a code dies after a few wrong tries; even a right code pairs nothing without the user's click.
 */
export class ExtensionPairing {
  private code: { value: string; expiresAt: number; wrong: number } | null = null
  private attempts: number[] = []
  private pending: { request: PairingRequest; resolve: (accepted: boolean) => void } | null = null
  private paired: StoredExtension[] = []
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PairingDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.deps.file, 'utf8')) as { extensions?: unknown }
      const list = Array.isArray(raw.extensions) ? raw.extensions : []
      this.paired = list.filter(isStored)
    } catch {
      this.paired = []
    }
  }

  /** «Vincular extensión»: a fresh code (the previous one, if any, stops working). */
  start(): PairingCode {
    this.code = { value: newPairingCode(), expiresAt: this.now() + PAIRING_CODE_TTL_MS, wrong: 0 }
    this.deps.changed?.()
    return this.currentCode()!
  }

  cancel(): void {
    this.code = null
    this.deps.changed?.()
  }

  currentCode(): PairingCode | null {
    if (this.code && this.code.expiresAt <= this.now()) this.code = null
    return this.code ? { code: this.code.value, expiresAt: new Date(this.code.expiresAt).toISOString() } : null
  }

  list(): PairedExtension[] {
    return this.paired.map(({ tokenHash: _, ...rest }) => rest)
  }

  /** Whether a CORS preflight from `origin` is answered: only for an extension paired from it. */
  isPaired(origin: string | undefined): boolean {
    return isExtensionOrigin(origin) && this.paired.some((p) => p.origin === origin)
  }

  /** The paired extension a request comes from: its bearer token's hash and its Origin both match. */
  authenticate(origin: string | undefined, authorization: string | undefined): PairedExtension | null {
    if (!isExtensionOrigin(origin)) return null
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization ?? '')
    if (!match) return null
    const digest = hash(match[1])
    const found = this.paired.find((p) => p.origin === origin && sameText(p.tokenHash, digest))
    if (!found) return null
    const day = 24 * 60 * 60_000
    // «Último uso» needs no more than a day's precision: the file is not rewritten on every capture.
    if (!found.lastUsedAt || this.now() - Date.parse(found.lastUsedAt) > day) {
      found.lastUsedAt = new Date(this.now()).toISOString()
      void this.save().catch(() => undefined)
    }
    const { tokenHash: _, ...rest } = found
    return rest
  }

  /**
   * The extension's pairing request: a valid code (one time) from an extension origin, then the user's «Aceptar» in the
   * window. Resolves with the new token; rejects with a `PairingError`.
   */
  async pair(input: { code: string; origin: string | undefined }): Promise<{ token: string; extension: PairedExtension }> {
    const now = this.now()
    this.attempts = this.attempts.filter((t) => now - t < 60_000)
    if (this.attempts.length >= PAIRING_ATTEMPTS_PER_MINUTE) throw new PairingError('rate_limited')
    this.attempts.push(now)
    if (!isExtensionOrigin(input.origin)) throw new PairingError('invalid_origin')
    const origin = input.origin
    // One question at a time; the code stays good for when it is answered.
    if (this.pending) throw new PairingError('busy')
    const code = this.code
    if (!code || code.expiresAt <= now) {
      this.code = null
      throw new PairingError('invalid_code')
    }
    if (!sameText(normalizeCode(input.code), code.value)) {
      code.wrong += 1
      if (code.wrong >= PAIRING_WRONG_CODES) {
        this.code = null
        this.deps.changed?.()
      }
      throw new PairingError('invalid_code')
    }
    // One time: whatever the answer, this code is spent.
    this.code = null
    this.deps.changed?.()
    const accepted = await this.confirm({ id: randomUUID(), browser: browserOfOrigin(origin), origin })
    if (accepted === null) throw new PairingError('timeout')
    if (!accepted) throw new PairingError('rejected')
    const token = randomBytes(32).toString('base64url')
    const extension: PairedExtension = { id: randomUUID(), browser: browserOfOrigin(origin), origin, createdAt: new Date(this.now()).toISOString(), lastUsedAt: null }
    await this.serial(async () => {
      // Pairing the same extension again replaces its old token.
      this.paired = [...this.paired.filter((p) => p.origin !== origin), { ...extension, tokenHash: hash(token) }]
      await this.save()
    })
    this.deps.changed?.()
    return { token, extension }
  }

  /** The window's answer to `ask`; an unknown or stale id is ignored. */
  answer(id: string, accepted: boolean): void {
    if (this.pending?.request.id !== id) return
    this.pending.resolve(accepted)
  }

  /** The question the window should be showing now (a window reloaded meanwhile asks again). */
  pendingRequest(): PairingRequest | null {
    return this.pending?.request ?? null
  }

  /** «Revocar»: its token stops working at once. */
  async revoke(id: string): Promise<void> {
    await this.serial(async () => {
      this.paired = this.paired.filter((p) => p.id !== id)
      await this.save()
    })
    this.deps.changed?.()
  }

  /** Null on timeout. */
  private confirm(request: PairingRequest): Promise<boolean | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), this.deps.confirmTimeoutMs ?? PAIRING_CONFIRM_TIMEOUT_MS)
      const finish = (answer: boolean | null): void => {
        clearTimeout(timer)
        if (this.pending?.request.id === request.id) this.pending = null
        this.deps.settled?.(request.id)
        resolve(answer)
      }
      this.pending = { request, resolve: finish }
      this.deps.ask(request)
    })
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async save(): Promise<void> {
    const file = this.deps.file
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify({ extensions: this.paired }, null, 2)}\n`, { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
}

function isStored(value: unknown): value is StoredExtension {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    (v.browser === 'firefox' || v.browser === 'chrome') &&
    typeof v.origin === 'string' &&
    isExtensionOrigin(v.origin) &&
    typeof v.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(v.tokenHash) &&
    typeof v.createdAt === 'string' &&
    (v.lastUsedAt === null || typeof v.lastUsedAt === 'string')
  )
}
