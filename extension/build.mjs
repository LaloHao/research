#!/usr/bin/env node
// Builds the browser extension for Firefox and Chrome from one source: extension/dist/{firefox,chrome}, and with
// --zip the packages extension/dist/research-connector-<browser>-<version>.zip.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICONS, manifest } from './manifest.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const zip = process.argv.includes('--zip')

async function buildFor(browser) {
  const out = join(here, 'dist', browser)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'icons'), { recursive: true })
  await build({
    entryPoints: ['background', 'popup', 'options', 'content'].map((name) => join(here, 'src', `${name}.ts`)),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: browser === 'firefox' ? 'firefox142' : 'chrome116',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning'
  })
  cpSync(join(here, 'static'), out, { recursive: true })
  for (const size of Object.keys(ICONS)) cpSync(join(root, 'resources', 'icons', `icon-${size}.png`), join(out, 'icons', `icon-${size}.png`))
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest(browser, version), null, 2)}\n`)
  if (zip) {
    const name = `research-connector-${browser}-${version}.zip`
    const webExt = join(root, 'node_modules', '.bin', 'web-ext')
    execFileSync(webExt, ['build', '--source-dir', out, '--artifacts-dir', join(here, 'dist'), '--filename', name, '--overwrite-dest', '--no-input'], { stdio: 'ignore' })
    console.log(join(here, 'dist', name))
  } else {
    console.log(out)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const browser of ['firefox', 'chrome']) await buildFor(browser)
}
