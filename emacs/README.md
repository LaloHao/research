# research.el

Use the Research app's library from Emacs while you write: insert citations, check them, build the chapter's `.bib`,
insert the state-of-the-art outline, search passages in the papers' full text and open a cited paper in the app at its
page. Works in Org (org-cite), LaTeX and Markdown (pandoc) buffers.

It also helps you write without writing for you: `research-prose.el` checks Spanish academic prose locally (no app,
no cost), and the tutor commands ask Claude, through the app, to point at problems, explain them and ask you a
question, outline your paragraphs or offer options for one sentence. None of them writes your text.

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

The tutor (Claude, same confirmation and the same switch; caps «Tope por lectura del tutor», «Tope por alternativas de
una oración», «Tope por esquema inverso» and «Tope por cobertura de preguntas» in Settings → Claude). They never
rewrite your text: they point, explain and ask, or offer options for you to choose from.

| Command | Key | What it does |
| --- | --- | --- |
| `research-tutor` | `C-c r t` | For the region (or the paragraph at point, up to 8 000 characters): Flymake notes, in their own backend, on what may weaken the text (ambigüedad, salto lógico, conector, sujeto perdido, registro, cohesión, ritmo, precisión), each with why and one question that leads you to the fix. Asking again about the same stretch replaces its notes; `research-tutor-clear` forgets them all. Notes whose explanation or question quotes a rewrite are dropped by the app. |
| `research-alternatives` | `C-c r w` | For the sentence at point (or the region, up to 600 characters), with its paragraph as context: two or three other phrasings in a small buffer, each saying what it changes (énfasis, orden, ritmo, concisión…). `RET` puts the one under the cursor in place of your sentence, only if you haven't changed it meanwhile (`undo` brings yours back); `q` keeps yours; `n`/`p` move. Citations, math and commands stay exactly as you wrote them. |
| `research-reverse-outline` | `C-c r r` | For the Org subtree at point (or the region; the buffer outside a heading; up to 20 000 characters): a side buffer with one line per paragraph, its main idea in your terms (at most 20 words) and flags (dos ideas, sin transición, fuera del tema) with a short note. `RET` jumps to the paragraph. The app splits the paragraphs, so the jumps are exact. |
| `research-rq-coverage` | `C-c r q` | For the file (or the region; `C-u`: the Org subtree at point; up to 40 000 characters): which research questions of Settings → Tesis each heading addresses, with a short excerpt as evidence (verified in your text), and the questions no heading addresses. `RET` on a heading or an excerpt jumps to it. |

«Preguntar a Claude» (Claude, same confirmation and the same switch; one chat answer under «Tope por mensaje de chat»).
Claude reads what you are writing and gives its opinion: what works, what to change and why, and questions. **By
default it does not rewrite your text**; a proposed version only comes when you allow it for that question.

| Command | Key | What it does |
| --- | --- | --- |
| `research-ask` | `C-c r ?` | Asks for your question (with history), then «¿Permitir propuesta de redacción? (y/N)» (`y` only when you want Claude to also propose a version, set apart as its own and never as your text; anything else is an opinion). The passage (the focus of the question) is the selection: the active region or evil's visual selection (line-wise: whole lines), read when the command starts, so invoking it from visual state through a leader key keeps it; without a selection, the whole file (the chapter); `C-u`: the paragraph at point; `C-u C-u`: the Org subtree at point (a section). At most 30 000 characters, with the file's name and the heading path; a whole file longer than that is asked about by its section at point (else the paragraph), and the echo area and the confirmation say so. As background, never the focus, it also sends the chapter (the whole file, up to 80 000 characters; a longer one goes as the lines 20 000 characters around the passage, marked as cut) unless the passage is the file itself, and the thesis outline: the headings of `tesis.org` (found in a folder above the file, or in the project's root, the folder of `.doc-review.json`) and of the files its `#+INCLUDE:` lines name (relative `.org` paths inside its folder, `:minlevel` respected), with the current file and the passage's section marked; without `tesis.org`, or when it doesn't include the file, the file's own headings (up to 30 000 characters). The current file's text is the buffer's, unsaved edits included. Claude uses them to judge coherence with the rest of the chapter and the thesis (repeated or missing ideas, transitions, where something belongs). Shows the estimated cost (which counts the larger input) and asks, then streams the answer into a read-only Org side buffer, `*research-ask*` (question, scope: «selección», «capítulo/archivo», «párrafo» or «sección», the background sent, file › section, mode, and the cost when done), every `research-ask-poll-interval` seconds while Emacs stays free. Claims about papers carry citations `[key, p. N]` the app checked against the paper (unverified ones in the warning face), listed under «Citas:» with their quotes. Your buffer is never changed. The conversation is a normal one of the app's Chat view (title from the question, «desde Emacs: archivo › sección»), synced like the others. |

In `*research-ask*`: `f` asks a follow-up in the same conversation (same passage, the chapter and the outline sent again
as they are now, from the buffer or, if it was closed, from the file; it asks again whether to allow a proposed version), `c` opens the citation at point in the app at its page with the quote highlighted, `a` opens the
conversation in the app's Chat view, `s` stops the answer (what arrived is kept), `q` closes the window.

## Prose checks (`research-prose.el`)

Local and free: pure Emacs Lisp, no app, no network, no external process. A Flymake backend for Spanish academic prose
in Org buffers. Each diagnostic says *why* the passage may read badly, often with a question; it never proposes a
rewrite.

| Command | Key | What it does |
| --- | --- | --- |
| `research-prose-check` | `C-c r l` | Checks the region (or the buffer) once and shows the diagnostics with Flymake; the echo area counts them per check. |
| `research-prose-mode` | | Minor mode: keeps the checks on while you write (Flymake runs them when you pause). |
| `research-prose-maybe-enable` | | For `org-mode-hook`: turns the mode on in thesis files only (see `research-prose-thesis-directories`), and `research-prose-auto-gls-mode` too unless `research-prose-auto-gls` is nil. |
| `research-prose-gls-at-point` | `C-c r g` | Writes the bare acronym at point (the one of the Flymake warning at point; point may be right after it) as `\gls{KEY}`, `\glspl{KEY}` for its plural (`LLMs`), `\Gls`/`\Glspl` at the start of a sentence. On an undefined acronym, offers `research-prose-add-acronym`. |
| `research-prose-gls-fix` | `C-c r G` | Walks every bare defined acronym of the region (or the buffer) like `query-replace`, highlighting each: `y`/`SPC` converts it, `n`/`DEL` skips it, `!` converts it and the rest, `q`/`RET` stops. The whole run is one undo step. |
| `research-prose-add-acronym` | `C-c r A` | Defines an acronym in the thesis' `acronimos.tex`: asks for the short form (the uppercase word at point by default, without a plural «s»), the long form, the long form's plural (a Spanish guess by default, e.g. «modelos de lenguaje de gran tamaño»: glossaries would otherwise just append «s» for `\glspl`) and the key (the short form in lower case by default), inserts `\newacronym{KEY}{SHORT}{LONG}` (with `[longplural={…}]` when the plural isn't just «s» more) in key order when the file is sorted (after the last definition otherwise; comments are kept), saves the file (your buffer of it if you have it open, asking first when it had unsaved changes) and offers to convert the acronym at point. |
| `research-prose-auto-gls-mode` | `C-c r T` | Minor mode (toggle): a defined acronym becomes `\gls{KEY}` as soon as you finish typing it (space, newline or punctuation). `undo` right after brings the bare acronym back and keeps what you typed. |

The checks (each one can be turned off in `research-prose-checks`):

- **Long sentences**: more than `research-prose-max-sentence-words` words (40). Warning.
- **Repetition**: the same content word (crude Spanish stemming: *registro*/*registros*) again within
  `research-prose-repetition-window` words (30); function words, words shorter than
  `research-prose-repetition-min-length` (5), acronyms and the terms of your term groups are never flagged. Note.
- **Filler phrases**: «cabe mencionar», «es importante señalar», «en este sentido», «a nivel de», «en base a», «de cara
  a», «hoy en día», «el mismo / la misma» as a pronoun, «es por eso que», «jugar un papel», «llevar a cabo», «y/o»…
  Each with why it reads badly (`research-prose-filler-phrases`, an alist you can extend). Warning.
- **Gerunds**: more than `research-prose-max-gerunds` (1) in a sentence. Note.
- **Adverbs in -mente**: more than `research-prose-max-mente-adverbs` (1) in a sentence. Note.
- **Periphrastic passive**: *ser* + participle («fueron analizados», «ha sido propuesta»); adjectives like «es
  válido» or «es adecuado» are not counted. Note.
- **Readability**: the INFLESZ score (Szigriszt-Pazos, with Spanish syllable counting) of each paragraph of at least
  `research-prose-readability-min-words` words (40), noted when below `research-prose-readability-threshold` (40, «muy
  difícil»; academic prose usually sits between 40 and 55).
- **Terms**: groups of terms for the same concept, from `research-prose-term-groups` and from keyword lines in the
  file, e.g. `#+PROSE_TERMS: desensibilización|anonimización|sanitización`. When the text uses several terms of a group
  (plurals count), the less used ones are flagged. Warning.
- **Acronyms**: the thesis' `acronimos.tex` (`research-prose-acronym-files`, found in the file's folder or above it
  with `locate-dominating-file`) is read for `\newacronym{KEY}{SHORT}{LONG}`. A defined acronym written bare (`LLM`,
  `LLMs`) is a warning (write `\gls{llm}`); a `\gls{X}` (or `\Gls`, `\glspl`, `\acrshort`…) of an undefined key is an
  error. The acronym is matched on its short form and written with its key: with `\newacronym{ner}{REN}{…}`, `REN`
  becomes `\gls{ner}`.
- **Undefined acronyms** (`new-acronyms`): an uppercase word of 2 to 8 letters or digits (plus a plural «s») that is not
  in `acronimos.tex` is a note suggesting `research-prose-add-acronym`. Roman numerals (II to XXXIX) and the words of
  `research-prose-acronym-ignore` (`OK`, `TODO`, `DONE`, `NB`, `PS`, `FAQ`) are never noted.

The acronym checks also look at table rows (a table exports to LaTeX, so an acronym there needs `\gls` too).

### Acronyms as `\gls`

The four acronym commands are the only ones that write into your text, and only acronyms:

- With `research-prose-auto-gls-mode` (on by default in thesis files: `research-prose-auto-gls`), typing `Los LLMs `
  leaves `Los \glspl{llm} `. It does nothing where the checks see no prose, nor right after a character that may open
  markup not finished yet (`{`, `[`, `=`, `~`, `$`, `\`, `@`, `:`, `/`…), nor in `acronimos.tex` itself. Turn it off for
  a buffer with `C-c r T`, or everywhere with `(setq research-prose-auto-gls nil)`.
- For text already written, `C-c r G` walks every bare acronym; `C-c r g` converts the one at point.
- **Case**: at the start of a sentence, a paragraph, a list item or a table cell the command is `\Gls` (`\Glspl`): the
  first use of an acronym is expanded to its long form («modelo de lenguaje grande (LLM)»), which must then start with a
  capital. Set `research-prose-gls-capitalize` to nil to always write `\gls`.
- What is skipped is what the checks skip (headings, `#+` lines, drawers, `src`/`example`/`export`/`comment`/`quote`/`verse`
  blocks, comments, fixed-width lines, LaTeX environments, math, LaTeX commands with their arguments such as an existing
  `\gls{…}` or a `\newacronym`, citations `[cite:…]`, link targets, verbatim and code); table rows are converted.
  Headings are never converted: `\gls` in a section title goes into the table of contents and the PDF bookmarks.
- An undefined acronym: `C-c r A` on it (or `C-c r g`, which offers it) asks for its long form, adds it to `acronimos.tex`
  and converts it.

What is not prose is ignored: headings, `#+` keyword lines, drawers, `src`/`example`/`export`/`comment`/`quote`/`verse`
blocks, tables, comment lines, fixed-width lines, LaTeX environments (math, figures, tables, listings), display and
inline math, LaTeX commands (with their argument when it is a key or a label), citations `[cite:…]`, link targets (the
description is checked), footnote labels, macros, inline source, verbatim and code.

Errors from the app are shown in Spanish, like the app (no project open, the API is off, wrong token, a refused `Host`/`Origin`, unknown key…).

## Options

- `research-api-file`: the connection file (default `~/.config/research/api.json`).
- `research-latex-cite-command`: `"cite"` by default (e.g. `"parencite"`, `"autocite"`).
- `research-quote-formats`: how a passage's quote is written per format.
- `research-request-timeout`: seconds to wait for the app (60).
- `research-draft-poll-interval`: seconds between two looks at a draft being written (5).
- `research-ask-poll-interval`: seconds between two looks at the answer `research-ask` is following (2).
- `research-bib-order`: `"appearance"` (default) or `"alphabetical"`.
- `research-keymap-prefix`: `"C-c r"` by default; `nil` to bind `research-command-map` yourself (set it before the
  package loads).
- `research-prose.el`: `research-prose-checks`, `research-prose-max-sentence-words`, `research-prose-repetition-window`,
  `research-prose-repetition-min-length`, `research-prose-max-gerunds`, `research-prose-max-mente-adverbs`,
  `research-prose-readability-threshold`, `research-prose-readability-min-words`, `research-prose-term-groups`,
  `research-prose-filler-phrases`, `research-prose-acronym-files`, `research-prose-skipped-blocks`,
  `research-prose-skipped-environments`, `research-prose-thesis-directories`, `research-prose-acronym-ignore`,
  `research-prose-gls-capitalize`, `research-prose-auto-gls` (`M-x customize-group RET research-prose`).

## Doom Emacs setup

With the `biblio` module (citar) and org-cite export to LaTeX with biblatex/biber, add to `packages.el`:

```elisp
(package! research :recipe (:local-repo "~/dev/lalohao/research/emacs" :files ("research.el" "research-prose.el")))
```

and to `config.el`:

```elisp
(use-package! research
  :hook ((org-mode latex-mode LaTeX-mode markdown-mode) . research-mode)
  :init
  ;; Under the localleader instead of C-c r.
  (setq research-keymap-prefix nil))

;; Local prose checks while you write, in the thesis' Org files only.
(use-package! research-prose
  :commands (research-prose-mode research-prose-check research-prose-gls-at-point research-prose-gls-fix
             research-prose-add-acronym research-prose-auto-gls-mode)
  :hook (org-mode . research-prose-maybe-enable)
  :init
  ;; The thesis' folders; without them, any Org file with an acronimos.tex above it.
  (setq research-prose-thesis-directories '("~/thesis/"))
  ;; Acronyms become \gls{KEY} as you type them (nil to keep only the commands).
  (setq research-prose-auto-gls t))

(map! :after research
      :map (org-mode-map latex-mode-map LaTeX-mode-map markdown-mode-map)
      :localleader
      (:prefix ("w" . "writing (research)")
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
       :desc "Style review (Claude)"  "s" #'research-style-review
       :desc "Tutor (Claude)"         "t" #'research-tutor
       :desc "Alternatives (Claude)"  "w" #'research-alternatives
       :desc "Reverse outline"        "r" #'research-reverse-outline
       :desc "RQ coverage"            "q" #'research-rq-coverage
       :desc "Prose check (local)"    "l" #'research-prose-check
       :desc "Acronym at point → \\gls" "g" #'research-prose-gls-at-point
       :desc "All acronyms → \\gls"   "G" #'research-prose-gls-fix
       :desc "Add acronym"            "A" #'research-prose-add-acronym
       :desc "Auto \\gls on/off"       "T" #'research-prose-auto-gls-mode
       :desc "Preguntar a Claude"     "?" #'research-ask))
```

Then run `doom sync` and restart Emacs (run `doom sync` again after updating the repository). In an Org buffer,
`SPC m w c` inserts a citation, `SPC m w l` checks the prose of the buffer and `SPC m w t` asks the tutor about the
paragraph; `SPC m w g` writes the acronym at point as `\gls`, `SPC m w G` walks them all, `SPC m w A` adds one to
`acronimos.tex` and `SPC m w T` toggles the conversion as you type. `SPC m w ?` asks Claude about the whole file; select
first (`v`/`V`, then `SPC m w ?` from visual state) to ask about the selection. The prefix is `w` (writing) because Org already uses `SPC m r` for refiling.

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
emacs --batch -L emacs -l emacs/research-test.el -l emacs/research-prose-test.el -f ert-run-tests-batch-and-exit
```
