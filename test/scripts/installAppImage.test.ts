import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { arch } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmpDir } from '../helpers/tmp'

const SCRIPT = resolve(__dirname, '../../scripts/install-appimage.sh')

const has = (tool: string): boolean => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0
const supported = process.platform === 'linux' && arch() === 'x64' && has('bash') && has('curl') && has('sha256sum')

/**
 * A stand-in AppImage: a shell script. Asked to extract the icons (as the install script does), it writes one into
 * ./squashfs-root like the real runtime, unless `extracts` is false.
 */
const fakeAppImage = (label: string, extracts = true): string =>
  [
    '#!/bin/sh',
    `# ${label}`,
    extracts
      ? 'if [ "$1" = --appimage-extract ]; then mkdir -p squashfs-root/resources/resources/icons && printf icon16 > squashfs-root/resources/resources/icons/icon-16.png; fi'
      : 'exit 1',
    ''
  ].join('\n')

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface Release {
  tag: string
  appImage?: string
  /** The .sha256 file's text; by default the right checksum in sha256sum's format. */
  checksum?: string
}

/** A fake releases server on disk: <root>/download/<tag>/<files> and <root>/api/releases/latest. */
async function releases(list: Release[], latest?: string): Promise<{ base: string; api: string }> {
  const root = await tmpDir()
  for (const r of list) {
    const name = `research-${r.tag.slice(1)}-x86_64.AppImage`
    const dir = join(root, 'download', r.tag)
    await mkdir(dir, { recursive: true })
    const body = r.appImage ?? fakeAppImage(r.tag)
    await writeFile(join(dir, name), body)
    await writeFile(join(dir, `${name}.sha256`), r.checksum ?? `${sha256(body)}  ${name}\n`)
  }
  if (latest) {
    await mkdir(join(root, 'api', 'releases'), { recursive: true })
    await writeFile(join(root, 'api', 'releases', 'latest'), JSON.stringify({ tag_name: latest, name: latest, draft: false }, null, 2))
  }
  return { base: pathToFileURL(join(root, 'download')).href, api: pathToFileURL(join(root, 'api')).href }
}

/** Runs the script with a temporary HOME; any https request would go to a dead proxy (the tests never reach the network). */
function install(home: string, args: string[], server?: { base: string; api: string }): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    RESEARCH_RELEASE_BASE: server?.base ?? 'file:///nonexistent/download',
    RESEARCH_RELEASE_API: server?.api ?? 'file:///nonexistent/api'
  }
  const run = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const installed = (home: string): string => join(home, 'Applications', 'research.AppImage')

describe.skipIf(!supported)('scripts/install-appimage.sh', () => {
  it('downloads a given release, checks its SHA-256 and installs it with the launcher and the icon', async () => {
    const home = await tmpDir()
    const server = await releases([{ tag: 'v1.2.3' }])
    const run = install(home, ['--release', 'v1.2.3'], server)
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Checksum OK')
    expect(run.stdout).toContain('Installed v1.2.3')
    expect(await readFile(installed(home), 'utf8')).toBe(fakeAppImage('v1.2.3'))
    expect((await stat(installed(home))).mode & 0o777).toBe(0o755)
    const launcher = await readFile(join(home, '.local/share/applications/research.desktop'), 'utf8')
    expect(launcher).toContain(`Exec="${installed(home)}"`)
    expect(launcher).toContain('Icon=research')
    // The icon comes out of the AppImage itself.
    expect(await readFile(join(home, '.local/share/icons/hicolor/16x16/apps/research.png'), 'utf8')).toBe('icon16')
  })

  it('accepts a version without the v', async () => {
    const home = await tmpDir()
    const run = install(home, ['--release', '1.2.3'], await releases([{ tag: 'v1.2.3' }]))
    expect(run.status).toBe(0)
    expect(await readFile(installed(home), 'utf8')).toBe(fakeAppImage('v1.2.3'))
  })

  it('installs the latest release when no version is given, replacing the installed copy', async () => {
    const home = await tmpDir()
    await mkdir(join(home, 'Applications'))
    await writeFile(installed(home), 'old')
    const run = install(home, ['--release'], await releases([{ tag: 'v1.0.0' }, { tag: 'v1.1.0' }], 'v1.1.0'))
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Installed v1.1.0')
    expect(await readFile(installed(home), 'utf8')).toBe(fakeAppImage('v1.1.0'))
  })

  it('installs nothing when the checksum does not match', async () => {
    const home = await tmpDir()
    const run = install(home, ['--release', 'v1.2.3'], await releases([{ tag: 'v1.2.3', checksum: `${sha256('something else')}  research-1.2.3-x86_64.AppImage\n` }]))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Checksum mismatch')
    expect(existsSync(installed(home))).toBe(false)
    expect(existsSync(join(home, '.local/share/applications/research.desktop'))).toBe(false)
  })

  it('refuses a checksum file without a checksum', async () => {
    const home = await tmpDir()
    const run = install(home, ['--release', 'v1.2.3'], await releases([{ tag: 'v1.2.3', checksum: '<html>Not Found</html>\n' }]))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('does not hold a SHA-256 checksum')
    expect(existsSync(installed(home))).toBe(false)
  })

  it('fails clearly on a missing release, a bad tag or no published release', async () => {
    const home = await tmpDir()
    const server = await releases([{ tag: 'v1.2.3' }])
    const missing = install(home, ['--release', 'v9.9.9'], server)
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('does release v9.9.9 exist?')
    const bad = install(home, ['--release', 'v1.2.3;rm'], server)
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('Not a release tag')
    const none = install(home, ['--release'], server)
    expect(none.status).not.toBe(0)
    expect(none.stderr).toContain('Could not ask GitHub for the latest release')
    expect(existsSync(installed(home))).toBe(false)
  })

  it('still installs a local AppImage by default, with the checkout icons when the AppImage gives none', async () => {
    const home = await tmpDir()
    const local = join(await tmpDir(), 'research-0.1.0-x86_64.AppImage')
    await writeFile(local, fakeAppImage('local', false))
    await chmod(local, 0o644)
    const run = install(home, [local])
    expect(run.status).toBe(0)
    expect(await readFile(installed(home), 'utf8')).toBe(fakeAppImage('local', false))
    expect(existsSync(join(home, '.local/share/icons/hicolor/512x512/apps/research.png'))).toBe(true)
    expect(run.stdout).toContain('pnpm dist')
  })

  it('rejects a path together with --release, and unknown options', async () => {
    const home = await tmpDir()
    expect(install(home, ['--release', 'v1.2.3', '/tmp/x.AppImage']).stderr).toContain("don't pass a path too")
    expect(install(home, ['--frobnicate']).stderr).toContain('Unknown option')
  })
})
