import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * index.html carries the strict CSP that ships. The dev server needs an inline script (React
 * Fast Refresh preamble) and a websocket (HMR), so only `pnpm dev` gets this relaxed variant.
 */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' ws://localhost:* http://localhost:*"

function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*/, `$1${DEV_CSP}`)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The embeddings utility process is a second entry: out/main/embeddings.js.
        input: { index: resolve(__dirname, 'src/main/index.ts'), embeddings: resolve(__dirname, 'src/main/embeddings/worker.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // The app's browser window has its own toolbar preload: out/preload/capture.js.
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), capture: resolve(__dirname, 'src/preload/capture.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()],
    build: {
      // capture.html: the toolbar of the app's browser window.
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), capture: resolve(__dirname, 'src/renderer/capture.html') } }
    }
  }
})
