# Research Connector (browser extension)

One click adds the page open in your own browser to the Research desktop app, with your browser's session: the logins,
institutional access and bot checks you already passed there. Works in Firefox 142 or later and
Chrome/Chromium 116 or later, from one Manifest V3 codebase. The UI is in Spanish, like the app.

What it does on a page:

- **Article with a DOI or arXiv id** (Highwire `citation_*`, Dublin Core, PRISM tags, a doi.org or arxiv.org address):
  the app adds it through that identifier, like «Agregar». If the page links its PDF (`citation_pdf_url`), the
  extension downloads it with your session and the app attaches it.
- **PDF tab**: the PDF is downloaded with your session and added like a dropped PDF (its DOI or arXiv id read from its
  first pages).
- **Any other page** (a blog post, a report): the page's HTML and the article's images (fetched by the page itself, with
  its cookies) go to the app, which builds the paper exactly like its own browser's capture: the readable text and the
  reader-view PDF, with those images embedded.
- **Already in the library** (same DOI, arXiv id or address): the popup says «Ya está en tu biblioteca como `<clave>`»
  and offers «Actualizar PDF» (replaces that paper's PDF, as «Volver a capturar desde la web» does) and «Abrir en
  Research».

The toolbar button opens the popup. **Alt+Shift+R** adds the current tab without opening it (the icon shows `✓`, `=`
when it was already in the library, or `!`, with the message in its tooltip); change it in `about:addons` → gear →
«Manage Extension Shortcuts» (Firefox) or `chrome://extensions/shortcuts`.

## Build

From the repository root (Node 24, `pnpm install` done):

```sh
pnpm ext:build     # extension/dist/firefox and extension/dist/chrome
pnpm ext:package   # also extension/dist/research-connector-{firefox,chrome}-<version>.zip
pnpm ext:lint      # build, then `web-ext lint` on the Firefox build
```

The version is the app's (`package.json`). The sources are in `extension/src` (TypeScript, bundled by esbuild); the
manifest for each browser comes from `extension/manifest.ts`; unit tests are in `test/extension` and run with
`pnpm test`.

## Set up the app

1. In Research: Ajustes → Aplicación → «API local» on (the extension talks to it; default port 47823).
2. Ajustes → Aplicación → «Extensión del navegador» → «Vincular extensión»: a code like `ACDE-FGHJ` appears, valid for
   five minutes and only once.
3. In the extension's options (opened from the popup's «Opciones», or the add-on's preferences), type the code and press
   «Vincular». Research comes to the front and asks «¿Vincular la extensión de Firefox?»: press «Aceptar».
4. «Probar conexión» should say «Conectada con Research … proyecto «…»».

If you changed the API's port in Research, set the same address in the options («Dirección de la API local»; only
`http://127.0.0.1:<port>` or `http://localhost:<port>` are accepted).

## Install in Chrome / Chromium

1. `pnpm ext:build`.
2. Open `chrome://extensions`, turn on «Developer mode», «Load unpacked», and choose `extension/dist/chrome`.
3. Pin «Research Connector» to the toolbar and pair it (above).

After a rebuild, press the reload button on its card in `chrome://extensions`.

## Install in Firefox

### For a session (testing)

1. `pnpm ext:build`.
2. Open `about:debugging#/runtime/this-firefox` → «Load Temporary Add-on…» and choose
   `extension/dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox closes; load and pair it again in the next session.

### Permanently (signed, unlisted)

Release Firefox only installs add-ons signed by Mozilla. An **unlisted** signature is automatic and private: the add-on
is not published on addons.mozilla.org, you just get a signed `.xpi`.

1. Create API credentials (once) at <https://addons.mozilla.org/developers/addon/api/key/> while logged in to your
   Mozilla account: a «JWT issuer» and a «JWT secret».
2. Build and sign (each signature needs a new version: bump `version` in `package.json` first if this version was
   signed already):

   ```sh
   pnpm ext:build
   pnpm exec web-ext sign --channel=unlisted \
     --source-dir extension/dist/firefox --artifacts-dir extension/dist \
     --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET"
   ```

3. Install the `.xpi` it writes to `extension/dist`: `about:addons` → gear → «Install Add-on From File…», or drag it
   onto a Firefox window.
4. Pair it (above). The add-on's id (`research-connector@lalohao`) stays the same, so installing a newer signed `.xpi`
   updates it in place; its internal address, and so its pairing, are kept.

## Permissions

- `activeTab` and `scripting`: the page is read only when you click the button or press the shortcut, in that tab, by a
  script injected at that moment into the extension's isolated world (the page's scripts can't see it). There is no
  content script on every page and no host permission at install.
- `storage`: the API address and the extension's token, in this browser profile's extension storage.
- Optional host access, asked at run time **for one site** (`https://that.site/*`), only when a PDF has to be downloaded
  and the page itself can't hand it over (a PDF tab in Firefox's PDF viewer, or a PDF on another site than the page).
  Firefox may close the popup while it asks: accept and press «Agregar» again.

## Threat model

What it protects:

- **Your library from other local programs and web pages.** The app's capture endpoints (`/ext/v1/*` on the local API,
  127.0.0.1 only) accept a request only with the extension's token *and* from the extension origin it was issued to
  (`moz-extension://<uuid>` / `chrome-extension://<id>`); CORS is answered only for paired extension origins and only on
  those endpoints. The rest of the local API (the editor's MCP endpoint) keeps refusing any foreign origin, and the
  editor's token does not work on the extension endpoints, nor the extension's on the editor's.
- **Pairing.** A code is shown only in the app, valid five minutes and once; it dies after five wrong tries, and the
  pairing endpoint accepts ten attempts a minute. Even with the right code, nothing is paired until you press «Aceptar»
  in the app's window, which shows the browser and the extension's origin: a program that read the code off your screen
  still can't pair silently. The app keeps only a SHA-256 hash of the token (`extensions.json` in its data folder,
  mode 0600); Ajustes → Aplicación lists paired extensions with «Revocar», effective at once.
- **Narrow scope.** The extension's token can look up whether a page is in the library, add a page or an identifier,
  replace the PDF of *the paper that page is* (the app checks the key against the page's DOI, arXiv id or address), poll
  its captures and bring the app's window to a paper. It can't read the library, run anything that costs Claude quota,
  or reach the editor's tools.
- **The page's content is untrusted.** Its HTML is only parsed in the app (Readability, then the same sanitizer as the
  in-app browser's reader view: no scripts, styles, frames, forms or event handlers); the reader PDF is printed in a
  hidden window without JavaScript whose session refuses every request. Images are accepted only as PNG, JPEG, GIF,
  WebP or AVIF by their bytes (never SVG), at most 40, 5 MB each and 30 MB together; the PDF must start like a PDF
  (at most 100 MB); the HTML at most 10 MB. Anything larger or malformed is refused, not cut.
- **Where data goes.** The extension sends data only to the API address in its options, which must be
  `127.0.0.1`/`localhost`. No analytics, no other server. It reads a page only when you ask, and what it reads is the
  page you are looking at.

What it doesn't protect against: a program running as your user can read the browser profile (and the token in it) or
the app's files; the local API's design assumes that user is you. The extension sees the pages you capture with your
session, so anything on them (including personal data in a logged-in page) ends up in the paper's text and PDF, as with
the in-app browser.
