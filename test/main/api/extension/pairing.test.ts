import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionPairing, newPairingCode, normalizeCode, PAIRING_ATTEMPTS_PER_MINUTE, PAIRING_WRONG_CODES } from '../../../../src/main/api/extension/pairing'
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, type PairingRequest } from '../../../../src/shared/extension'
import { tmpDir } from '../../../helpers/tmp'

const FIREFOX = 'moz-extension://0b5c4a8e-6a43-4d7e-9d0f-6f1b0c6f2a11'
const CHROME = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

async function setup(opts: { answer?: boolean | 'never'; timeoutMs?: number } = {}) {
  const dir = await tmpDir()
  let clock = 1_000_000
  const asked: PairingRequest[] = []
  const settled: string[] = []
  const pairing: ExtensionPairing = new ExtensionPairing({
    file: join(dir, 'extensions.json'),
    now: () => clock,
    confirmTimeoutMs: opts.timeoutMs ?? 1000,
    ask: (request) => {
      asked.push(request)
      const answer = opts.answer ?? true
      if (answer !== 'never') queueMicrotask(() => pairing.answer(request.id, answer))
    },
    settled: (id) => void settled.push(id)
  })
  await pairing.load()
  return { dir, pairing, asked, settled, tick: (ms: number) => (clock += ms) }
}

const failure = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code ?? 'unknown'
  )

describe('pairing codes', () => {
  it('are 8 characters of the unambiguous alphabet, typed in any case and with dashes', () => {
    const code = newPairingCode()
    expect(code).toHaveLength(PAIRING_CODE_LENGTH)
    expect([...code].every((c) => PAIRING_CODE_ALPHABET.includes(c))).toBe(true)
    expect(normalizeCode('acde-fghj ')).toBe('ACDEFGHJ')
  })
})

describe('ExtensionPairing', () => {
  it('pairs with a valid code only after the window accepts, and binds the token to the origin', async () => {
    const { pairing, asked, settled } = await setup()
    const { code } = pairing.start()
    const { token, extension } = await pairing.pair({ code: code.toLowerCase(), origin: FIREFOX })
    expect(asked).toEqual([{ id: expect.any(String), browser: 'firefox', origin: FIREFOX }])
    expect(settled).toEqual([asked[0]!.id])
    expect(extension).toMatchObject({ browser: 'firefox', origin: FIREFOX, lastUsedAt: null })
    expect(pairing.authenticate(FIREFOX, `Bearer ${token}`)).toMatchObject({ id: extension.id })
    // The same token from another extension, or without the Bearer scheme, is refused.
    expect(pairing.authenticate(CHROME, `Bearer ${token}`)).toBeNull()
    expect(pairing.authenticate(undefined, `Bearer ${token}`)).toBeNull()
    expect(pairing.authenticate(FIREFOX, token)).toBeNull()
    expect(pairing.isPaired(FIREFOX)).toBe(true)
    expect(pairing.isPaired(CHROME)).toBe(false)
    expect(pairing.currentCode()).toBeNull()
  })

  it('keeps only the hash of the token, in a file only the user can read', async () => {
    const { pairing, dir } = await setup()
    const { token } = await pairing.pair({ code: pairing.start().code, origin: CHROME })
    const file = join(dir, 'extensions.json')
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain(token)
    expect(text).toContain(CHROME)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    // A new instance (the next launch) reads it back.
    const again = new ExtensionPairing({ file, ask: () => undefined })
    await again.load()
    expect(again.authenticate(CHROME, `Bearer ${token}`)).not.toBeNull()
  })

  it('needs the user to accept: a rejection or no answer issues no token', async () => {
    const rejected = await setup({ answer: false })
    expect(await failure(rejected.pairing.pair({ code: rejected.pairing.start().code, origin: FIREFOX }))).toBe('rejected')
    expect(rejected.pairing.list()).toEqual([])
    const ignored = await setup({ answer: 'never', timeoutMs: 20 })
    expect(await failure(ignored.pairing.pair({ code: ignored.pairing.start().code, origin: FIREFOX }))).toBe('timeout')
    expect(ignored.pairing.list()).toEqual([])
    expect(ignored.pairing.pendingRequest()).toBeNull()
  })

  it('uses a code once, whatever the answer', async () => {
    const { pairing } = await setup({ answer: false })
    const { code } = pairing.start()
    expect(await failure(pairing.pair({ code, origin: FIREFOX }))).toBe('rejected')
    expect(await failure(pairing.pair({ code, origin: FIREFOX }))).toBe('invalid_code')
  })

  it('refuses an expired code, a wrong one, and drops the code after too many wrong tries', async () => {
    const expired = await setup()
    const { code } = expired.pairing.start()
    expired.tick(PAIRING_CODE_TTL_MS + 1)
    expect(await failure(expired.pairing.pair({ code, origin: FIREFOX }))).toBe('invalid_code')
    expect(expired.pairing.currentCode()).toBeNull()

    const guessed = await setup()
    const right = guessed.pairing.start().code
    const wrong = right === 'AAAAAAAA' ? 'CCCCCCCC' : 'AAAAAAAA'
    for (let i = 0; i < PAIRING_WRONG_CODES; i++) expect(await failure(guessed.pairing.pair({ code: wrong, origin: FIREFOX }))).toBe('invalid_code')
    expect(guessed.pairing.currentCode()).toBeNull()
    expect(await failure(guessed.pairing.pair({ code: right, origin: FIREFOX }))).toBe('invalid_code')
    expect(guessed.asked).toEqual([])
  })

  it('accepts only an extension origin, and asks nothing for any other', async () => {
    const { pairing, asked } = await setup()
    const { code } = pairing.start()
    for (const origin of [undefined, 'null', 'http://127.0.0.1:47823', 'https://evil.example', 'moz-extension://not-a-uuid', 'chrome-extension://ABC']) {
      expect(await failure(pairing.pair({ code, origin }))).toBe('invalid_origin')
    }
    expect(asked).toEqual([])
    // The code survived those: the real extension still pairs with it.
    expect((await pairing.pair({ code, origin: FIREFOX })).token).toBeTruthy()
  })

  it('rate-limits pairing attempts, and recovers after a minute', async () => {
    const { pairing, tick } = await setup()
    for (let i = 0; i < PAIRING_ATTEMPTS_PER_MINUTE; i++) await failure(pairing.pair({ code: 'X', origin: 'https://evil.example' }))
    const { code } = pairing.start()
    expect(await failure(pairing.pair({ code, origin: FIREFOX }))).toBe('rate_limited')
    tick(60_001)
    expect((await pairing.pair({ code, origin: FIREFOX })).token).toBeTruthy()
  })

  it('asks one question at a time', async () => {
    const { pairing, asked } = await setup({ answer: 'never', timeoutMs: 200 })
    const first = pairing.pair({ code: pairing.start().code, origin: FIREFOX })
    await Promise.resolve()
    expect(await failure(pairing.pair({ code: pairing.start().code, origin: CHROME }))).toBe('busy')
    pairing.answer(asked[0]!.id, true)
    expect((await first).extension.origin).toBe(FIREFOX)
  })

  it('ignores an answer for another request', async () => {
    const { pairing, asked } = await setup({ answer: 'never', timeoutMs: 50 })
    const pending = failure(pairing.pair({ code: pairing.start().code, origin: FIREFOX }))
    await Promise.resolve()
    pairing.answer('00000000-0000-0000-0000-000000000000', true)
    expect(pairing.pendingRequest()).toEqual(asked[0])
    expect(await pending).toBe('timeout')
  })

  it('revokes at once, and pairing the same extension again replaces its token', async () => {
    const { pairing } = await setup()
    const first = await pairing.pair({ code: pairing.start().code, origin: FIREFOX })
    const second = await pairing.pair({ code: pairing.start().code, origin: FIREFOX })
    expect(pairing.list()).toHaveLength(1)
    expect(pairing.authenticate(FIREFOX, `Bearer ${first.token}`)).toBeNull()
    expect(pairing.authenticate(FIREFOX, `Bearer ${second.token}`)).not.toBeNull()
    await pairing.revoke(second.extension.id)
    expect(pairing.authenticate(FIREFOX, `Bearer ${second.token}`)).toBeNull()
    expect(pairing.isPaired(FIREFOX)).toBe(false)
  })

  it('ignores a damaged or hand-edited file', async () => {
    const dir = await tmpDir()
    const file = join(dir, 'extensions.json')
    await writeFile(file, JSON.stringify({ extensions: [{ id: 'x', browser: 'firefox', origin: 'https://evil.example', tokenHash: 'a'.repeat(64), createdAt: '', lastUsedAt: null }] }))
    const pairing = new ExtensionPairing({ file, ask: () => undefined })
    await pairing.load()
    expect(pairing.list()).toEqual([])
  })
})
