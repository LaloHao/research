# research.el

Use the Research app's library from Emacs while you write: insert citations, check them, build the chapter's `.bib`,
insert the state-of-the-art outline, search passages in the papers' full text and open a cited paper in the app at its
page. Works in Org (org-cite), LaTeX and Markdown (pandoc) buffers.

It talks to the app's **local API**: an MCP server the app runs on `127.0.0.1` only, protected by a bearer token. Pure
Emacs Lisp (Emacs 29+), no dependencies: `url.el` and the native JSON parser.

## Enable the API in the app

1. In the app: **Ajustes → Aplicación → API local → Activar la API local**.
2. The app writes the connection file `api.json` (URL and token, readable by your user only) in its data folder: on
   Linux `~/.config/research/api.json`, which is what `research-api-file` points to by default.
3. **Copiar token** and **Regenerar token** are in the same section. Regenerating takes effect at once; the package
   reads the new token from `api.json` on the next call.

The API is off by default, listens only on `127.0.0.1` (port 47823 by default, configurable), and refuses requests
without the token or with a foreign `Host`/`Origin` header. With no project open, every command says so.

## Commands

| Command | Key (`research-mode`) | What it does |
| --- | --- | --- |
| `research-insert-citation` | `C-c r c` | Complete a library paper (key, title, year, authors; works with vertico/consult) and insert `[cite:@key]`, `\cite{key}` or `[@key]`. `C-u` refreshes the list. |
| `research-check-citations` | `C-c r k` | Check the buffer (or region): unknown keys, keys in the trash, keys repeated in a sentence and papers without indexed text show as Flymake diagnostics. |
| `research-bibtex-for-file` | `C-c r b` | Write a `.bib` next to the file with only the entries it cites (following `\input`, `\include`, `\subfile` and `#+INCLUDE` inside its folder). `C-u` asks where. Offers to add `#+bibliography:` and to add it to `citar-bibliography`. |
| `research-insert-outline` | `C-c r o` | Insert the app's outline (one section per facet value, papers with their one-liner, gaps). `C-u` asks for the facets, the research question and «only reviewed». |
| `research-find-passage` | `C-c r f` | Full-text search. In the results: `RET` inserts the quote with its citation and page at point, `o` opens the paper in the app, `n`/`p` move, `q` quits. |
| `research-open-citation-at-point` | `C-c r a` | Open the cited paper in the app, at the citation's page (`[cite:@key p. 12]`, `\cite[p.~12]{key}`, `[@key, p. 12]`). |

Commands that use Claude (they spend quota). Each one first asks the app for the estimated cost (and the caps and the
month's spending), shows it with `yes-or-no-p`, and runs only if you confirm. They also need **Permitir operaciones con
costo desde la API** in the app's settings (off by default). They are the app's own «Redacción» operations, with the
same checks and caps.

| Command | Key | What it does |
| --- | --- | --- |
| `research-check-citations-with-claude` | `C-c r v` | For the buffer (or region): whether each cited paper supports its sentence, as Flymake diagnostics on each citation with the paper's quote and page. Error: does not support, or its quote was not found in the paper; warning: partial support, or no passage found; note: supports (or could not be checked, with the reason). |
| `research-propose-outline` | `C-c r p` | Insert the outline with Claude's headings, order, openings and gap sentences; citations the app could not verify are marked in the text. `C-u` asks for the outline's choices. |
| `research-style-review` | `C-c r s` | Style suggestions for the buffer (or region), walked like `query-replace`: each one highlighted, `y` apply, `n` skip, `!` apply this and the rest, `q` stop. Applied at the end, from the last one; refused if the text changed while waiting. Suggestions never touch citations, math or LaTeX commands. |
| `research-draft` | `C-c r d` | Asks for the title, the purpose, the papers it may cite (`completing-read-multiple`, keys annotated with title, year and authors), the length and an optional research question; Claude writes the section with every claim cited, the app saves it as a new draft in «Redacción → Borrador», and writes it in the background (minutes) while Emacs stays free: the echo area shows its progress every `research-draft-poll-interval` seconds, and when it is written its text opens in Org in a new `*research-draft*` buffer for review, with the counts of unverified citations, citations outside the selection and claims marked `[SIN CITA]`. While one draft started from the API is being written, another is refused (a retry never pays twice). |
| `research-draft-stop` | `C-c r D` | Stops the draft `research-draft` is following; what Claude wrote so far is kept as a stopped version and opens as usual. |

Errors from the app are shown in Spanish, like the app (no project open, the API is off, wrong token, a refused `Host`/`Origin`, unknown key…).

## Options

- `research-api-file`: the connection file (default `~/.config/research/api.json`).
- `research-latex-cite-command`: `"cite"` by default (e.g. `"parencite"`, `"autocite"`).
- `research-quote-formats`: how a passage's quote is written per format.
- `research-request-timeout`: seconds to wait for the app (60).
- `research-draft-poll-interval`: seconds between two looks at a draft being written (5).
- `research-bib-order`: `"appearance"` (default) or `"alphabetical"`.
- `research-keymap-prefix`: `"C-c r"` by default; `nil` to bind `research-command-map` yourself (set it before the
  package loads).

## Doom Emacs setup

With the `biblio` module (citar) and org-cite export to LaTeX with biblatex/biber, add to `packages.el`:

```elisp
(package! research :recipe (:local-repo "~/dev/lalohao/research/emacs" :files ("research.el")))
```

and to `config.el`:

```elisp
(use-package! research
  :hook ((org-mode latex-mode LaTeX-mode markdown-mode) . research-mode)
  :init
  ;; Under the localleader instead of C-c r.
  (setq research-keymap-prefix nil))

(map! :after research
      :map (org-mode-map latex-mode-map LaTeX-mode-map markdown-mode-map)
      :localleader
      (:prefix ("r" . "research")
       :desc "Insert citation"        "c" #'research-insert-citation
       :desc "Check citations"        "k" #'research-check-citations
       :desc "BibTeX for this file"   "b" #'research-bibtex-for-file
       :desc "Insert outline"         "o" #'research-insert-outline
       :desc "Find passage"           "f" #'research-find-passage
       :desc "Open citation in app"   "a" #'research-open-citation-at-point
       :desc "Draft (Claude)"         "d" #'research-draft
       :desc "Stop the draft"         "D" #'research-draft-stop
       :desc "Check with Claude"      "v" #'research-check-citations-with-claude
       :desc "Propose outline"        "p" #'research-propose-outline
       :desc "Style review (Claude)"  "s" #'research-style-review))
```

Then run `doom sync` and restart Emacs (run `doom sync` again after updating the repository). In an Org buffer,
`SPC m r c` (or `, r c` with Doom's default localleader in evil mode) inserts a citation.

The `.bib` that `research-bibtex-for-file` writes is the same the app's «Redacción → BibTeX» builds, so it can be the
file of `#+bibliography:` that org-cite exports to biblatex (`#+cite_export: biblatex`) and biber reads; let the command
add it to `citar-bibliography` too, or set it once:

```elisp
(after! citar
  (add-to-list 'citar-bibliography (expand-file-name "~/thesis/thesis.bib")))
```

## Tests

Headless ERT tests, with the HTTP layer mocked (no app, no network):

```sh
pnpm test:emacs
# or
emacs --batch -L emacs -l emacs/research-test.el -f ert-run-tests-batch-and-exit
```
