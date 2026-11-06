;;; research.el --- Use the Research app's library from Emacs -*- lexical-binding: t; -*-

;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: tex, bib, convenience
;; URL: https://github.com/lalohao/research

;;; Commentary:

;; A client for the local API of the Research desktop app (an MCP server on
;; 127.0.0.1 that the app starts when Settings → Aplicación → «API local» is on).
;; It reads the connection (URL and bearer token) from `research-api-file' and
;; offers, in Org, LaTeX and Markdown buffers (`research-mode'):
;;
;; - `research-insert-citation': complete a library paper and insert its citation
;;   (`[cite:@key]', `\cite{key}' or `[@key]').
;; - `research-check-citations': unknown, trashed, duplicated and not-indexed
;;   keys of the buffer or region, as Flymake diagnostics.
;; - `research-bibtex-for-file': a .bib with only the entries the file (and what
;;   it includes) cites; optionally set it as the Org `#+bibliography:' and in
;;   `citar-bibliography'.
;; - `research-insert-outline': the app's state-of-the-art outline.
;; - `research-find-passage': full-text search; RET inserts the quote with its
;;   citation and page, `o' opens the paper in the app.
;; - `research-open-citation-at-point': show the cited paper in the app, at the
;;   citation's page.
;;
;; The commands that spend Claude quota (`research-draft',
;; `research-check-citations-with-claude', `research-propose-outline',
;; `research-style-review' and the tutor's `research-tutor',
;; `research-alternatives', `research-reverse-outline', `research-rq-coverage')
;; always ask for the API's cost estimate first and run only after
;; `yes-or-no-p'.  The check with Claude also opens a report,
;; `*research-cite-check*', with each verdict and, for a weak sentence,
;; papers of your library that may support it (free and local).  The tutor's never write your text: they point, explain, ask,
;; outline, or offer options of one sentence for you to choose from.
;;
;; `research-ask' (`?' in the command map) sends the selection (evil's
;; visual one too), else the whole file, with your question (C-u: the
;; paragraph, C-u C-u: the section), plus the chapter and the thesis outline
;; as background: Claude gives its opinion (what to change and why, and
;; questions) without rewriting your text unless you allow a proposed version
;; for that question.  The answer streams into `*research-ask*' and is a
;; conversation of the app's Chat view.
;;
;; `research-prose-check' (research-prose.el, `l' in the command map) checks
;; Spanish academic prose locally, without the app; `g', `G', `A' and `T'
;; write the thesis' acronyms as \gls (at point, all of them asking, a new
;; one in acronimos.tex, as you type).
;;
;; Pure Emacs Lisp: url.el for HTTP and the native JSON parser.

;;; Code:

(require 'cl-lib)
(require 'transient)
(require 'subr-x)
(require 'url)
(require 'url-http)

(declare-function flymake-make-diagnostic "flymake")
(declare-function flymake-start "flymake")
(declare-function org-back-to-heading "org")
(declare-function org-end-of-subtree "org")
(defvar flymake-diagnostic-functions)
(defvar flymake-mode)
(defvar citar-bibliography)

(defgroup research nil
  "Use the Research app's library from Emacs."
  :group 'tools
  :prefix "research-")

(defcustom research-api-file
  (expand-file-name "research/api.json" (or (getenv "XDG_CONFIG_HOME") "~/.config"))
  "The app's connection file: a JSON object with `url' and `token'.
The app writes it (readable by your user only) when the local API is
turned on."
  :type 'file)

(defcustom research-latex-cite-command "cite"
  "LaTeX command, without the backslash, that `research-insert-citation' uses."
  :type 'string)

(defcustom research-quote-formats
  '((org . "\"%s\"") (latex . "``%s''") (markdown . "\"%s\""))
  "How `research-find-passage' writes a quote, per format; %s is the quote."
  :type '(alist :key-type symbol :value-type string))

(defcustom research-request-timeout 60
  "Seconds to wait for the app's answer."
  :type 'integer)

(defcustom research-draft-poll-interval 5
  "Seconds between two looks at the draft `research-draft' started.
The app writes the draft in the background (it can take minutes); Emacs
stays free and asks for its state on a timer."
  :type 'number)

(defcustom research-bib-order "appearance"
  "Order of the entries `research-bibtex-for-file' writes."
  :type '(choice (const "appearance") (const "alphabetical")))

(defcustom research-keymap-prefix "C-c r"
  "Prefix of `research-command-map' in `research-mode'.
Set it before `research-mode' is loaded; nil binds nothing (bind
`research-command-map' yourself, e.g. under Doom's localleader)."
  :type '(choice (const nil) string))

(defvar research-http-function #'research--url-post
  "Function that POSTs: called with URL, HEADERS (alist) and BODY (string).
Returns (STATUS . RESPONSE-BODY).  Tests replace it.")

(define-error 'research-error "Research")

;;;; Errors

(defconst research--error-messages
  '(("no_project" . "No hay un proyecto abierto en la app: abre uno y vuelve a intentarlo.")
    ("costly_disabled" . "Las operaciones con costo están desactivadas: actívalas en la app, en Ajustes → Aplicación → API local.")
    ("not_found" . "No encontrado")
    ("invalid_path" . "Ruta no válida")
    ("unreadable" . "No se pudo leer el archivo.")
    ("too_large" . "Demasiado grande")
    ("no_facets" . "El formulario de extracción no tiene facetas para agrupar.")
    ("invalid" . "Petición no válida")
    ("budget_exceeded" . "Se alcanzó un tope de gasto de Claude.")
    ("failed" . "La herramienta falló.")
    ("busy" . "Ya hay un borrador pedido desde la API en curso: espera a que termine o detenlo con `research-draft-stop'.")
    ("unauthorized" . "La app rechazó el token: revisa el archivo de conexión (¿regeneraste el token?).")
    ("forbidden" . "La app rechazó la petición (Host u Origin no permitidos): usa la URL de 127.0.0.1 del archivo de conexión, sin proxy.")
    ("connection" . "No se pudo conectar con la app: ¿está abierta y con la API local activada?")
    ("no_connection" . "No encuentro el archivo de conexión de la app: activa la API local en Ajustes → Aplicación.")
    ("unavailable" . "Esta función todavía no está disponible en la app."))
  "Spanish messages for the API's error codes.")

(defun research--fail (code &optional detail)
  "Signal `research-error' with CODE (a string) and optional DETAIL."
  (let ((base (or (cdr (assoc code research--error-messages)) code)))
    (signal 'research-error
            (list code (if (and detail (not (string-empty-p detail))
                                (not (member code '("no_project" "costly_disabled" "unauthorized" "forbidden" "connection" "no_connection"))))
                           (format "%s: %s" base detail)
                         base)))))

(defun research--error-message (err)
  "The user-facing message of a `research-error' ERR."
  (or (nth 2 err) (nth 1 err)))

(defmacro research--with-errors (&rest body)
  "Run BODY, turning a `research-error' into a `user-error'."
  (declare (indent 0) (debug t))
  `(condition-case err
       (progn ,@body)
     (research-error (user-error "%s" (research--error-message err)))))

;;;; Transport

(defun research--connection ()
  "The (URL . TOKEN) of `research-api-file'."
  (unless (file-readable-p research-api-file) (research--fail "no_connection"))
  (let* ((json (with-temp-buffer
                 (insert-file-contents research-api-file)
                 (condition-case nil
                     (json-parse-buffer :object-type 'alist)
                   (error (research--fail "no_connection")))))
         (url (alist-get 'url json))
         (token (alist-get 'token json)))
    (unless (and (stringp url) (stringp token)) (research--fail "no_connection"))
    (cons url token)))

(defun research--url-post (url headers body)
  "POST BODY to URL with HEADERS using url.el; return (STATUS . BODY)."
  (let* ((url-request-method "POST")
         ;; url.el refuses a request that mixes multibyte strings with the UTF-8 body: every part goes as bytes.
         (url-request-extra-headers
          (cl-loop for (name . value) in headers
                   unless (string-equal name "Accept")
                   collect (cons (encode-coding-string name 'utf-8) (encode-coding-string value 'utf-8))))
         ;; `json-serialize' already returns UTF-8 bytes.
         (url-request-data (if (multibyte-string-p body) (encode-coding-string body 'utf-8) body))
         (url-mime-accept-string "application/json, text/event-stream")
         (url-proxy-services nil)
         (url-http-attempt-keepalives nil)
         (buffer (condition-case nil
                     (url-retrieve-synchronously (encode-coding-string url 'utf-8) t t research-request-timeout)
                   (error (research--fail "connection")))))
    (unless buffer (research--fail "connection"))
    (unwind-protect
        (with-current-buffer buffer
          (goto-char (point-min))
          (let ((status (and (looking-at "HTTP/[0-9.]+ \\([0-9]+\\)")
                             (string-to-number (match-string 1)))))
            (unless status (research--fail "connection"))
            (re-search-forward "\r?\n\r?\n" nil 'move)
            (cons status (decode-coding-string
                          (buffer-substring-no-properties (point) (point-max)) 'utf-8))))
      (kill-buffer buffer))))

(defvar research--rpc-id 0)

(defun research--parse-json (string)
  "STRING as Lisp: objects as alists, arrays as lists, null and false as nil."
  (json-parse-string string :object-type 'alist :array-type 'list
                     :null-object nil :false-object nil))

(defun research-call (tool &optional arguments)
  "Call the app's TOOL with ARGUMENTS (an alist) and return its answer.
The answer is parsed JSON (alists and lists) when it is JSON, else the
text.  Signals `research-error' with the API's error code."
  (let* ((connection (research--connection))
         (body (json-serialize
                `((jsonrpc . "2.0")
                  (id . ,(cl-incf research--rpc-id))
                  (method . "tools/call")
                  (params . ((name . ,tool)
                             (arguments . ,(or arguments (make-hash-table))))))))
         (response (funcall research-http-function (car connection)
                            `(("Authorization" . ,(concat "Bearer " (cdr connection)))
                              ("Content-Type" . "application/json")
                              ("Accept" . "application/json, text/event-stream"))
                            body))
         (status (car response)))
    (cond ((eql status 401) (research--fail "unauthorized"))
          ((eql status 403) (research--fail "forbidden"))
          ((not (eql status 200)) (research--fail "failed" (format "HTTP %s" status))))
    (let* ((json (condition-case nil (research--parse-json (cdr response))
                   (error (research--fail "failed" "respuesta no válida"))))
           (rpc-error (alist-get 'error json))
           (result (alist-get 'result json))
           (text (mapconcat (lambda (c) (or (alist-get 'text c) "")) (alist-get 'content result) "")))
      (when rpc-error
        (research--fail (if (string-match-p "not found" (or (alist-get 'message rpc-error) "")) "unavailable" "invalid")
                        (alist-get 'message rpc-error)))
      (when (alist-get 'isError result)
        (cond ((string-match "\\`\\([a-z_]+\\): \\(\\(?:.\\|\n\\)*\\)\\'" text)
               (research--fail (match-string 1 text) (match-string 2 text)))
              ((string-match-p "not found" text) (research--fail "unavailable"))
              (t (research--fail "invalid" text))))
      (condition-case nil (research--parse-json text) (error text)))))

;;;; Formats

(defun research--format ()
  "The citation format of the current buffer: `org', `latex' or `markdown'."
  (cond ((derived-mode-p 'org-mode) 'org)
        ((derived-mode-p 'latex-mode 'LaTeX-mode 'tex-mode 'TeX-mode) 'latex)
        ((derived-mode-p 'markdown-mode 'gfm-mode) 'markdown)
        ((and buffer-file-name (string-match-p "\\.\\(tex\\|ltx\\)\\'" buffer-file-name)) 'latex)
        ((and buffer-file-name (string-match-p "\\.\\(md\\|markdown\\|qmd\\|rmd\\)\\'" buffer-file-name)) 'markdown)
        (t 'org)))

(defun research-format-citation (key &optional page format)
  "KEY's citation in FORMAT (default: the buffer's), with PAGE when non-nil."
  (let ((page (and page (format "%s" page))))
    (pcase (or format (research--format))
      ('latex (if page (format "\\%s[p.~%s]{%s}" research-latex-cite-command page key)
                (format "\\%s{%s}" research-latex-cite-command key)))
      ('markdown (if page (format "[@%s, p. %s]" key page) (format "[@%s]" key)))
      (_ (if page (format "[cite:@%s p. %s]" key page) (format "[cite:@%s]" key))))))

;;;; Citations

(defvar research--papers nil "The last `list_papers_for_citation' answer.")

(defun research--papers (&optional _refresh)
  "The library papers for completion, asked fresh from the app every time.
Papers added in the app show up at once (the call is local and quick).
When the app doesn't answer, the last list is used, with a message; with
no list yet, the error is raised.  _REFRESH is kept for compatibility."
  (condition-case err
      (setq research--papers (research-call "list_papers_for_citation"))
    (research-error
     (if research--papers
         (progn (message "No se pudo pedir la lista a la app (%s); uso la última que tengo"
                         (error-message-string err))
                research--papers)
       (signal (car err) (cdr err))))))

(defun research--candidates (papers)
  "Completion strings for PAPERS, each with its key in `research-key'."
  (mapcar (lambda (p)
            (let ((key (alist-get 'key p)))
              (propertize (format "%s  %s (%s)  %s" key (alist-get 'title p)
                                  (or (alist-get 'year p) "s. f.") (or (alist-get 'authors p) ""))
                          'research-key key)))
          papers))

(defun research-read-key (&optional prompt refresh)
  "Read a library paper's key with completion, PROMPT and REFRESH as given."
  (let* ((candidates (research--candidates (research--papers refresh)))
         (choice (completing-read (or prompt "Paper: ")
                                  (lambda (string pred action)
                                    (if (eq action 'metadata)
                                        '(metadata (category . research-paper))
                                      (complete-with-action action candidates string pred)))
                                  nil t)))
    ;; Every candidate starts with its key (some completion UIs drop text properties).
    (if (string-empty-p choice) "" (car (split-string choice)))))

(defun research-read-keys (&optional prompt refresh)
  "Read several library papers' keys with `completing-read-multiple'.
PROMPT and REFRESH as in `research-read-key'.  The candidates are the keys,
annotated with title, year and authors."
  (let* ((papers (research--papers refresh))
         (keys (mapcar (lambda (p) (alist-get 'key p)) papers))
         (annotate (lambda (key)
                     (let ((p (cl-find key papers :key (lambda (p) (alist-get 'key p)) :test #'equal)))
                       (and p (format "  %s (%s)  %s" (alist-get 'title p) (or (alist-get 'year p) "s. f.")
                                      (or (alist-get 'authors p) "")))))))
    (cl-remove-if-not (lambda (k) (member k keys))
                      (delete-dups
                       (completing-read-multiple (or prompt "Papers: ")
                                                 (lambda (string pred action)
                                                   (if (eq action 'metadata)
                                                       `(metadata (category . research-paper) (annotation-function . ,annotate))
                                                     (complete-with-action action keys string pred)))
                                                 nil t)))))

;;;###autoload
(defun research-insert-citation (&optional refresh)
  "Insert the citation of a library paper chosen with completion.
With a prefix argument REFRESH, ask the app for the papers again."
  (interactive "P")
  (research--with-errors
    (let ((key (research-read-key "Citar: " refresh)))
      (when (string-empty-p key) (user-error "No elegiste un paper"))
      (insert (research-format-citation key)))))

;;;; Checking citations (Flymake)

(defvar-local research--diagnostics nil
  "The last local check's diagnostics: (BEG-MARKER END-MARKER TYPE TEXT).")

(defvar-local research--claude-diagnostics nil
  "The last check with Claude's diagnostics: (BEG-MARKER END-MARKER TYPE TEXT).")

(defun research--markers (diagnostics)
  "DIAGNOSTICS (BEG END TYPE TEXT) with markers instead of positions."
  (mapcar (lambda (d) (list (copy-marker (nth 0 d)) (copy-marker (nth 1 d)) (nth 2 d) (nth 3 d))) diagnostics))

(defun research--flymake-refresh (&optional backend)
  "Show the stored diagnostics with Flymake, through BACKEND (`research-flymake')."
  (when (require 'flymake nil t)
    (add-hook 'flymake-diagnostic-functions (or backend #'research-flymake) nil t)
    (if flymake-mode (flymake-start) (flymake-mode 1))))

(defun research--diagnostic-list (report base)
  "Diagnostics of a `check_citations_local' REPORT whose text starts at BASE."
  (let (out)
    (dolist (c (alist-get 'citations report))
      (let ((beg (+ base (alist-get 'start c)))
            (end (+ base (alist-get 'end c)))
            (dups (alist-get 'duplicates c)))
        (dolist (state (alist-get 'states c))
          (let ((key (symbol-name (car state))))
            (pcase (cdr state)
              ("unknown" (push (list beg end :error (format "%s no está en la biblioteca" key)) out))
              ("trashed" (push (list beg end :warning (format "%s está en la papelera" key)) out))
              ("no_text" (push (list beg end :note (format "%s no tiene texto indexado: no se puede verificar" key)) out)))
            (when (member key dups)
              (push (list beg end :warning (format "%s está repetida en la oración" key)) out))))))
    (nreverse out)))

(defun research-flymake (report-fn &rest _)
  "Flymake backend: report the last checks (local and with Claude) to REPORT-FN."
  (funcall report-fn
           (cl-loop for (beg end type text) in (append research--diagnostics research--claude-diagnostics)
                    when (and (marker-buffer beg) (< beg end))
                    collect (flymake-make-diagnostic (current-buffer) (marker-position beg)
                                                     (marker-position end) type text))))

;;;###autoload
(defun research-check-citations (&optional beg end)
  "Check the citations of the region (BEG..END) or the buffer against the library.
Unknown, trashed, duplicated and not-indexed keys show as Flymake diagnostics."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((beg (or beg (point-min)))
           (end (or end (point-max)))
           (report (research-call "check_citations_local"
                                  `((text . ,(buffer-substring-no-properties beg end))
                                    (format . ,(symbol-name (research--format))))))
           (diagnostics (research--diagnostic-list report beg)))
      (setq research--diagnostics (research--markers diagnostics))
      (research--flymake-refresh)
      (message "%d citas: %d desconocidas, %d en la papelera, %d sin texto, %d repetidas"
               (length (alist-get 'citations report)) (length (alist-get 'unknown report))
               (length (alist-get 'trashed report)) (length (alist-get 'no_text report))
               (length (alist-get 'duplicates report)))
      report)))

;;;; BibTeX

(defun research--set-org-bibliography (file)
  "Add `#+bibliography: FILE' (relative to the buffer) unless already there."
  (let ((name (file-relative-name file (file-name-directory (or buffer-file-name file)))))
    (save-excursion
      (goto-char (point-min))
      (unless (re-search-forward (concat "^#\\+bibliography:[ \t]*" (regexp-quote name) "[ \t]*$") nil t)
        (goto-char (point-min))
        (while (looking-at-p "^#\\+[a-zA-Z_]+:") (forward-line 1))
        (insert (format "#+bibliography: %s\n" name))
        t))))

;;;###autoload
(defun research-bibtex-for-file (&optional choose)
  "Write a .bib with the entries the visited file (and its includes) cites.
It goes next to the file (same name, .bib); with a prefix argument CHOOSE,
ask where.  Then offers to use it as the Org `#+bibliography:' and in
`citar-bibliography'."
  (interactive "P")
  (research--with-errors
    (unless buffer-file-name (user-error "Este búfer no visita un archivo"))
    (when (and (buffer-modified-p) (y-or-n-p "¿Guardar el archivo antes?")) (save-buffer))
    (let* ((visited (expand-file-name buffer-file-name))
           ;; The app reads the real file: a symlinked chapter's includes are next to its target.
           (source (file-truename visited))
           (default (concat (file-name-sans-extension visited) ".bib"))
           (target (if choose (expand-file-name (read-file-name "Guardar .bib en: " nil default nil (file-name-nondirectory default)))
                     default))
           (answer (research-call "bibtex_for_file" `((path . ,source) (order . ,research-bib-order))))
           (report (alist-get 'report answer)))
      (when (or (not (file-exists-p target)) choose
                (y-or-n-p (format "¿Reemplazar %s? " (abbreviate-file-name target))))
        (let ((coding-system-for-write 'utf-8))
          (write-region (alist-get 'bib answer) nil target nil 'silent))
        (message "%s: %d entradas%s%s" (abbreviate-file-name target)
                 (length (alist-get 'entries report))
                 (if (alist-get 'unknown report)
                     (format "; desconocidas: %s"
                             (mapconcat (lambda (u) (alist-get 'key u)) (alist-get 'unknown report) ", "))
                   "")
                 (if (alist-get 'trashed report)
                     (format "; en la papelera: %s" (string-join (alist-get 'trashed report) ", "))
                   ""))
        (when (and (derived-mode-p 'org-mode)
                   (y-or-n-p "¿Usarlo como #+bibliography: de este archivo?"))
          (research--set-org-bibliography target))
        (when (and (boundp 'citar-bibliography)
                   (not (member target citar-bibliography))
                   (y-or-n-p "¿Agregarlo a citar-bibliography?"))
          (setq citar-bibliography (append citar-bibliography (list target)))))
      answer)))

;;;; Outline

(defun research--outline-args (ask)
  "The outline's arguments in the buffer's format.
When ASK, prompt for the choices."
  (let ((args `((format . ,(symbol-name (research--format))))))
    (when ask
      (let ((facet (read-string "Faceta principal (vacío: la primera del formulario): "))
            (secondary (read-string "Faceta secundaria (vacío: ninguna): "))
            (rq (read-string "Pregunta de investigación, p. ej. RQ1 (vacío: ninguna): ")))
        (unless (string-empty-p facet) (push `(facet . ,facet) args))
        (unless (string-empty-p secondary) (push `(secondary . ,secondary) args))
        (unless (string-empty-p rq) (push `(rq . ,(upcase rq)) args))
        (when (y-or-n-p "¿Solo valores revisados?") (push '(reviewed_only . t) args))))
    args))

;;;###autoload
(defun research-insert-outline (&optional ask)
  "Insert the app's state-of-the-art outline in the buffer's format.
Without a prefix argument: the whole library, the form's first facet.
With ASK (a prefix argument), ask for the facets, the research question
and whether to count only reviewed values."
  (interactive "P")
  (research--with-errors
    (let ((args (research--outline-args ask)))
      (let ((answer (research-call "outline" args)))
        (insert (alist-get 'text answer))
        answer))))

;;;; Passages

(defvar-local research--passages-origin nil "Marker where a passage is inserted.")
(defvar-local research--passages-format nil "Format of the origin buffer.")

(defvar research-passages-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'research-passages-insert)
    (define-key map (kbd "o") #'research-passages-open)
    (define-key map (kbd "n") #'research-passages-next)
    (define-key map (kbd "p") #'research-passages-previous)
    map)
  "Keymap of `research-passages-mode'.")

(define-derived-mode research-passages-mode special-mode "Research-Passages"
  "Passages found in the library.
\\<research-passages-mode-map>\\[research-passages-insert] inserts the quote and its citation where
the search started; \\[research-passages-open] opens the paper in the app.")

(defun research--passage-at-point ()
  "The passage (an alist) under point, or a `user-error'."
  (or (get-text-property (point) 'research-passage)
      (user-error "No hay un pasaje aquí")))

(defun research--passage-starts ()
  "Where each passage of the results buffer starts."
  (let ((pos (point-min)) starts)
    (while pos
      (let ((here (get-text-property pos 'research-passage)))
        (when (and here (or (= pos (point-min)) (not (eq here (get-text-property (1- pos) 'research-passage)))))
          (push pos starts)))
      (setq pos (next-single-property-change pos 'research-passage)))
    (nreverse starts)))

(defun research-passages-next ()
  "Move to the next passage."
  (interactive)
  (let ((next (cl-find-if (lambda (p) (> p (point))) (research--passage-starts))))
    (when next (goto-char next))))

(defun research-passages-previous ()
  "Move to the previous passage (or the start of this one)."
  (interactive)
  (let ((prev (cl-find-if (lambda (p) (< p (point))) (reverse (research--passage-starts)))))
    (when prev (goto-char prev))))

(defun research-passage-text (passage format)
  "The quote of PASSAGE with its citation and page, in FORMAT."
  (concat (format (or (alist-get format research-quote-formats) "\"%s\"") (alist-get 'quote passage))
          " "
          (research-format-citation (alist-get 'key passage) (alist-get 'page passage) format)))

(defun research-passages-insert ()
  "Insert the passage's quote and citation where the search started."
  (interactive)
  (let* ((passage (research--passage-at-point))
         (origin research--passages-origin)
         (format research--passages-format))
    (unless (and origin (buffer-live-p (marker-buffer origin)))
      (user-error "El búfer de origen ya no existe"))
    (with-current-buffer (marker-buffer origin)
      (save-excursion
        (goto-char origin)
        (insert (research-passage-text passage format))
        (set-marker origin (point))))
    (message "Insertado en %s" (buffer-name (marker-buffer origin)))))

(defun research-passages-open ()
  "Open the passage's paper in the app, at its page, the quote highlighted."
  (interactive)
  (let ((passage (research--passage-at-point)))
    (research--with-errors
      (research--open-in-app (alist-get 'key passage) (alist-get 'page passage) (alist-get 'quote passage)))))

;;;###autoload
(defun research-find-passage (query &optional keys)
  "Search the library's full text for QUERY (optionally only in KEYS).
Shows the passages; RET inserts the quote with its citation and page here."
  (interactive (list (read-string "Buscar en los papers: ")))
  (research--with-errors
    (let* ((args `((query . ,query) ,@(and keys `((keys . ,(vconcat keys))))))
           (passages (research-call "find_passages" args))
           (origin (point-marker))
           (format (research--format))
           (buffer (get-buffer-create "*research passages*")))
      (with-current-buffer buffer
        (research-passages-mode)
        (setq research--passages-origin origin
              research--passages-format format)
        (let ((inhibit-read-only t))
          (erase-buffer)
          (insert (propertize (format "Pasajes para «%s» (RET: insertar, o: abrir en la app, q: salir)\n\n" query)
                              'face 'shadow))
          (if (null passages)
              (insert "Sin resultados.\n")
            (dolist (p passages)
              (let ((start (point)))
                (insert (propertize (format "%s, p. %s — %s\n" (alist-get 'key p)
                                            (or (alist-get 'page p) "?") (alist-get 'title p))
                                    'face 'bold)
                        (alist-get 'quote p) "\n\n")
                (put-text-property start (1- (point)) 'research-passage p)))))
        (goto-char (point-min))
        (research-passages-next))
      (pop-to-buffer buffer)
      passages)))

;;;; Opening in the app

(defun research--open-in-app (key &optional page quote)
  "Ask the app to show KEY at PAGE with QUOTE highlighted."
  (research-call "open_in_app" `((key . ,key)
                                 ,@(and page (integerp page) `((page . ,page)))
                                 ,@(and quote `((quote . ,quote))))))

(defconst research--citation-regexps
  '((org . "\\[cite\\(?:/[^:]*\\)?:\\([^]]*\\)\\]")
    (latex . "\\\\[a-zA-Z]*cite[a-zA-Z]*\\*?\\(\\(?:\\[[^]]*\\]\\)\\{0,2\\}\\){\\([^}]*\\)}")
    (markdown . "\\[\\([^]]*@[^]]*\\)\\]"))
  "Citation syntaxes: the whole citation; see `research-citation-at-point'.")

(defun research--page-in (text)
  "The first page number of a locator in TEXT (`p. 12', `pp. 3-4', `p.~5')."
  (when (and text (string-match "\\bpp?\\.?[ ~]*\\([0-9]+\\)" text))
    (string-to-number (match-string 1 text))))

(defun research-citation-at-point ()
  "The citation under point as (KEY . PAGE), PAGE nil when it has none.
In a citation of several keys, the key under point, else the first."
  (let ((pos (point))
        (format (research--format))
        found)
    (save-excursion
      (let ((limit (line-end-position)))
        (goto-char (line-beginning-position))
        (while (and (not found) (re-search-forward (alist-get format research--citation-regexps) limit t))
          (when (and (<= (match-beginning 0) pos) (< pos (match-end 0)))
            (setq found
                  (if (eq format 'latex)
                      (let* ((keys-start (match-beginning 2))
                             (keys (match-string-no-properties 2))
                             (page (research--page-in (match-string-no-properties 1)))
                             (offset (- pos keys-start))
                             (key nil) (at 0))
                        (dolist (k (split-string keys ","))
                          (when (and (null key) (<= at offset) (<= offset (+ at (length k))))
                            (setq key (string-trim k)))
                          (setq at (+ at (length k) 1)))
                        (cons (or key (string-trim (car (split-string keys ",")))) page))
                    ;; Org and Markdown: `@key' items separated by `;', each with its own locator.
                    (let* ((body-start (match-beginning 1))
                           (body (match-string-no-properties 1))
                           (items (split-string body ";"))
                           (offset (- pos body-start))
                           (at 0) choice first)
                      (dolist (item items)
                        (when (string-match "@\\([[:alnum:]_:.+-]*[[:alnum:]]\\)" item)
                          (let ((entry (cons (match-string 1 item) (research--page-in (substring item (match-end 0))))))
                            (unless first (setq first entry))
                            (when (and (null choice) (<= at offset) (<= offset (+ at (length item))))
                              (setq choice entry))))
                        (setq at (+ at (length item) 1)))
                      (or choice first))))))))
    (or found
        ;; A bare pandoc `@key' under point.
        (when (and (eq format 'markdown)
                   (save-excursion
                     (skip-chars-backward "[:alnum:]_:.+-")
                     (and (eq (char-before) ?@) (looking-at "\\([[:alnum:]_:.+-]*[[:alnum:]]\\)"))))
          (cons (match-string-no-properties 1) nil)))))

;;;###autoload
(defun research-open-citation-at-point ()
  "Show the paper cited under point in the app, at the citation's page."
  (interactive)
  (let ((citation (or (research-citation-at-point) (user-error "No hay una cita aquí"))))
    (research--with-errors
      (research--open-in-app (car citation) (cdr citation))
      (message "Abriendo %s en la app%s" (car citation)
               (if (cdr citation) (format ", p. %s" (cdr citation)) "")))))

;;;; Operations with cost

(defun research--plan-prompt (plan)
  "The question asked before running PLAN.
PLAN is a costly tool's answer without confirmation."
  (format "%s con %s: costo estimado $%.2f (tope $%.2f; gastado este mes $%.2f%s). ¿Continuar? "
          (alist-get 'operation plan) (alist-get 'model plan)
          (or (alist-get 'estimate_usd plan) 0) (or (alist-get 'cap_usd plan) 0)
          (or (alist-get 'month_spent_usd plan) 0)
          (if (alist-get 'month_cap_usd plan) (format " de $%.2f" (alist-get 'month_cap_usd plan)) "")))

(defun research-call-with-cost (tool arguments)
  "Call the costly TOOL with ARGUMENTS after confirming its estimate.
Asks the app for the plan (no `confirmed'), shows it with `yes-or-no-p'
and only then calls with `confirmed: true'.  Returns the answer, or nil
when declined."
  (let ((plan (research-call tool arguments)))
    (if (not (and (consp plan) (alist-get 'confirmation_required plan)))
        plan
      (when (yes-or-no-p (research--plan-prompt plan))
        (research-call tool (append arguments '((confirmed . t))))))))

(defun research--show-answer (answer title)
  "Insert ANSWER's `text' at point, or show ANSWER in a buffer named TITLE."
  (cond ((null answer) (message "Cancelado"))
        ((and (consp answer) (stringp (alist-get 'text answer))) (insert (alist-get 'text answer)))
        (t (with-current-buffer (get-buffer-create title)
             (let ((inhibit-read-only t))
               (erase-buffer)
               (insert (if (stringp answer) answer (pp-to-string answer))))
             (special-mode)
             (pop-to-buffer (current-buffer))))))

;;;; Drafts

(defvar research--draft nil
  "The draft `research-draft' started and is following: a plist with
`:id', `:title', `:timer' and `:failures'; nil when none.")

(defconst research--draft-errors
  '(("draft_budget" . "se alcanzó el tope por borrador")
    ("llm_quota" . "se agotó la cuota de Claude")
    ("llm_timeout" . "Claude tardó demasiado")
    ("llm_invalid_output" . "Claude no devolvió texto")
    ("llm_unavailable" . "Claude no está disponible")
    ("agent_tools_unavailable" . "no se pudieron abrir las herramientas de la biblioteca"))
  "Spanish reasons for the error codes `draft_status' can report.")

;;;###autoload
(defun research-draft (title purpose keys &optional length rq)
  "Ask Claude, through the app, for a draft section TITLE with PURPOSE citing KEYS.
LENGTH is \"short\", \"medium\" (default) or \"long\"; RQ a research
question such as \"RQ1\".  Shows the estimated cost and asks first.  The
app saves the draft in the project («Redacción → Borrador») and writes it
in the background (it can take minutes): Emacs stays free, shows its
progress and, when it is written, opens its text in Org in a new
`*research-draft*' buffer.  `research-draft-stop' stops it.  One draft at
a time: while one is being written this refuses.  Returns the draft's id."
  (interactive
   (progn
     (research--draft-refuse-if-running)
     (list (read-string "Título de la sección: ")
           (read-string "Propósito o indicaciones: ")
           (research-read-keys "Papers que puede citar: ")
           (completing-read "Extensión: " '("short" "medium" "long") nil t nil nil "medium")
           (let ((rq (read-string "Pregunta de investigación, p. ej. RQ1 (vacío: ninguna): ")))
             (unless (string-empty-p rq) (upcase rq))))))
  (research--draft-refuse-if-running)
  (research--with-errors
    (when (string-empty-p (string-trim title)) (user-error "Falta el título"))
    (unless keys (user-error "Elige al menos un paper"))
    (let* ((arguments `((title . ,title) (purpose . ,purpose) (keys . ,(vconcat keys))
                        (length . ,(or length "medium")) ,@(and rq `((rq . ,rq)))))
           (plan (research-call "draft" arguments)))
      ;; A draft another Emacs (or a lost poll) started is still being written: never pay for a second one.
      (when-let* ((running (and (consp plan) (alist-get 'running_draft plan))))
        (user-error "El borrador %s todavía se está escribiendo: espera a que termine o detenlo con `research-draft-stop'" running))
      (if (not (and (consp plan) (alist-get 'confirmation_required plan) (yes-or-no-p (research--plan-prompt plan))))
          (progn (message "Cancelado") nil)
        (let* ((answer (research-call "draft" (append arguments '((confirmed . t)))))
               (id (alist-get 'draft_id answer)))
          (research--draft-follow id title)
          (message "Borrador %s: Claude lo está escribiendo en la app; te aviso cuando esté (`research-draft-stop' lo detiene)" id)
          id)))))

(defun research--draft-refuse-if-running ()
  "Signal a `user-error' when this Emacs is following a draft."
  (when research--draft
    (user-error "El borrador %s todavía se está escribiendo: espera a que termine o detenlo con `research-draft-stop'"
                (plist-get research--draft :id))))

(defun research--draft-follow (id title)
  "Follow the draft ID (TITLE) on a timer until it ends."
  (research--draft-forget)
  (setq research--draft
        (list :id id :title title :failures 0
              :timer (run-with-timer research-draft-poll-interval research-draft-poll-interval
                                     #'research--draft-poll))))

(defun research--draft-forget ()
  "Stop following the draft."
  (when-let* ((timer (plist-get research--draft :timer))) (cancel-timer timer))
  (setq research--draft nil))

(defun research--draft-poll ()
  "Ask the app how the followed draft goes; show it once written."
  (when research--draft
    (let ((id (plist-get research--draft :id))
          (title (plist-get research--draft :title)))
      (condition-case err
          (let ((status (research-call "draft_status" `((draft_id . ,id) (format . "org")))))
            (plist-put research--draft :failures 0)
            (pcase (alist-get 'status status)
              ("running"
               (message "Borrador %s: %d caracteres, %d consultas a la biblioteca…"
                        id (or (alist-get 'chars status) 0) (or (alist-get 'tools status) 0)))
              ((or "done" "stopped")
               (research--draft-forget)
               (research--draft-show status title))
              (_
               (research--draft-forget)
               (let ((code (or (alist-get 'error status) "failed")))
                 (message "El borrador %s no se escribió: %s" id
                          (or (cdr (assoc code research--draft-errors))
                              (cdr (assoc code research--error-messages))
                              code))))))
        (research-error
         ;; The app may be busy or restarting: give up only after a few failures in a row.
         (let ((failures (1+ (plist-get research--draft :failures))))
           (plist-put research--draft :failures failures)
           (when (>= failures 3)
             (research--draft-forget)
             (message "Dejé de seguir el borrador %s: %s.  Míralo en la app («Redacción → Borrador»)"
                      id (research--error-message err)))))))))

(defun research--draft-show (answer title)
  "Open ANSWER, the `draft_status' of a written draft, in a new buffer.
The buffer is `*research-draft*', in Org; TITLE is the one asked for,
when the answer has none.  Returns the buffer."
  (let ((buffer (generate-new-buffer "*research-draft*")))
    (with-current-buffer buffer
      (org-mode)
      (insert (format "#+title: %s\n\n" (or (alist-get 'title answer) title)) (or (alist-get 'text answer) "") "\n")
      (goto-char (point-min))
      (set-buffer-modified-p nil))
    (pop-to-buffer buffer)
    (message "Borrador %s: %d citas sin verificar, %d fuera de la selección, %d sin cita%s (US$%.2f)"
             (alist-get 'draft_id answer)
             (or (alist-get 'unverified answer) 0) (or (alist-get 'outside answer) 0)
             (or (alist-get 'uncited answer) 0)
             (if (equal (alist-get 'status answer) "stopped") "; se detuvo" "")
             (or (alist-get 'costUsd answer) 0))
    buffer))

;;;###autoload
(defun research-draft-stop (&optional id)
  "Stop the draft `research-draft' is following (or the draft ID).
What Claude wrote so far is kept as a stopped version and opens as usual."
  (interactive)
  (research--with-errors
    (let ((id (or id (plist-get research--draft :id)
                  (let ((typed (read-string "Id del borrador: ")))
                    (if (string-empty-p typed) (user-error "No hay un borrador en curso") typed)))))
      (if (alist-get 'stopping (research-call "draft_stop" `((draft_id . ,id))))
          (message "Deteniendo el borrador %s…" id)
        (message "El borrador %s ya no se está escribiendo" id)))))

;;;###autoload
(defun research-check-citations-with-claude (&optional beg end)
  "Ask Claude, through the app, whether the cited papers support each sentence.
The region (BEG..END) or the buffer.  Shows the estimated cost and asks
first; the verdicts show as Flymake diagnostics with the paper's quote and
page: an error when the paper does not support the sentence or its quote
was not found, a warning for partial support or no passage found, a note
when it supports it.  Then `*research-cite-check*' lists every sentence,
the weakest first, with each verdict, Claude's note and quote and, for a
sentence that is not well supported, papers of your library that may
support it (free and local; see `research-cite-check-suggest')."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((beg (or beg (point-min)))
           (end (or end (point-max)))
           (answer (research-call-with-cost
                    "cite_check" `((text . ,(buffer-substring-no-properties beg end))
                                   (format . ,(symbol-name (research--format)))))))
      (if (null answer)
          (message "Cancelado")
        (setq research--claude-diagnostics (research--markers (research--verdict-diagnostics answer beg)))
        (research--flymake-refresh)
        (let ((summary (research--cite-check-summary answer)))
          (research--cite-check-report answer beg summary)
          (message "%s — ver *research-cite-check*" summary))
        answer))))

(defun research--cite-check-summary (answer)
  "The one-line summary of a `cite_check' ANSWER."
  (let ((counts (alist-get 'counts answer)))
    (format "Claude: %d respaldan, %d en parte, %d no respaldan, %d sin pasaje, %d sin verificar%s (US$%.2f)"
            (or (alist-get 'supports counts) 0) (or (alist-get 'partial counts) 0)
            (or (alist-get 'does_not_support counts) 0) (or (alist-get 'not_found counts) 0)
            (or (alist-get 'unverified counts) 0)
            (cond ((alist-get 'error answer) (format "; se detuvo: %s" (alist-get 'error answer)))
                  ((alist-get 'stopped answer) "; se detuvo")
                  (t ""))
            (or (alist-get 'costUsd answer) 0))))

(defconst research--outcomes
  '(("supports" :note "respalda")
    ("partial" :warning "respalda en parte")
    ("does_not_support" :error "no respalda")
    ("not_found" :warning "no se encontró un pasaje que lo respalde")
    ("no_evidence" :error "evidencia no encontrada en el paper")
    ("unverified" :note "sin verificar"))
  "Each outcome of the check with Claude: its Flymake type and its words.")

(defconst research--unverified-reasons
  '(("unknown" . "no está en la biblioteca") ("trashed" . "está en la papelera")
    ("no_text" . "sin texto indexado") ("not_checked" . "no se alcanzó a verificar")
    ("no_answer" . "Claude no respondió") ("invalid_output" . "respuesta no válida"))
  "Why a pair was not verified.")

(defun research--verdict-diagnostics (answer base)
  "Diagnostics (BEG END TYPE TEXT) of a `cite_check' ANSWER.
Its text starts at BASE.  Each key's diagnostic covers its citation (the
sentence when none names it)."
  (let (out)
    (dolist (sentence (alist-get 'sentences answer))
      (dolist (entry (alist-get 'entries sentence))
        (let* ((key (alist-get 'key entry))
               (citation (cl-find-if (lambda (c) (member key (alist-get 'keys c))) (alist-get 'citations sentence)))
               (span (or citation sentence))
               (outcome (assoc (alist-get 'outcome entry) research--outcomes))
               (quote (alist-get 'quote entry))
               (page (alist-get 'page entry))
               (note (alist-get 'note entry))
               (reason (cdr (assoc (alist-get 'reason entry) research--unverified-reasons))))
          (push (list (+ base (alist-get 'start span)) (+ base (alist-get 'end span))
                      (or (nth 1 outcome) :note)
                      (concat key ": " (or (nth 2 outcome) "sin verificar")
                              (if reason (format " (%s)" reason) "")
                              (if quote (format " — «%s»%s" quote (if page (format ", p. %s" page) "")) "")
                              (if note (format ". %s" note) "")))
                out))))
    (nreverse out)))

;;;;; The report of the check with Claude

(defcustom research-cite-check-suggest t
  "Whether the report of `research-check-citations-with-claude' suggests papers.
For each sentence a cited paper does not (fully) support, the app looks
in your library for papers that may support it (`suggest_citations':
local and free, no Claude).  They are hints to read, not verified."
  :type 'boolean)

(defconst research--cite-check-order
  '("does_not_support" "no_evidence" "not_found" "partial" "unverified" "supports")
  "The outcomes of the check, worst first: the report's order.")

(defconst research--cite-check-weak '("does_not_support" "partial" "not_found" "no_evidence")
  "Outcomes for which the report suggests other papers.")

(defvar-local research--cite-check-source nil "The buffer the report is of.")

(defvar research-cite-check-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'research-cite-check-visit)
    (define-key map (kbd "o") #'research-cite-check-open)
    (define-key map (kbd "i") #'research-cite-check-insert)
    (define-key map (kbd "n") #'research-cite-check-next)
    (define-key map (kbd "p") #'research-cite-check-previous)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keys of `*research-cite-check*'.")

(define-derived-mode research-cite-check-mode org-mode "Research-Cite-Check"
  "The report of a citation check with Claude, read-only.
\\{research-cite-check-mode-map}"
  (setq buffer-read-only t))

(defun research--cite-check-worst (sentence)
  "The worst outcome of SENTENCE's entries."
  (let ((outcomes (mapcar (lambda (e) (alist-get 'outcome e)) (alist-get 'entries sentence))))
    (or (cl-find-if (lambda (o) (member o outcomes)) research--cite-check-order) "unverified")))

(defun research--cite-check-weak-p (sentence)
  "Whether SENTENCE has an entry for which other papers are suggested."
  (cl-some (lambda (e) (member (alist-get 'outcome e) research--cite-check-weak)) (alist-get 'entries sentence)))

(defun research--cite-check-icon (outcome)
  "The heading icon of OUTCOME."
  (pcase outcome
    ((or "does_not_support" "no_evidence") "✗")
    ("supports" "✓")
    (_ "!")))

(defun research--cite-check-truncate (text n)
  "TEXT with its whitespace collapsed, cut to N characters."
  (let ((text (string-trim (replace-regexp-in-string "[ \t\n]+" " " (or text "")))))
    (if (> (length text) n) (concat (substring text 0 (1- n)) "…") text)))

(defun research--cite-check-suggestions (sentences)
  "The `suggest_citations' answer for SENTENCES (weak ones), or nil.
Nil too when suggestions are off or the app does not have the tool."
  (when (and research-cite-check-suggest sentences)
    (condition-case err
        (let ((answer (research-call
                       "suggest_citations"
                       `((sentences . ,(vconcat
                                        (mapcar (lambda (s)
                                                  `((text . ,(research--cite-check-truncate (alist-get 'text s) 2000))
                                                    (exclude . ,(vconcat
                                                                 (cl-remove-if-not
                                                                  (lambda (k) (string-match-p "\\`[a-z][a-z0-9]*\\'" k))
                                                                  (delete-dups (mapcar (lambda (e) (alist-get 'key e))
                                                                                       (alist-get 'entries s))))))))
                                                sentences)))))))
          (and (listp answer) answer))
      (research-error
       (message "Sin sugerencias de la biblioteca: %s" (research--error-message err))
       nil))))

(defun research--cite-check-entry-lines (entry)
  "The lines of one ENTRY (a cited key) of the report."
  (let* ((key (alist-get 'key entry))
         (outcome (alist-get 'outcome entry))
         (words (or (nth 2 (assoc outcome research--outcomes)) "sin verificar"))
         (reason (cdr (assoc (alist-get 'reason entry) research--unverified-reasons)))
         (note (alist-get 'note entry))
         (quote (alist-get 'quote entry))
         (page (alist-get 'page entry)))
    (concat (format "- [%s] %s%s" key words (if reason (format " (%s)" reason) ""))
            (if note (format "\n  Claude: %s" note) "")
            (if quote
                (format "\n  «%s»%s — %s" quote (if page (format " (p. %s)" page) "")
                        (if (alist-get 'found entry) "cita encontrada en el paper" "cita no encontrada en el paper"))
              "")
            "\n")))

(defun research--cite-check-suggestion-line (s)
  "The line of the suggestion S."
  (format "- [%s] %s (%s)%s: «%s»\n" (alist-get 'key s) (alist-get 'title s)
          (or (alist-get 'year s) "s. f.")
          (if (alist-get 'page s) (format ", p. %s" (alist-get 'page s)) "")
          (alist-get 'quote s)))

(defun research--cite-check-insert-item (text item &optional suggestion)
  "Insert TEXT, whose `o' opens ITEM (an alist with key, page, quote).
With SUGGESTION, `i' inserts ITEM's key into the sentence."
  (let ((start (point)))
    (insert text)
    (add-text-properties start (1- (point)) `(research-cite-item ,item research-cite-suggestion ,suggestion))))

(defun research--cite-check-report (answer base summary)
  "Show `*research-cite-check*' for a `cite_check' ANSWER of text at BASE.
SUMMARY is the one-line counts and cost.  The current buffer is the one
checked."
  (let* ((source (current-buffer))
         (fmt (research--format))
         (file (if buffer-file-name (file-name-nondirectory buffer-file-name) (buffer-name)))
         (section (research--ask-section base))
         (sentences (mapcar (lambda (s)
                              (let ((beg (+ base (alist-get 'start s))) (end (+ base (alist-get 'end s))))
                                (list s (list :beg (copy-marker beg) :end (copy-marker end t)
                                              :text (buffer-substring-no-properties beg end) :format fmt))))
                            (alist-get 'sentences answer)))
         (sorted (cl-stable-sort (copy-sequence sentences) #'<
                                 :key (lambda (s) (cl-position (research--cite-check-worst (car s)) research--cite-check-order
                                                               :test #'equal))))
         (weak (cl-remove-if-not (lambda (s) (research--cite-check-weak-p (car s))) sorted))
         (suggested (research--cite-check-suggestions (mapcar #'car weak)))
         (buffer (get-buffer-create "*research-cite-check*")))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (research-cite-check-mode)
        (setq research--cite-check-source source)
        (insert "Verificación de citas con Claude\n"
                (format "Archivo: %s%s\n" file (if (string-empty-p section) "" (concat " › " section)))
                (format "Fecha: %s\n" (format-time-string "%Y-%m-%d %H:%M"))
                summary "\n"
                "RET va a la oración · o abre en la app · i inserta la sugerencia · n/p · q cierra\n")
        (when (null sorted) (insert "\nNinguna oración con citas que se pudieran verificar.\n"))
        (dolist (s sorted)
          (let* ((sentence (car s))
                 (place (cadr s))
                 (start (point))
                 (weak-index (cl-position s weak :test #'eq))
                 (suggestions (and weak-index (alist-get 'suggestions (nth weak-index suggested)))))
            (insert "\n* " (research--cite-check-icon (research--cite-check-worst sentence)) " "
                    (research--cite-check-truncate (alist-get 'text sentence) 120) "\n")
            (dolist (entry (alist-get 'entries sentence))
              (research--cite-check-insert-item (research--cite-check-entry-lines entry) entry))
            (when (and weak-index suggested)
              (insert "Sugerencias de tu biblioteca:\n")
              (if (null suggestions)
                  (insert "  (ninguna)\n")
                (dolist (sg suggestions)
                  (research--cite-check-insert-item (research--cite-check-suggestion-line sg) sg t))))
            (put-text-property start (point) 'research-cite-sentence place)))
        (goto-char (point-min))))
    (display-buffer buffer '((display-buffer-in-side-window) (side . right) (window-width . 0.45)))
    buffer))

(defun research--cite-check-place ()
  "The sentence (a plist) of the report's entry at point."
  (or (get-text-property (point) 'research-cite-sentence)
      (and (> (point) (point-min)) (get-text-property (1- (point)) 'research-cite-sentence))
      (user-error "Aquí no hay una oración del informe")))

(defun research--cite-check-item ()
  "The citation or suggestion at point."
  (or (get-text-property (point) 'research-cite-item)
      (user-error "Aquí no hay una cita ni una sugerencia")))

(defun research--cite-check-live (place)
  "PLACE's source buffer, refusing when it is gone or the sentence changed."
  (let ((buffer (marker-buffer (plist-get place :beg))))
    (unless (buffer-live-p buffer) (user-error "El búfer de origen ya no existe"))
    (unless (equal (with-current-buffer buffer
                     (buffer-substring-no-properties (plist-get place :beg) (plist-get place :end)))
                   (plist-get place :text))
      (user-error "La oración cambió desde la verificación: vuelve a verificarla"))
    buffer))

(defun research-cite-check-visit ()
  "Go to the sentence of the entry at point in the checked buffer."
  (interactive)
  (let* ((place (research--cite-check-place))
         (marker (plist-get place :beg)))
    (unless (buffer-live-p (marker-buffer marker)) (user-error "El búfer de origen ya no existe"))
    (pop-to-buffer (marker-buffer marker))
    (goto-char marker)))

(defun research-cite-check-open ()
  "Show the paper of the citation or suggestion at point in the app."
  (interactive)
  (let ((item (research--cite-check-item)))
    (research--with-errors
      (research--open-in-app (alist-get 'key item) (alist-get 'page item) (alist-get 'quote item))
      (message "Abriendo %s en la app%s" (alist-get 'key item)
               (if (alist-get 'page item) (format ", p. %s" (alist-get 'page item)) "")))))

(defun research--cite-check-add-key (beg end key format)
  "Cite KEY in the sentence BEG..END of the current buffer, in FORMAT.
Added to the sentence's last citation, else a new citation before the
sentence's final punctuation."
  (save-excursion
    (goto-char beg)
    (let (last)
      (while (re-search-forward (alist-get format research--citation-regexps) end t)
        (setq last (list (match-beginning 0) (match-end 0) (and (eq format 'latex) (match-end 2)))))
      (if last
          (pcase format
            ('latex (goto-char (nth 2 last)) (insert "," key))
            ('markdown (goto-char (1- (nth 1 last))) (insert "; @" key))
            (_ (goto-char (1- (nth 1 last))) (insert ";@" key)))
        (goto-char end)
        (skip-chars-backward " \t\n" beg)
        (skip-chars-backward ".!?;:…" beg)
        (skip-chars-backward " \t\n" beg)
        (insert " " (research-format-citation key nil format))))))

(defun research-cite-check-insert ()
  "Add the suggestion at point to its sentence's citation in the checked buffer.
In the sentence's own citation format (Org `[cite:@a;@key]', LaTeX
`\\cite{a,key}', Markdown `[@a; @key]'); a sentence without a citation
gets a new one before its final punctuation.  Refused when the sentence
changed since the check."
  (interactive)
  (let* ((item (research--cite-check-item))
         (place (research--cite-check-place)))
    (unless (get-text-property (point) 'research-cite-suggestion)
      (user-error "Pon el cursor sobre una sugerencia"))
    (let ((buffer (research--cite-check-live place))
          (key (alist-get 'key item)))
      (with-current-buffer buffer
        (research--cite-check-add-key (plist-get place :beg) (plist-get place :end) key (plist-get place :format))
        (plist-put place :text (buffer-substring-no-properties (plist-get place :beg) (plist-get place :end))))
      (message "Cité %s en la oración" key))))

(defun research--cite-check-move (forward)
  "Move to the next (FORWARD) or previous sentence heading."
  (let ((found (save-excursion
                 (if forward
                     (progn (end-of-line) (and (re-search-forward "^\\* " nil t) (match-beginning 0)))
                   (beginning-of-line)
                   (re-search-backward "^\\* " nil t)))))
    (if found (goto-char found) (message "No hay más oraciones"))))

(defun research-cite-check-next ()
  "Go to the next sentence of the report."
  (interactive)
  (research--cite-check-move t))

(defun research-cite-check-previous ()
  "Go to the previous sentence of the report."
  (interactive)
  (research--cite-check-move nil))

;;;###autoload
(defun research-propose-outline (&optional ask)
  "Insert the outline with Claude's proposed wording, through the app.
Headings, order, an opening per section and a sentence per gap, every
citation checked by the app.  With ASK (a prefix argument), ask for the
outline's choices as `research-insert-outline' does.  Shows the estimated
cost and asks first."
  (interactive "P")
  (research--with-errors
    (let ((answer (research-call-with-cost "outline_proposal" (research--outline-args ask))))
      (if (null answer)
          (message "Cancelado")
        (insert (alist-get 'text answer))
        (let ((unverified (or (alist-get 'unverified answer) 0)))
          (message "Propuesta insertada%s (US$%.2f)"
                   (if (> unverified 0) (format "; %d citas sin verificar (marcadas en el texto)" unverified) "")
                   (or (alist-get 'costUsd answer) 0)))
        answer))))

(defface research-style-suggestion '((t :inherit query-replace))
  "Face of the style suggestion being asked about.")

(defun research--style-decide (suggestions base)
  "Ask about each of SUGGESTIONS (in text order) whose text starts at BASE.
Returns the accepted ones.  y accepts, n skips, ! accepts this and the
rest, q stops (keeping what was accepted)."
  (let (accepted all overlay)
    (unwind-protect
        (catch 'done
          (dolist (s suggestions)
            (let ((beg (+ base (alist-get 'start s)))
                  (end (+ base (alist-get 'end s))))
              (if all
                  (push s accepted)
                (when overlay (delete-overlay overlay))
                (setq overlay (make-overlay beg end))
                (overlay-put overlay 'face 'research-style-suggestion)
                (goto-char beg)
                (pcase (read-char-choice
                        (format "«%s» → «%s» (%s: %s) ¿Aplicar? (y/n/!/q) "
                                (alist-get 'original s) (alist-get 'suggestion s)
                                (alist-get 'category s) (alist-get 'reason s))
                        '(?y ?n ?! ?q))
                  (?y (push s accepted))
                  (?! (push s accepted) (setq all t))
                  (?q (throw 'done nil)))))))
      (when overlay (delete-overlay overlay)))
    (nreverse accepted)))

;;;###autoload
(defun research-style-review (&optional beg end)
  "Review the style of the region (BEG..END) or the buffer with Claude.
Through the app.  Walks the suggestions like `query-replace' (y, n, !, q),
then applies the accepted ones.  Refuses when the text changed since the
request.  Shows the estimated cost and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((beg (copy-marker (or beg (point-min))))
           (end (copy-marker (or end (point-max)) t))
           (text (buffer-substring-no-properties beg end))
           (tick (buffer-chars-modified-tick))
           (answer (research-call-with-cost "style" `((text . ,text) (format . ,(symbol-name (research--format))))))
           (suggestions (sort (copy-sequence (alist-get 'suggestions answer))
                              (lambda (a b) (< (alist-get 'start a) (alist-get 'start b))))))
      (cond
       ((null answer) (message "Cancelado"))
       ((or (/= tick (buffer-chars-modified-tick))
            (not (equal text (buffer-substring-no-properties beg end))))
        (user-error "El texto cambió desde que se pidió la revisión: vuelve a pedirla"))
       ((null suggestions) (message "Sin sugerencias de estilo"))
       (t
        (let ((accepted (save-excursion (research--style-decide suggestions (marker-position beg)))))
          ;; From the end, so the offsets of the earlier ones stay valid.
          (dolist (s (reverse accepted))
            (let ((from (+ beg (alist-get 'start s)))
                  (to (+ beg (alist-get 'end s))))
              (when (equal (buffer-substring-no-properties from to) (alist-get 'original s))
                (save-excursion
                  (goto-char from)
                  (delete-region from to)
                  (insert (alist-get 'suggestion s))))))
          (message "%d de %d sugerencias aplicadas" (length accepted) (length suggestions)))))
      answer)))

;;;; The tutor

;; Claude reads what you wrote and points, explains and asks; it never writes
;; your text.  Each command shows the plan (estimated cost, caps) and asks.

(defconst research--tutor-limits
  '(("tutor" . 8000) ("alternatives" . 600) ("reverse_outline" . 20000) ("rq_coverage" . 40000))
  "The most characters each tutor tool reads at once.")

(defun research--tutor-check-size (tool text)
  "Signal a `user-error' when TEXT is longer than TOOL reads."
  (let ((limit (cdr (assoc tool research--tutor-limits))))
    (when (string-empty-p (string-trim text)) (user-error "No hay texto que leer aquí"))
    (when (> (length text) limit)
      (user-error "El texto tiene %d caracteres y esta función lee hasta %d: selecciona una parte más corta"
                  (length text) limit))))

(defconst research--tutor-kinds
  '(("ambiguity" . "ambigüedad") ("logical_gap" . "salto lógico") ("connector" . "conector")
    ("lost_subject" . "sujeto perdido") ("register" . "registro") ("cohesion" . "cohesión")
    ("rhythm" . "ritmo") ("precision" . "precisión"))
  "The tutor's kinds of issue, in Spanish.")

(defconst research--alternative-aspects
  '(("emphasis" . "énfasis") ("order" . "orden") ("rhythm" . "ritmo") ("concision" . "concisión")
    ("register" . "registro") ("precision" . "precisión") ("connection" . "enlace"))
  "What an alternative changes, in Spanish.")

(defconst research--paragraph-flags
  '(("two_ideas" . "dos ideas") ("missing_transition" . "sin transición") ("off_topic" . "fuera del tema"))
  "The reverse outline's flags, in Spanish.")

(defun research--label (code table)
  "CODE's Spanish words in TABLE, or CODE."
  (or (cdr (assoc code table)) code))

(defvar-local research--tutor-diagnostics nil
  "The tutor's notes in this buffer: (BEG-MARKER END-MARKER TYPE TEXT).")

(defun research-tutor-flymake (report-fn &rest _)
  "Flymake backend: report the tutor's notes to REPORT-FN."
  (funcall report-fn
           (cl-loop for (beg end type text) in research--tutor-diagnostics
                    when (and (marker-buffer beg) (< beg end))
                    collect (flymake-make-diagnostic (current-buffer) (marker-position beg)
                                                     (marker-position end) type text))))

(defun research--paragraph-bounds ()
  "The (BEG . END) of the paragraph at point."
  (save-excursion
    (let ((end (progn (forward-paragraph) (skip-chars-backward " \t\n") (point)))
          (beg (progn (backward-paragraph) (skip-chars-forward " \t\n") (point))))
      (cons (min beg end) (max beg end)))))

(defun research--tutor-notes (answer base)
  "The tutor ANSWER's issues as diagnostics (BEG END TYPE TEXT) from BASE."
  (mapcar (lambda (i)
            (list (+ base (alist-get 'start i)) (+ base (alist-get 'end i)) :note
                  (format "Tutor [%s]: %s %s" (research--label (alist-get 'kind i) research--tutor-kinds)
                          (alist-get 'explanation i) (alist-get 'question i))))
          (alist-get 'issues answer)))

;;;###autoload
(defun research-tutor (&optional beg end)
  "Ask the tutor about the region (BEG..END) or the paragraph at point.
Claude, through the app, points at what may weaken the text (ambiguity,
logical gaps, connectors, lost subjects, register, cohesion, rhythm,
precision) and, for each, explains why and asks one question that leads
you to the fix.  It never rewrites your text.  The notes show with
Flymake (their own backend) and replace the earlier ones of the same
stretch.  Shows the estimated cost and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((bounds (if (and beg end) (cons beg end) (research--paragraph-bounds)))
           (beg (car bounds)) (end (cdr bounds))
           (text (buffer-substring-no-properties beg end)))
      (research--tutor-check-size "tutor" text)
      (let ((answer (research-call-with-cost "tutor" `((text . ,text) (format . ,(symbol-name (research--format)))))))
        (if (null answer)
            (progn (message "Cancelado") nil)
          (setq research--tutor-diagnostics
                (append (cl-remove-if (lambda (d) (and (>= (nth 0 d) beg) (<= (nth 1 d) end))) research--tutor-diagnostics)
                        (research--markers (research--tutor-notes answer beg))))
          (research--flymake-refresh #'research-tutor-flymake)
          (let ((dropped (apply #'+ (mapcar #'cdr (alist-get 'dropped answer)))))
            (message "Tutor: %d observaciones%s (US$%.2f)" (length (alist-get 'issues answer))
                     (if (> dropped 0) (format "; %d descartadas (no estaban en el texto o reescribían)" dropped) "")
                     (or (alist-get 'costUsd answer) 0)))
          answer)))))

(defun research-tutor-clear ()
  "Forget the tutor's notes in this buffer."
  (interactive)
  (setq research--tutor-diagnostics nil)
  (when (bound-and-true-p flymake-mode) (flymake-start)))

;;;; Alternatives of a sentence

(defvar-local research--alternatives-origin nil
  "Where the sentence is: (BUFFER BEG-MARKER END-MARKER ORIGINAL).")

(defvar research-alternatives-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'research-alternatives-choose)
    (define-key map (kbd "n") #'research-alternatives-next)
    (define-key map (kbd "p") #'research-alternatives-previous)
    (define-key map (kbd "q") #'research-alternatives-keep)
    map)
  "Keymap of `research-alternatives-mode'.")

(define-derived-mode research-alternatives-mode special-mode "Research-Alternatives"
  "Other ways to phrase your sentence, to compare.
\\<research-alternatives-mode-map>\\[research-alternatives-choose] puts the one at point in place of your sentence (only if you have not
changed it meanwhile); \\[research-alternatives-keep] keeps yours.")

(defun research--sentence-bounds ()
  "The (BEG . END) of the sentence at point (one space ends a sentence)."
  (save-excursion
    (let* ((sentence-end-double-space nil)
           (end (progn (forward-sentence) (point)))
           (beg (progn (backward-sentence) (point))))
      (cons beg end))))

(defun research--alternative-starts ()
  "Where each alternative of the buffer starts."
  (let ((pos (point-min)) starts)
    (while pos
      (when (and (get-text-property pos 'research-alternative)
                 (or (= pos (point-min)) (not (get-text-property (1- pos) 'research-alternative))))
        (push pos starts))
      (setq pos (next-single-property-change pos 'research-alternative)))
    (nreverse starts)))

(defun research-alternatives-next ()
  "Move to the next alternative."
  (interactive)
  (let ((next (cl-find-if (lambda (p) (> p (point))) (research--alternative-starts))))
    (when next (goto-char next))))

(defun research-alternatives-previous ()
  "Move to the previous alternative."
  (interactive)
  (let ((prev (cl-find-if (lambda (p) (< p (point))) (reverse (research--alternative-starts)))))
    (when prev (goto-char prev))))

(defun research--alternatives-close ()
  "Close the alternatives buffer: quit its window when shown, else kill it.
`quit-window' alone acts on the selected window, which need not show this
buffer (e.g. when called from another window or in batch)."
  (let* ((buffer (current-buffer))
         (window (get-buffer-window buffer)))
    (if window
        (quit-window t window)
      (kill-buffer buffer))))

(defun research-alternatives-choose ()
  "Put the alternative at point in place of the sentence, if it is unchanged."
  (interactive)
  (let ((alternative (or (get-text-property (point) 'research-alternative) (user-error "No hay una alternativa aquí")))
        (origin research--alternatives-origin))
    (pcase-let ((`(,buffer ,beg ,end ,original) origin))
      (unless (buffer-live-p buffer) (user-error "El búfer de origen ya no existe"))
      (with-current-buffer buffer
        (unless (equal (buffer-substring-no-properties beg end) original)
          (user-error "La oración cambió desde que pediste las alternativas: no la toco"))
        (save-excursion
          (goto-char beg)
          (delete-region beg end)
          (insert alternative)))
      (research--alternatives-close)
      (message "Oración reemplazada (deshaz con %s en el búfer)" (substitute-command-keys "\\[undo]")))))

(defun research-alternatives-keep ()
  "Close the alternatives and keep your sentence."
  (interactive)
  (research--alternatives-close)
  (message "Conservas tu oración"))

;;;###autoload
(defun research-alternatives (&optional beg end)
  "Ask for other ways to phrase the sentence at point (or the region BEG..END).
Two or three, through the app.  Each one says what it changes (emphasis,
order, rhythm…) so you can compare; they keep your citations, math and
commands.
A buffer lists them: RET puts the one at point in place of your sentence,
only if you have not changed it; q keeps yours.  Shows the estimated cost
and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((bounds (if (and beg end) (cons beg end) (research--sentence-bounds)))
           (beg (car bounds)) (end (cdr bounds))
           (sentence (string-trim (buffer-substring-no-properties beg end)))
           (beg (save-excursion (goto-char beg) (skip-chars-forward " \t\n") (point)))
           (end (+ beg (length sentence)))
           (paragraph (research--paragraph-bounds))
           (context (buffer-substring-no-properties (car paragraph) (cdr paragraph)))
           (origin (list (current-buffer) (copy-marker beg) (copy-marker end t) sentence)))
      (research--tutor-check-size "alternatives" sentence)
      (let ((answer (research-call-with-cost
                     "alternatives" `((sentence . ,sentence) (format . ,(symbol-name (research--format)))
                                      ,@(and (<= (length context) 4000) (not (equal (string-trim context) sentence))
                                             `((context . ,context)))))))
        (if (null answer)
            (progn (message "Cancelado") nil)
          (let ((buffer (get-buffer-create "*research alternatives*"))
                (alternatives (alist-get 'alternatives answer)))
            (with-current-buffer buffer
              (research-alternatives-mode)
              (setq research--alternatives-origin origin)
              (let ((inhibit-read-only t))
                (erase-buffer)
                (insert (propertize "Tu oración (q: quedártela; RET: usar la alternativa bajo el cursor)\n" 'face 'shadow)
                        sentence "\n\n")
                (if (null alternatives)
                    (insert "Sin alternativas válidas.\n")
                  (cl-loop for a in alternatives for i from 1 do
                           (let ((start (point)))
                             (insert (propertize (format "%d. %s: %s\n" i
                                                         (research--label (alist-get 'aspect a) research--alternative-aspects)
                                                         (alist-get 'what_changes a))
                                                 'face 'bold)
                                     (alist-get 'text a) "\n")
                             (put-text-property start (point) 'research-alternative (alist-get 'text a))
                             (insert "\n")))))
              (goto-char (point-min))
              (research-alternatives-next))
            (pop-to-buffer buffer)
            answer))))))

;;;; Reverse outline

(defvar-local research--outline-origin nil "The buffer the reverse outline is of.")

(defvar research-outline-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'research-outline-visit)
    (define-key map (kbd "n") #'next-line)
    (define-key map (kbd "p") #'previous-line)
    map)
  "Keymap of `research-outline-mode'.")

(define-derived-mode research-outline-mode special-mode "Research-Outline"
  "A report whose lines point into a buffer.
\\<research-outline-mode-map>\\[research-outline-visit] jumps to the passage of the line at point.")

(defun research-outline-visit ()
  "Jump to the passage of the line at point."
  (interactive)
  (let ((marker (or (get-text-property (point) 'research-target) (user-error "Esta línea no apunta a un pasaje"))))
    (unless (buffer-live-p (marker-buffer marker)) (user-error "El búfer de origen ya no existe"))
    (pop-to-buffer (marker-buffer marker))
    (goto-char marker)))

(defun research--section-bounds ()
  "The (BEG . END) of the Org subtree at point, or of the buffer."
  (if (and (derived-mode-p 'org-mode) (fboundp 'org-back-to-heading)
           (save-excursion (ignore-errors (org-back-to-heading t) t)))
      (save-excursion
        (org-back-to-heading t)
        (cons (point) (progn (org-end-of-subtree t t) (point))))
    (cons (point-min) (point-max))))

(defun research--report-buffer (name origin)
  "A fresh `research-outline-mode' buffer NAME for ORIGIN."
  (let ((buffer (get-buffer-create name)))
    (with-current-buffer buffer
      (research-outline-mode)
      (setq research--outline-origin origin)
      (let ((inhibit-read-only t)) (erase-buffer)))
    buffer))

(defun research--insert-target (text marker &optional face)
  "Insert TEXT (with FACE) whose RET jumps to MARKER."
  (let ((start (point)))
    (insert (if face (propertize text 'face face) text))
    (put-text-property start (point) 'research-target marker)))

;;;###autoload
(defun research-reverse-outline (&optional beg end)
  "The reverse outline of the section at point (or the region BEG..END).
Through the app: each paragraph's main idea in your own terms and what
may be wrong with it (two ideas in one paragraph, a missing transition,
off the heading's topic), in a side buffer; RET jumps to the paragraph.
Nothing is rewritten.  Shows the estimated cost and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (let* ((bounds (if (and beg end) (cons beg end) (research--section-bounds)))
           (beg (car bounds))
           (text (buffer-substring-no-properties beg (cdr bounds)))
           (origin (current-buffer)))
      (research--tutor-check-size "reverse_outline" text)
      (let ((answer (research-call-with-cost "reverse_outline" `((text . ,text) (format . ,(symbol-name (research--format)))))))
        (if (null answer)
            (progn (message "Cancelado") nil)
          (let ((buffer (research--report-buffer "*research reverse outline*" origin))
                (heading 'none))
            (with-current-buffer buffer
              (let ((inhibit-read-only t))
                (insert (propertize (format "Esquema inverso de %s (RET: ir al párrafo)\n" (buffer-name origin)) 'face 'shadow))
                (dolist (p (alist-get 'paragraphs answer))
                  (let ((marker (with-current-buffer origin (copy-marker (+ beg (alist-get 'start p))))))
                    (unless (equal heading (alist-get 'heading p))
                      (setq heading (alist-get 'heading p))
                      (insert "\n" (propertize (or heading "(sin encabezado)") 'face 'bold) "\n"))
                    (research--insert-target
                     (format "%3d. %s%s\n" (alist-get 'index p) (alist-get 'main_idea p)
                             (mapconcat (lambda (f) (format "  [%s: %s]" (research--label (alist-get 'flag f) research--paragraph-flags)
                                                            (alist-get 'note f)))
                                        (alist-get 'flags p) ""))
                     marker (and (alist-get 'flags p) 'warning)))))
              (goto-char (point-min))
              (forward-line 2))
            (display-buffer buffer '((display-buffer-in-side-window) (side . right) (window-width . 0.4)))
            (message "Esquema inverso: %d párrafos, %d con señales (US$%.2f)" (length (alist-get 'paragraphs answer))
                     (cl-count-if (lambda (p) (alist-get 'flags p)) (alist-get 'paragraphs answer))
                     (or (alist-get 'costUsd answer) 0))
            answer))))))

;;;; Research questions coverage

;;;###autoload
(defun research-rq-coverage (&optional subtree)
  "Which of the thesis' research questions each heading addresses.
The region, or the whole file; with a prefix argument SUBTREE, the Org
subtree at point.  Through the app: per heading, the questions it
addresses with a short excerpt as evidence (verified in your text), and
the questions no heading addresses, in a report buffer; RET on an
excerpt jumps to it.  Shows the estimated cost and asks first."
  (interactive "P")
  (research--with-errors
    (let* ((bounds (cond ((use-region-p) (cons (region-beginning) (region-end)))
                         (subtree (research--section-bounds))
                         (t (cons (point-min) (point-max)))))
           (beg (car bounds))
           (text (buffer-substring-no-properties beg (cdr bounds)))
           (origin (current-buffer)))
      (research--tutor-check-size "rq_coverage" text)
      (let ((answer (research-call-with-cost "rq_coverage" `((text . ,text) (format . ,(symbol-name (research--format)))))))
        (if (null answer)
            (progn (message "Cancelado") nil)
          (let ((buffer (research--report-buffer "*research RQ coverage*" origin))
                (questions (alist-get 'questions answer)))
            (with-current-buffer buffer
              (let ((inhibit-read-only t))
                (insert (propertize (format "Preguntas de investigación en %s (RET: ir a la evidencia)\n\n" (buffer-name origin)) 'face 'shadow))
                (dolist (q questions)
                  (insert (format "%s: %s\n" (alist-get 'id q) (alist-get 'text q))))
                (dolist (s (alist-get 'sections answer))
                  (let ((marker (with-current-buffer origin (copy-marker (+ beg (alist-get 'start s)))))
                        (addresses (alist-get 'addresses s)))
                    (insert "\n")
                    (research--insert-target
                     (format "%s — %s\n" (or (alist-get 'heading s) "(sin encabezado)")
                             (if addresses (mapconcat (lambda (a) (alist-get 'rq a)) addresses ", ") "ninguna"))
                     marker 'bold)
                    (dolist (a addresses)
                      (research--insert-target
                       (format "  %s: «%s»\n" (alist-get 'rq a) (replace-regexp-in-string "[ \t\n]+" " " (alist-get 'excerpt a)))
                       (with-current-buffer origin (copy-marker (+ beg (alist-get 'start a))))))))
                (insert "\n" (propertize "Sin abordar: " 'face 'bold)
                        (if (alist-get 'not_addressed answer) (string-join (alist-get 'not_addressed answer) ", ") "ninguna")
                        "\n"))
              (goto-char (point-min)))
            (pop-to-buffer buffer)
            (message "Cobertura: %d preguntas sin abordar (US$%.2f)" (length (alist-get 'not_addressed answer))
                     (or (alist-get 'costUsd answer) 0))
            answer))))))

;;;; Asking Claude about what you write

;; `research-ask' sends a passage (the selection, else the whole file; the
;; paragraph or the section with a prefix) with your question, and as
;; background the chapter it is in and the outline of the whole thesis;
;; Claude answers as a reader of your thesis: what works, what to change and
;; why, and questions.  It does not rewrite your text unless you allow a
;; proposed rewrite for that question.  The answer streams into
;; `*research-ask*'; your buffer is never touched.

(declare-function org-get-outline-path "org")
(declare-function evil-visual-state-p "evil-states")
(defvar evil-visual-beginning)
(defvar evil-visual-end)
(defvar evil-visual-selection)

(defcustom research-ask-poll-interval 2
  "Seconds between two looks at the answer `research-ask' is following."
  :type 'number)

(defcustom research-ask-allow-edits nil
  "Whether `research-ask' may offer to let Claude edit your file.
When non-nil, the prompt before sending a question offers `e': Claude
answers with exact changes to the passage and they are applied to your
buffer (marked; one `undo' takes them all back).  Nil (the default):
Claude only comments, or proposes a version when you allow it with `r'."
  :type 'boolean)

(defcustom research-ask-auto-send-below 0.25
  "Send a `research-ask' question at once when it is estimated at most this (US$).
Above it, or when nil, `yes-or-no-p' shows the estimate first.  The
options of the `research-ask' menu are remembered from the last question."
  :type '(choice (const :tag "Preguntar siempre" nil) number))

(defvar research-ask-last-choice nil
  "The last configuration of `research-ask': a plist with `:mode' (opinion,
rewrite or edit) and `:continue' (whether it continued the conversation).
Kept between sessions with `savehist-mode'.")
(with-eval-after-load 'savehist
  (defvar savehist-additional-variables)
  (add-to-list 'savehist-additional-variables 'research-ask-last-choice))

(defface research-ask-edit '((t :inherit diff-refine-added))
  "Face of the text Claude changed in your buffer (`research-ask-allow-edits').")

(defcustom research-ask-offer-continue t
  "Whether `research-ask' offers to continue the conversation of `*research-ask*'.
When non-nil and that buffer holds a conversation that is not answering,
`research-ask' asks whether to continue it (c: the new passage and
question go to it, with its history) or to start a new one (n).  Nil:
always a new conversation."
  :type 'boolean)

(defcustom research-ask-goal-review-on-save nil
  "Whether a conversation with a goal reviews your file again when you save it.
When non-nil, a conversation started with a goal (`g' in `research-ask')
asks Claude to review the passage against the goal each time you save its
file (when no answer is running; under `research-ask-auto-send-below' it
goes at once).  `A' in `*research-ask*' turns it on or off for that
conversation."
  :type 'boolean)

(defvar research--ask-goal-history nil "Goals given to `research-ask'.")

(defconst research--ask-goal-question
  "Revisa el pasaje como está ahora contra el objetivo: qué ya lo cumple, qué falta, qué sobra o va en otra sección (dónde y cómo conectarlo) y los errores de redacción."
  "The question of a review against the conversation's goal.")

(defconst research--ask-max-chars 30000
  "The most characters of the passage `research-ask' sends.")

(defconst research--ask-chapter-max-chars 80000
  "The most characters of the chapter `research-ask' sends as background.
A longer file goes as a window of `research--ask-chapter-margin'
characters around the passage.")

(defconst research--ask-chapter-margin 20000
  "Characters of a long chapter sent before and after the passage.")

(defconst research--ask-outline-max-chars 30000
  "The most characters of the thesis outline `research-ask' sends.")

(defconst research--ask-thesis-file "tesis.org"
  "The thesis' main file, whose `#+INCLUDE' lines give the outline.")

(defvar research--ask-history nil "Questions asked with `research-ask'.")

(defconst research--ask-scopes
  '(("region" . "selección") ("file" . "capítulo/archivo") ("paragraph" . "párrafo") ("subtree" . "sección"))
  "What `research-ask' sends, in Spanish.")

(defconst research--ask-modes
  '(("opinion" . "opinión (sin reescribir tu texto)") ("rewrite" . "propuesta de redacción permitida")
    ("edit" . "edición del archivo permitida"))
  "The modes of a question, in Spanish.")

(defconst research--ask-errors
  '(("chat_message_budget" . "se alcanzó el tope por mensaje de chat")
    ("budget_exceeded" . "se alcanzó un tope de gasto de Claude")
    ("interrupted" . "la respuesta se interrumpió (¿se cerró la app?)")
    ("agent_tools_unavailable" . "no se pudieron abrir las herramientas de la biblioteca"))
  "Spanish reasons for the error codes `ask_status' can report.")

(defvar-local research--ask-state nil
  "The conversation of this `*research-ask*' buffer: a plist with `:id',
`:timer', `:failures', its `:goal' (a string, or nil), `:goal-clear' (the
goal was removed: the next question says so) and `:auto' (whether saving
the file reviews it against the goal), where the passage is (`:source'
buffer, `:path', `:scope', `:beg' and `:end' markers, `:pos' and
`:end-pos' numbers), so a follow-up sends its background again, and, for
the question being answered, the markers `:status' and `:answer' (each a
cons of start and end).")

(defvar research-ask-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "f") #'research-ask-follow-up)
    (define-key map (kbd "r") #'research-ask-goal-review)
    (define-key map (kbd "G") #'research-ask-goal-edit)
    (define-key map (kbd "+") #'research-ask-goal-add-context)
    (define-key map (kbd "A") #'research-ask-goal-toggle-auto)
    (define-key map (kbd "RET") #'research-ask-visit-edit)
    (define-key map (kbd "y") #'research-ask-accept-edits)
    (define-key map (kbd "d") #'research-ask-reject-edit)
    (define-key map (kbd "c") #'research-ask-open-citation)
    (define-key map (kbd "a") #'research-ask-open-in-app)
    (define-key map (kbd "s") #'research-ask-stop)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keys of `*research-ask*'.")

(define-derived-mode research-ask-mode org-mode "Research-Ask"
  "Claude's answers about a passage you are writing, read-only.
\\{research-ask-mode-map}"
  (setq buffer-read-only t)
  (add-hook 'kill-buffer-hook #'research--ask-forget nil t))

(defun research--ask-visual-bounds (beg end type)
  "The (BEG . END) of a visual selection of TYPE; whole lines when `line'."
  (let ((from (min beg end)) (to (max beg end)))
    (if (not (eq type 'line))
        (cons from to)
      (save-excursion
        (cons (progn (goto-char from) (line-beginning-position))
              (progn (goto-char to)
                     (if (and (bolp) (> to from)) (point) (min (point-max) (1+ (line-end-position))))))))))

(defun research--ask-selection ()
  "The (BEG . END) of the selection, or nil.
Evil's visual selection (whole lines when it is line-wise), else the
active region.  Read when the command starts: reading the question in the
minibuffer must not lose it."
  (let ((bounds
         (cond ((and (fboundp 'evil-visual-state-p) (evil-visual-state-p)
                     (bound-and-true-p evil-visual-beginning) (bound-and-true-p evil-visual-end))
                (research--ask-visual-bounds evil-visual-beginning evil-visual-end
                                             (bound-and-true-p evil-visual-selection)))
               ((use-region-p) (cons (region-beginning) (region-end))))))
    (and bounds (< (car bounds) (cdr bounds)) bounds)))

(defun research--ask-subtree ()
  "The Org subtree at point as (SCOPE BEG . END): \"file\" outside any heading."
  (let ((bounds (research--section-bounds)))
    (cons (if (and (= (car bounds) (point-min)) (= (cdr bounds) (point-max))
                   (not (save-excursion (goto-char (point-min)) (looking-at-p "\\*+ "))))
              "file" "subtree")
          bounds)))

(defun research--ask-scope (arg &optional selection)
  "What `research-ask' focuses on with prefix ARG: (SCOPE BEG . END).
SELECTION (a cons of bounds) when there is one; else with
\\[universal-argument] \\[universal-argument] the Org subtree at point,
with \\[universal-argument] the paragraph at point, and otherwise the whole
file."
  (cond (selection (cons "region" selection))
        ((equal arg '(16)) (research--ask-subtree))
        (arg (cons "paragraph" (research--paragraph-bounds)))
        (t (cons "file" (cons (point-min) (point-max))))))

(defun research--ask-fit (scope)
  "SCOPE, or the part of the file to ask about when the file is too long.
Returns (SCOPE . NOTICE).  The whole file longer than
`research--ask-max-chars' becomes the Org section at point (else the
paragraph), the file going as background; NOTICE says so.  Any other
scope too long is a `user-error'."
  (let ((size (- (cddr scope) (cadr scope))))
    (cond ((<= size research--ask-max-chars) (cons scope nil))
          ((not (equal (car scope) "file"))
           (user-error "El texto tiene %d caracteres y se envían hasta %d: selecciona una parte más corta"
                       size research--ask-max-chars))
          (t
           (let* ((subtree (research--ask-subtree))
                  (part (if (and (equal (car subtree) "subtree") (<= (- (cddr subtree) (cadr subtree)) research--ask-max-chars))
                            subtree
                          (cons "paragraph" (research--paragraph-bounds)))))
             (when (> (- (cddr part) (cadr part)) research--ask-max-chars)
               (user-error "El archivo tiene %d caracteres y se envían hasta %d: selecciona una parte más corta"
                           size research--ask-max-chars))
             (cons part (format "El archivo tiene %d caracteres (se envían hasta %d): pregunto por %s y el archivo va como contexto."
                                size research--ask-max-chars
                                (if (equal (car part) "subtree") "la sección en el punto" "el párrafo en el punto"))))))))

(defun research--ask-section (pos)
  "The heading path of POS in an Org buffer, as `A › B'; \"\" elsewhere."
  (or (and (derived-mode-p 'org-mode) (fboundp 'org-get-outline-path)
           (save-excursion
             (goto-char pos)
             (when-let* ((path (ignore-errors (org-get-outline-path t t))))
               (mapconcat #'substring-no-properties path " › "))))
      ""))

;;;;; Background: the chapter and the thesis outline

(defun research--ask-chapter (scope beg end)
  "The chapter around the passage BEG..END of SCOPE: (TEXT . CUT), or nil.
Nil when the passage is the whole file.  The whole (widened) buffer, or
when longer than `research--ask-chapter-max-chars' the whole lines
`research--ask-chapter-margin' characters around the passage, CUT t."
  (unless (equal scope "file")
    (save-restriction
      (widen)
      (if (<= (- (point-max) (point-min)) research--ask-chapter-max-chars)
          (cons (buffer-substring-no-properties (point-min) (point-max)) nil)
        (save-excursion
          (let ((from (progn (goto-char (max (point-min) (- beg research--ask-chapter-margin))) (line-beginning-position)))
                (to (progn (goto-char (min (point-max) (+ end research--ask-chapter-margin))) (line-end-position))))
            (cons (buffer-substring-no-properties from to) t)))))))

(defun research--ask-thesis-main (file)
  "The thesis' main file for FILE, or nil.
`research--ask-thesis-file' in a folder above FILE, or in the project's
root (the folder of `.doc-review.json')."
  (when file
    (seq-some (lambda (marker)
                (when-let* ((dir (locate-dominating-file file marker))
                            (main (expand-file-name research--ask-thesis-file dir)))
                  (and (file-readable-p main) main)))
              (list research--ask-thesis-file ".doc-review.json"))))

(defconst research--ask-heading-regexp
  "^\\(?:\\(\\*+\\)[ \t]+\\(.*\\)\\|[ \t]*#\\+[Ii][Nn][Cc][Ll][Uu][Dd][Ee]:[ \t]*\"\\([^\"]+\\)\"\\(.*\\)\\)$"
  "An Org heading (stars, title) or an `#+INCLUDE' line (file, options).")

(defun research--ask-headings (text name current root seen)
  "The headings of the Org TEXT, the files it includes inside ROOT followed.
NAME is TEXT's file; CURRENT is (TRUENAME TEXT HEADING-POS) of the file
being written (its text is the buffer's, maybe unsaved).  SEEN holds the
truenames already read.  Returns a list of (LEVEL TITLE NAME MARK): MARK
is `file' for a heading of the current file, `here' for the heading of
the passage."
  (let ((dir (file-name-directory name)) headings)
    (with-temp-buffer
      (insert text)
      (goto-char (point-min))
      (let ((case-fold-search nil))
        (while (re-search-forward research--ask-heading-regexp nil t)
          (if (match-beginning 1)
              (let ((title (replace-regexp-in-string "[ \t]+:[[:alnum:]_@#%:]+:[ \t]*\\'" "" (match-string-no-properties 2))))
                (push (list (- (match-end 1) (match-beginning 1)) (string-trim title) name
                            (and (equal name (car current))
                                 (if (eql (match-beginning 0) (nth 2 current)) 'here 'file)))
                      headings))
            (let* ((target (replace-regexp-in-string "::.*\\'" "" (match-string-no-properties 3)))
                   (options (match-string-no-properties 4))
                   (path (and dir (not (file-name-absolute-p target)) (string-suffix-p ".org" target)
                              (expand-file-name target dir)))
                   (true (and path (file-readable-p path) (file-truename path))))
              (when (and true (file-in-directory-p true root) (not (member true seen)) (< (length seen) 50))
                (let* ((included (research--ask-headings
                                  (if (equal true (car current))
                                      (nth 1 current)
                                    (with-temp-buffer (insert-file-contents true) (buffer-string)))
                                  true current root (cons true seen)))
                       (minlevel (and (string-match ":minlevel[ \t]+\\([0-9]+\\)" options)
                                      (string-to-number (match-string 1 options))))
                       (shift (if (and minlevel included) (- minlevel (apply #'min (mapcar #'car included))) 0)))
                  (dolist (h included) (push (cons (max 1 (+ (car h) shift)) (cdr h)) headings)))))))))
    (nreverse headings)))

(defun research--ask-outline-text (headings root current)
  "HEADINGS as the `outline' sent to Claude, and how many: (TEXT . COUNT).
Each file's name (relative to ROOT) on its own line before its headings;
CURRENT, the truename of the file being written, marked as such."
  (let ((lines nil) (size 0) (shown 0) (last nil) (total (length headings)))
    (catch 'full
      (dolist (h headings)
        (let* ((file (nth 2 h))
               (head (unless (equal file last)
                       (format "[file: %s%s]" (if root (file-relative-name file root) (file-name-nondirectory file))
                               (if (equal file current) " — current file" ""))))
               (line (concat (make-string (min (car h) 10) ?*) " " (truncate-string-to-width (nth 1 h) 200)
                             (if (eq (nth 3 h) 'here) "  ← the passage is here" "")))
               (more (+ (length line) 1 (if head (1+ (length head)) 0))))
          (when (> (+ size more) (- research--ask-outline-max-chars 100))
            (throw 'full nil))
          (when head (push head lines) (setq last file))
          (push line lines)
          (setq size (+ size more) shown (1+ shown)))))
    (when (< shown total)
      (push (format "… (%d more headings not shown)" (- total shown)) lines))
    (cons (string-join (nreverse lines) "\n") shown)))

(defun research--ask-outline (scope beg file)
  "The thesis outline for the passage at BEG (SCOPE): (TEXT . COUNT).
FILE is the buffer's file (or nil).  The headings of the thesis' main
file and of the files its `#+INCLUDE' lines name (inside its folder),
this buffer's headings from its text; when there is no main file, or it
does not include this one, this buffer's headings too.  Nil without
headings."
  (save-restriction
    (widen)
    (let* ((org (or (derived-mode-p 'org-mode) (and file (string-suffix-p ".org" file))))
           (here (and org (not (equal scope "file"))
                      (save-excursion (goto-char beg) (end-of-line)
                                      (when (re-search-backward "^\\*+[ \t]" nil t) (point)))))
           (name (if file (file-truename file) (buffer-name)))
           (current (list name (if org (buffer-substring-no-properties (point-min) (point-max)) "") here))
           (main (research--ask-thesis-main file))
           (root (and main (file-name-directory (file-truename main))))
           (headings (when main
                       (let ((true (file-truename main)))
                         (research--ask-headings (if (equal true name) (nth 1 current)
                                                   (with-temp-buffer (insert-file-contents true) (buffer-string)))
                                                 true current root (list true))))))
      (unless (seq-some (lambda (h) (nth 3 h)) headings)
        (setq headings (append headings (research--ask-headings (nth 1 current) name current (or root default-directory) (list name)))))
      (when headings
        (research--ask-outline-text headings root name)))))

(defun research--ask-context (scope beg end file)
  "The background of the passage BEG..END (SCOPE) of this buffer, from FILE.
Returns (ARGUMENTS . DESCRIPTION): the `ask' arguments (chapter,
chapter_truncated, outline) and their Spanish description for the
header."
  (let* ((chapter (research--ask-chapter scope beg end))
         (outline (research--ask-outline scope beg file))
         (parts (delq nil
                      (list (and chapter (format "capítulo (%d caracteres%s)" (length (car chapter))
                                                 (if (cdr chapter) ", recortado alrededor del pasaje" "")))
                            (and outline (format "índice de la tesis (%d títulos)" (cdr outline)))))))
    (cons (append (and chapter `((chapter . ,(car chapter))))
                  (and chapter (cdr chapter) '((chapter_truncated . t)))
                  (and outline `((outline . ,(car outline)))))
          (if parts (string-join parts " e ") "ninguno"))))

(defun research--ask-read-question ()
  "Read a question for Claude, with history."
  (let ((question (string-trim (read-string "Pregunta para Claude: " nil 'research--ask-history))))
    (when (string-empty-p question) (user-error "Escribe una pregunta"))
    question))

(defun research--ask-send (arguments &optional notice)
  "Ask the app for the plan of ARGUMENTS and start the answer: its id.
At once when the estimate is at most `research-ask-auto-send-below' (the
echo area says what went), else after `yes-or-no-p' shows it (NOTICE
first).  Nil when declined."
  (let ((plan (research-call "ask" arguments)))
    (when (and (consp plan) (alist-get 'answering plan))
      (user-error "Claude todavía está respondiendo en esta conversación: espera o detén la respuesta con `s'"))
    (unless (and (consp plan) (alist-get 'confirmation_required plan))
      (user-error "La app no dio un costo estimado para esta pregunta"))
    (let ((estimate (or (alist-get 'estimate_usd plan) 0)))
      (if (not (or (and research-ask-auto-send-below (<= estimate research-ask-auto-send-below))
                   (yes-or-no-p (concat (if notice (concat notice " ") "")
                                        (if (alist-get 'input_chars plan)
                                            (format "Se envían %d caracteres (pasaje y contexto). " (alist-get 'input_chars plan))
                                          "")
                                        (research--plan-prompt plan)))))
          (progn (message "Cancelado") nil)
        (condition-case err
            (alist-get 'conversation_id (research-call "ask" (append arguments '((confirmed . t)))))
          (research-error
           (if (equal (nth 1 err) "busy")
               (user-error "Claude todavía está respondiendo en esta conversación: espera o detén la respuesta con `s'")
             (signal (car err) (cdr err)))))))))

;;;; The menus (transient, like magit's)

(defvar research--ask-pending-selection nil
  "The selection read when the `research-ask' menu opened.")

(defun research--ask-menu-mode (args)
  "The mode the menu's ARGS choose."
  (cond ((member "--edit" args) (if research-ask-allow-edits "edit" "opinion"))
        ((member "--rewrite" args) "rewrite")
        (t "opinion")))

(defun research--ask-menu-value (&optional follow-up)
  "The menu's options as last used (`research-ask-last-choice').
FOLLOW-UP: the follow-up menu, without the conversation option."
  (let ((mode (plist-get research-ask-last-choice :mode)))
    (delq nil (list (and (equal mode "rewrite") "--rewrite")
                    (and (equal mode "edit") research-ask-allow-edits "--edit")
                    (and (not follow-up) (eq (plist-get research-ask-last-choice :continue) :new) "--new")))))

(defun research--ask-remember (args &optional follow-up)
  "Keep the menu's ARGS as the last configuration.
FOLLOW-UP: the follow-up menu's, which has no conversation option."
  (setq research-ask-last-choice
        (list :mode (research--ask-menu-mode args)
              :continue (if follow-up
                            (plist-get research-ask-last-choice :continue)
                          (if (member "--new" args) :new t)))))

(defun research--ask-open-conversation ()
  "The id of the conversation of `*research-ask*', when there is one."
  (when-let* ((buffer (get-buffer "*research-ask*")))
    (plist-get (buffer-local-value 'research--ask-state buffer) :id)))

(defun research--ask-menu-header ()
  "The menu's title: what a question goes to."
  (concat (propertize "Preguntar a Claude" 'face 'transient-heading)
          (if (and research-ask-offer-continue (research--ask-open-conversation))
              (propertize "  (hay una conversación en *research-ask*: sin -n, la pregunta sigue en ella)" 'face 'shadow)
            "")))

(defun research--ask-from-menu (arg)
  "Read the question and ask it with the menu's options, about the passage of ARG."
  (let* ((args (transient-args 'research-ask))
         (selection research--ask-pending-selection))
    (research--ask-remember args)
    (setq research--ask-pending-selection nil)
    (research-ask-question (research--ask-read-question) (research--ask-menu-mode args) arg selection
                           (member "--new" args))))

(transient-define-suffix research--ask-menu-ask ()
  "Ask about the selection, else the whole file."
  :key "?" :description "preguntar (selección o archivo)"
  (interactive)
  (research--ask-from-menu nil))

(transient-define-suffix research--ask-menu-paragraph ()
  "Ask about the paragraph at point."
  :key "p" :description "sobre el párrafo"
  (interactive)
  (research--ask-from-menu '(4)))

(transient-define-suffix research--ask-menu-goal ()
  "Start a conversation with a goal about the selection, else the section at point."
  :key "g" :description "con un objetivo (selección o sección)"
  (interactive)
  (let ((args (transient-args 'research-ask))
        (selection research--ask-pending-selection))
    (research--ask-remember args)
    (setq research--ask-pending-selection nil)
    (research-ask-with-goal (research--ask-read-goal) selection (research--ask-menu-mode args))))

(defun research--ask-read-goal ()
  "Read the goal of a new conversation, with history."
  (let ((goal (string-trim (read-string "Objetivo (lo que quieres lograr con este texto): " nil 'research--ask-goal-history))))
    (when (string-empty-p goal) (user-error "Escribe el objetivo"))
    goal))

;;;###autoload
(defun research-ask-with-goal (goal &optional selection mode)
  "Start a conversation with Claude with GOAL: what you want this text to achieve.
About SELECTION (a cons of positions; interactively the active region or
evil's visual selection), else the Org section at point; in MODE (the
last one used when nil).  Every answer reviews the passage against the
goal (what meets it, what is missing, what belongs elsewhere and how to
connect it, writing errors) and ends with a verdict.  In `*research-ask*'
`r' reviews again, `G' changes the goal, `+' adds context to it and `A'
reviews each time you save.  `g' in `research-ask' does the same."
  (interactive (let ((selection (research--ask-selection)))
                 (list (research--ask-read-goal) selection)))
  (let ((buffer (get-buffer "*research-ask*")))
    (when (and buffer (plist-get (buffer-local-value 'research--ask-state buffer) :timer))
      (user-error "Claude todavía está respondiendo en `*research-ask*': espera o detén la respuesta con `s'")))
  (research-ask-question research--ask-goal-question
                         (or mode (research--ask-menu-mode (research--ask-menu-value t)))
                         (unless selection '(16)) selection t goal))

(transient-define-suffix research--ask-menu-section ()
  "Ask about the Org subtree at point (a section)."
  :key "S" :description "sobre la sección"
  (interactive)
  (research--ask-from-menu '(16)))

;;;###autoload (autoload 'research-ask "research" nil t)
(transient-define-prefix research-ask ()
  "Ask Claude, through the app, about what you are writing.
A menu like magit's.  Its options start as you left them last time
\(`research-ask-last-choice', kept between sessions with `savehist-mode'):
-r allows a proposed rewrite, -e (with `research-ask-allow-edits') lets
Claude edit your file, -n starts a new conversation instead of going on
with the one of `*research-ask*'.  `?' asks about the selection (the
active region or evil's visual selection, read when the menu opens), else
the whole file; `p' the paragraph at point; `S' the Org subtree (a
section).  `g' starts a conversation with a goal (what you want this text
to achieve) about the selection, else the section: every answer reviews
the passage against it.  See `research-ask-question'.  `.' resumes an
earlier conversation."
  :init-value (lambda (obj) (oset obj value (research--ask-menu-value)))
  :incompatible '(("--rewrite" "--edit"))
  [:description research--ask-menu-header
   ["Opciones"
    ("-r" "permitir redacción" "--rewrite")
    ("-e" "permitir editar el archivo" "--edit" :if (lambda () research-ask-allow-edits))
    ("-n" "conversación nueva" "--new" :if (lambda () (and research-ask-offer-continue (research--ask-open-conversation))))]
   ["Preguntar"
    (research--ask-menu-ask)
    (research--ask-menu-paragraph)
    (research--ask-menu-section)
    (research--ask-menu-goal)]
   ["Conversaciones"
    ("." "retomar una anterior" research-ask-resume)]]
  (interactive)
  (let ((buffer (get-buffer "*research-ask*")))
    (when (and buffer (plist-get (buffer-local-value 'research--ask-state buffer) :timer))
      (user-error "Claude todavía está respondiendo en `*research-ask*': espera o detén la respuesta con `s'")))
  (setq research--ask-pending-selection (research--ask-selection))
  (transient-setup 'research-ask))

(transient-define-suffix research--ask-follow-up-menu-ask ()
  "Ask the follow-up with the menu's options."
  :key "f" :description "preguntar"
  (interactive)
  (let ((args (transient-args 'research-ask-follow-up)))
    (research--ask-remember args t)
    (research-ask-follow-up-question (research--ask-read-question) (research--ask-menu-mode args))))

(transient-define-prefix research-ask-follow-up ()
  "Ask Claude a follow-up in the conversation of this `*research-ask*' buffer.
A menu like magit's, its options as you left them: -r allows a proposed
rewrite, -e (with `research-ask-allow-edits') lets Claude edit your file.
`f' asks.  See `research-ask-follow-up-question'."
  :init-value (lambda (obj) (oset obj value (research--ask-menu-value t)))
  :incompatible '(("--rewrite" "--edit"))
  [["Opciones"
    ("-r" "permitir redacción" "--rewrite")
    ("-e" "permitir editar el archivo" "--edit" :if (lambda () research-ask-allow-edits))]
   ["Seguimiento"
    (research--ask-follow-up-menu-ask)]]
  (interactive)
  (when (plist-get (research--ask-buffer-state) :timer)
    (user-error "Claude todavía está respondiendo: espera o detén la respuesta con `s'"))
  (transient-setup 'research-ask-follow-up))

(defconst research--ask-keys-line
  "f: otra pregunta · r: revisar contra el objetivo · G: cambiar el objetivo · +: agregarle contexto · A: revisar al guardar · c: abrir la cita · RET: ir al cambio · y: aceptar cambios · d: deshacer el cambio · a: abrir en la app · s: detener · q: cerrar\n"
  "The keys of `*research-ask*', under its header.")

;;;###autoload
(defun research-ask-question (question mode &optional arg selection new goal)
  "Ask Claude, through the app, QUESTION about what you are writing.
The passage is SELECTION (a cons of positions), else the whole file; with
ARG (4) the paragraph at point, (16) the current Org subtree.  A file
longer than the passage limit is asked about by its section at point, the
echo area says so.  With the file's name and the heading path, and as
background (not the focus) the chapter (the whole file, or a window
around the passage when very long) and the thesis outline: the headings
of tesis.org and the files it includes.  MODE is \"opinion\" (Claude
comments, critiques, suggests and asks; it does not rewrite your passage),
\"rewrite\" (Claude may also propose a version, set apart as its own) or
\"edit\" (Claude's exact changes are applied to your buffer, marked; one
`undo' takes them back).  When `*research-ask*' holds a conversation (and
`research-ask-offer-continue' is on) the question goes to it, with its
history, unless NEW: its follow-ups are then about this passage.  Sent at
once when the estimate is at most `research-ask-auto-send-below', else
after confirming it.  The answer streams into `*research-ask*', a
conversation of the app's Chat view: there `f' asks a follow-up, `c' opens
the citation at point in the app, RET goes to a change Claude made, `a'
opens the conversation in the app, `s' stops the answer and `q' closes.
With GOAL (what the author wants the text to achieve) a new conversation
starts with it: every answer reviews the passage against the goal and
ends with a verdict; there `r' reviews again, `G' changes the goal, `+'
adds context to it and `A' reviews on save.  `research-ask' is its menu."
  (research--with-errors
   (let* ((fit (research--ask-fit (research--ask-scope arg selection)))
          (scope (car fit))
          (notice (cdr fit))
          (beg (cadr scope))
          (end (cddr scope))
          (text (buffer-substring-no-properties beg end))
          (file (if buffer-file-name (file-name-nondirectory buffer-file-name) (buffer-name)))
          (section (research--ask-section beg)))
     (when (string-empty-p (string-trim text)) (user-error "No hay texto que enviar aquí"))
     (let* ((buffer (get-buffer "*research-ask*"))
            (state (and buffer (buffer-local-value 'research--ask-state buffer)))
            (current (plist-get state :id))
            (context (research--ask-context (car scope) beg end buffer-file-name))
            (place (research--ask-place scope))
            (mode (or mode "opinion"))
            (continue (and research-ask-offer-continue current (not new) (not goal) t))
            (id (progn
                  (when (plist-get state :timer)
                    (user-error "Claude todavía está respondiendo en `*research-ask*': espera o detén la respuesta con `s'"))
                  (research--ask-send `((question . ,question)
                                        ,@(and continue `((conversation_id . ,current)))
                                        (text . ,text) (file . ,file) (section . ,section) (scope . ,(car scope)) (mode . ,mode)
                                        ,@(and goal `((goal . ,goal)))
                                        ,@(car context))
                                      notice))))
       (when id
         (progn
           (let ((buffer (get-buffer-create "*research-ask*")))
             (with-current-buffer buffer
               (if continue
                   (let ((inhibit-read-only t))
                     (setq research--ask-state (append (list :id id :failures 0
                                                             :goal (plist-get research--ask-state :goal)
                                                             :auto (plist-get research--ask-state :auto))
                                                       place))
                     (goto-char (point-max))
                     (insert "\n" (propertize (format "Nuevo pasaje — %s · alcance: %s (%d caracteres) · contexto: %s\n"
                                                      (string-join (seq-remove #'string-empty-p (list file section)) " › ")
                                                      (research--label (car scope) research--ask-scopes) (length text) (cdr context))
                                              'face 'shadow)))
                 (research--ask-forget)
                 (research-ask-mode)
                 (setq research--ask-state (append (list :id id :failures 0 :goal goal :auto (and goal research-ask-goal-review-on-save))
                                                   place))
                 (let ((inhibit-read-only t))
                   (erase-buffer)
                   (insert (propertize (format "Preguntar a Claude — %s\n" (string-join (seq-remove #'string-empty-p (list file section)) " › "))
                                       'face 'bold)
                           (propertize (format "Alcance: %s (%d caracteres) · contexto: %s\n"
                                               (research--label (car scope) research--ask-scopes) (length text) (cdr context))
                                       'face 'shadow)
                           (if notice (propertize (concat notice "\n") 'face 'warning) "")
                           (research--ask-goal-line goal)
                           (propertize research--ask-keys-line 'face 'shadow)))))
             (research--ask-begin buffer question mode)
             (display-buffer buffer '((display-buffer-in-side-window) (side . right) (window-width . 0.45)))
             (message "%sClaude %s en `*research-ask*' (s lo detiene)" (if notice (concat notice " ") "")
                      (if continue "sigue la conversación" "está respondiendo"))
             id)))))))

(defun research--ask-place (scope)
  "Where SCOPE (a cons of the scope's code and its bounds) of this buffer is,
for `research--ask-state'."
  (let ((beg (cadr scope)) (end (cddr scope)))
    (list :source (current-buffer) :path buffer-file-name :scope (car scope)
          :beg (copy-marker beg) :end (copy-marker end t) :pos beg :end-pos end)))

(defun research--ask-begin (buffer question mode)
  "Add QUESTION (MODE) to BUFFER and follow its answer on a timer."
  (with-current-buffer buffer
    (let ((inhibit-read-only t))
      (goto-char (point-max))
      (insert "\n* " (replace-regexp-in-string "[ \t\n]+" " " question) "\n")
      (insert (format "Modo: %s · " (research--label mode research--ask-modes)))
      (let ((status-beg (point-marker)))
        (insert "respondiendo…\n\n")
        ;; Made after the blank lines, so inserting them did not move it.
        (let ((status-end (copy-marker (- (point) 2) t)))
          (let ((answer-beg (point-marker)))
            (let ((answer-end (copy-marker (point) t)))
              (plist-put research--ask-state :status (cons status-beg status-end))
              (plist-put research--ask-state :answer (cons answer-beg answer-end))
              (plist-put research--ask-state :failures 0)
              (plist-put research--ask-state :timer
                         (run-with-timer research-ask-poll-interval research-ask-poll-interval
                                         (lambda () (research--ask-poll buffer)))))))))))

(defun research--ask-forget ()
  "Stop following this buffer's answer."
  (when-let* ((timer (plist-get research--ask-state :timer))) (cancel-timer timer))
  (when research--ask-state (plist-put research--ask-state :timer nil)))

(defun research--ask-replace (region text)
  "Replace the text of REGION (a cons of markers) with TEXT."
  (let ((inhibit-read-only t))
    (save-excursion
      (delete-region (car region) (cdr region))
      (goto-char (car region))
      (insert text))))

(defun research--ask-poll (buffer)
  "Ask the app how the answer of BUFFER goes, and show it."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (plist-get research--ask-state :timer)
        (let ((id (plist-get research--ask-state :id)))
          (condition-case err
              (let ((status (research-call "ask_status" `((conversation_id . ,id)))))
                (plist-put research--ask-state :failures 0)
                (pcase (alist-get 'status status)
                  ("running"
                   (research--ask-replace (plist-get research--ask-state :answer) (or (alist-get 'text status) "")))
                  ((or "done" "stopped")
                   (research--ask-forget)
                   (research--ask-show status))
                  (_
                   (research--ask-forget)
                   (let* ((code (or (alist-get 'error status) "failed"))
                          (reason (or (cdr (assoc code research--ask-errors))
                                      (cdr (assoc code research--draft-errors))
                                      (cdr (assoc code research--error-messages))
                                      code)))
                     (research--ask-replace (plist-get research--ask-state :status) (format "sin respuesta: %s" reason))
                     (message "Claude no respondió: %s" reason)))))
            (research-error
             (let ((failures (1+ (plist-get research--ask-state :failures))))
               (plist-put research--ask-state :failures failures)
               (when (>= failures 3)
                 (research--ask-forget)
                 (research--ask-replace (plist-get research--ask-state :status) "ya no se sigue aquí: mírala en la app")
                 (message "Dejé de seguir la respuesta: %s.  Mírala en la app (Chat)" (research--error-message err)))))))))))

(defun research--ask-citation-line (c)
  "The line of the citation C in the answer's list."
  (format "- [%s%s] %s: «%s»\n" (alist-get 'key c)
          (if (alist-get 'page c) (format ", p. %s" (alist-get 'page c)) "")
          (if (alist-get 'verified c) "verificada" "sin verificar")
          (alist-get 'quote c)))

(defun research--ask-show (status)
  "Show STATUS, the `ask_status' of a finished answer, in this buffer."
  (let* ((answer (plist-get research--ask-state :answer))
         (beg (marker-position (car answer)))
         (citations (alist-get 'citations status))
         (text (string-trim-right (or (alist-get 'text status) "")))
         (inhibit-read-only t))
    (research--ask-replace answer text)
    (dolist (c citations)
      (let ((from (+ beg (alist-get 'start c))) (to (+ beg (alist-get 'end c))))
        (add-text-properties from to `(research-ask-citation ,c help-echo ,(alist-get 'quote c)
                                       face ,(if (alist-get 'verified c) 'link 'warning)))))
    (save-excursion
      (goto-char (cdr answer))
      (when-let* ((edits (alist-get 'edits status)))
        (research--ask-insert-edits (research--ask-apply-edits edits (equal (alist-get 'mode status) "edit"))))
      (when-let* ((verdict (alist-get 'goal_verdict status)))
        (research--ask-insert-verdict verdict))
      (when citations
        (insert "\n\nCitas:\n")
        (dolist (c citations)
          (let ((start (point)))
            (insert (research--ask-citation-line c))
            (add-text-properties start (1- (point)) `(research-ask-citation ,c face ,(if (alist-get 'verified c) 'default 'warning)))))))
    (research--ask-replace (plist-get research--ask-state :status)
                           (format "%sUS$%.2f (conversación US$%.2f)"
                                   (if (equal (alist-get 'status status) "stopped") "detenida · " "")
                                   (or (alist-get 'costUsd status) 0) (or (alist-get 'conversation_cost_usd status) 0)))
    (message "Claude respondió%s%s: %d citas, %d sin verificar (US$%.2f)"
             (if (equal (alist-get 'status status) "stopped") " (detenida)" "")
             (let ((verdict (alist-get 'goal_verdict status)))
               (cond ((not verdict) "")
                     ((eq (alist-get 'met verdict) t) " · objetivo cumplido")
                     (t (format " · objetivo: faltan %d" (length (alist-get 'pending verdict))))))
             (length citations) (or (alist-get 'unverified status) 0) (or (alist-get 'costUsd status) 0))))

(defconst research--ask-edit-reasons
  '(("not_found" . "ese texto no está en el pasaje") ("ambiguous" . "aparece más de una vez")
    ("invalid" . "cambio inválido") ("changed" . "cambiaste ese texto mientras respondía")
    ("no_source" . "el archivo no está abierto") ("read_only" . "el búfer es de solo lectura")
    ("not_allowed" . "esta pregunta no permitía editar"))
  "Why a change of Claude was not applied, in Spanish.")

(defun research--ask-apply-edits (edits allowed)
  "Apply Claude's EDITS (from `ask_status') to the passage, when ALLOWED.
Each change whose `find' is, exactly once, inside the passage of this
conversation's source buffer is replaced there and marked with the face
`research-ask-edit'; all of them are one undo step, so one `undo' takes
them back.  Returns the edits, each with `applied' (a marker at the change)
or `reason'."
  (let* ((source (plist-get research--ask-state :source))
         (scope (plist-get research--ask-state :scope))
         (beg (plist-get research--ask-state :beg))
         (end (plist-get research--ask-state :end))
         (out nil))
    (cond
     ((not (and allowed (buffer-live-p source)))
      (dolist (e edits) (push (cons (cons 'reason (if allowed "no_source" "not_allowed")) e) out)))
     ((buffer-local-value 'buffer-read-only source)
      (dolist (e edits) (push (cons '(reason . "read_only") e) out)))
     (t
      (with-current-buffer source
        ;; One undo step of their own: boundaries before and after, none between them.
        (undo-boundary)
        (save-excursion
          (save-restriction
            (widen)
            (dolist (e edits)
              (let ((find (alist-get 'find e))
                    (from (if (equal scope "file") (point-min) (marker-position beg)))
                    (to (if (equal scope "file") (point-max) (marker-position end))))
                (if (not (equal (alist-get 'state e) "ok"))
                    (push (cons (cons 'reason (alist-get 'state e)) e) out)
                  (goto-char from)
                  (let ((at (and (search-forward find to t) (match-beginning 0))))
                    (if (or (not at) (search-forward find to t))
                        (push (cons '(reason . "changed") e) out)
                      (goto-char at)
                      (delete-region at (+ at (length find)))
                      (insert (alist-get 'replace e))
                      (let ((ov (make-overlay at (point))))
                        (overlay-put ov 'face 'research-ask-edit)
                        (overlay-put ov 'research-ask-original find)
                        (overlay-put ov 'evaporate t)
                        (overlay-put ov 'help-echo (alist-get 'why e))
                        (overlay-put ov 'modification-hooks (list (lambda (o after &rest _) (when after (delete-overlay o)))))
                        (push (append (list (cons 'applied (copy-marker at)) (cons 'overlay ov)) e) out)))))))))
        (undo-boundary))))
    (nreverse out)))

(defun research--ask-insert-edits (edits)
  "Insert the list of Claude's EDITS (from `research--ask-apply-edits') here."
  (let ((applied (seq-count (lambda (e) (alist-get 'applied e)) edits))
        (oneline (lambda (s) (truncate-string-to-width (replace-regexp-in-string "[ \t\n]+" " " s) 70 nil nil "…"))))
    (insert (format "\n\nCambios (%d de %d aplicados%s):\n" applied (length edits)
                    (if (> applied 0) "; y: aceptarlos (quita la marca) · d: deshacer el de la línea · un `undo' en tu búfer los deshace todos" "")))
    (dolist (e edits)
      (let ((start (point)))
        (insert (format "- %s «%s» → «%s»%s%s\n"
                        (if (alist-get 'applied e) "✓" "✗")
                        (funcall oneline (alist-get 'find e)) (funcall oneline (alist-get 'replace e))
                        (if (string-empty-p (or (alist-get 'why e) "")) "" (concat ": " (alist-get 'why e)))
                        (if (alist-get 'applied e) ""
                          (format " (no se aplicó: %s)" (research--label (alist-get 'reason e) research--ask-edit-reasons)))))
        (when (alist-get 'applied e)
          (add-text-properties start (1- (point)) `(research-ask-edit ,(alist-get 'applied e)
                                                   research-ask-edit-overlay ,(alist-get 'overlay e))))))
    (when (> applied 0)
      (let ((source (plist-get research--ask-state :source)))
        (message "Claude cambió %d %s en %s (un `undo' allí los deshace)" applied
                 (if (= applied 1) "texto" "textos") (buffer-name source))))))

(defun research-ask-visit-edit ()
  "Go to the change of Claude at point in your buffer."
  (interactive)
  (let ((at (let ((ov (get-text-property (point) 'research-ask-edit-overlay)))
              (if (and (overlayp ov) (overlay-buffer ov))
                  (set-marker (make-marker) (overlay-start ov) (overlay-buffer ov))
                (get-text-property (point) 'research-ask-edit)))))
    (unless (and (markerp at) (buffer-live-p (marker-buffer at)))
      (user-error "No hay un cambio aplicado en esta línea"))
    (pop-to-buffer (marker-buffer at))
    (goto-char at)))

(defun research--ask-edit-overlays (buffer)
  "The marks of Claude's changes in BUFFER."
  (with-current-buffer buffer
    (save-restriction
      (widen)
      (seq-filter (lambda (o) (overlay-get o 'research-ask-original))
                  (overlays-in (point-min) (point-max))))))

;;;###autoload
(defun research-ask-accept-edits ()
  "Accept Claude's changes: they stay as they are and lose their mark.
From `*research-ask*', those in the buffer of its conversation; from any
other buffer, those in it."
  (interactive)
  (let* ((buffer (if (derived-mode-p 'research-ask-mode)
                     (plist-get research--ask-state :source)
                   (current-buffer)))
         (marks (and (buffer-live-p buffer) (research--ask-edit-overlays buffer))))
    (unless marks (user-error "No hay cambios de Claude marcados aquí"))
    (mapc #'delete-overlay marks)
    (message "Aceptados %d %s de Claude" (length marks) (if (= 1 (length marks)) "cambio" "cambios"))))

;;;###autoload
(defun research-ask-reject-edit ()
  "Put back your text in place of the change of Claude here.
In `*research-ask*', the change of the «Cambios:» line at point; in your
buffer, the marked change at point.  Only while you have not edited it."
  (interactive)
  (let ((ov (if (derived-mode-p 'research-ask-mode)
                (get-text-property (point) 'research-ask-edit-overlay)
              (seq-find (lambda (o) (overlay-get o 'research-ask-original))
                        (overlays-at (point) t)))))
    (unless (and (overlayp ov) (overlay-buffer ov))
      (user-error "Aquí no hay un cambio de Claude marcado (¿ya lo aceptaste o lo editaste?)"))
    (let ((original (overlay-get ov 'research-ask-original))
          (beg (overlay-start ov))
          (end (overlay-end ov)))
      (with-current-buffer (overlay-buffer ov)
        (delete-overlay ov)
        (save-excursion
          (goto-char beg)
          (delete-region beg end)
          (insert original)))
      (message "Volví a tu texto: «%s»" (truncate-string-to-width original 60 nil nil "…")))))

(defun research--ask-buffer-state ()
  "This `*research-ask*' buffer's conversation, or a `user-error'."
  (unless (and (derived-mode-p 'research-ask-mode) (plist-get research--ask-state :id))
    (user-error "Esto no es una respuesta de `research-ask'"))
  research--ask-state)

(defun research--ask-fresh-context (state)
  "The `ask' arguments of STATE's passage and its background, as they are now.
The passage (`text') and the chapter and outline, from its buffer when
still open, else from its file; nil when neither.  A passage that was the
whole file is the whole file again (what you added before or after it
too); otherwise the text between its markers, which follow your edits."
  (let ((buffer (plist-get state :source))
        (path (plist-get state :path))
        (scope (plist-get state :scope)))
    (cl-flet ((fresh (beg end file)
                (let ((text (buffer-substring-no-properties beg end)))
                  (append (unless (string-empty-p (string-trim text)) `((text . ,text)))
                          (car (research--ask-context scope beg end file))))))
      (cond ((buffer-live-p buffer)
             (with-current-buffer buffer
               (save-restriction
                 (widen)
                 (if (equal scope "file")
                     (fresh (point-min) (point-max) buffer-file-name)
                   (let ((beg (marker-position (plist-get state :beg)))
                         (end (marker-position (plist-get state :end))))
                     (fresh (min beg end) (max beg end) buffer-file-name))))))
            ((and path (file-readable-p path))
             (with-temp-buffer
               (insert-file-contents path)
               (if (equal scope "file")
                   (fresh (point-min) (point-max) path)
                 (let ((beg (min (plist-get state :pos) (point-max)))
                       (end (min (plist-get state :end-pos) (point-max))))
                   (fresh (min beg end) (max beg end) path)))))))))

(defun research-ask-follow-up-question (question mode)
  "Ask Claude a follow-up QUESTION (MODE, as in `research-ask-question') here.
In this buffer's conversation, with its history.  The passage is the one
the conversation has, sent again as it is now (with your edits; the whole
file when it was the whole file), with the chapter and the thesis outline
as they are now too.  `research-ask-follow-up' is its menu."
  (research--with-errors
    (let ((state (research--ask-buffer-state))
          (mode (or mode "opinion")))
      (when (plist-get state :timer)
        (user-error "Claude todavía está respondiendo: espera o detén la respuesta con `s'"))
      (when (research--ask-send `((question . ,question) (conversation_id . ,(plist-get state :id)) (mode . ,mode)
                                  ,@(and (plist-get state :goal-clear) '((goal . "")))
                                  ,@(research--ask-fresh-context state)))
        (plist-put research--ask-state :goal-clear nil)
        (research--ask-begin (current-buffer) question mode)
        (goto-char (point-max))
        (message "Claude está respondiendo (s lo detiene)")))))

(defun research--ask-conversation-label (c)
  "The line of the conversation C (from `ask_list') in the list to resume."
  (format "%s · %s — %s (%d %s)"
          (replace-regexp-in-string "T" " " (substring (or (alist-get 'updated_at c) "") 0 (min 16 (length (or (alist-get 'updated_at c) "")))))
          (string-join (seq-remove #'string-empty-p (list (or (alist-get 'file c) "") (or (alist-get 'section c) ""))) " › ")
          (alist-get 'title c)
          (/ (1+ (or (alist-get 'messages c) 0)) 2)
          (if (= 1 (/ (1+ (or (alist-get 'messages c) 0)) 2)) "pregunta" "preguntas")))

(defun research--ask-read-conversation (&optional archived)
  "Choose a conversation started with `research-ask' (ARCHIVED ones too): its id."
  (let* ((list (append (alist-get 'conversations (research-call "ask_list" (and archived '((archived . t)))))
                       nil))
         (labels (mapcar (lambda (c) (cons (research--ask-conversation-label c) (alist-get 'conversation_id c))) list)))
    (unless labels (user-error "No hay conversaciones de `research-ask' que retomar"))
    (let ((choice (completing-read "Retomar conversación: "
                                   (lambda (string pred action)
                                     (if (eq action 'metadata)
                                         '(metadata (display-sort-function . identity) (cycle-sort-function . identity))
                                       (complete-with-action action labels string pred)))
                                   nil t)))
      (or (cdr (assoc choice labels)) (user-error "Elige una conversación de la lista")))))

(defun research--ask-find-source (file scope passage)
  "Where the PASSAGE (SCOPE) of FILE is now, for `research--ask-state', or nil.
FILE is a file name without folder: the current buffer when it visits it,
else a buffer visiting it, else that file in the current buffer's folder
or the thesis folder (opened).  A whole-file SCOPE is the whole buffer;
otherwise PASSAGE is looked up as it is (nil when you changed it since)."
  (let* ((visiting (lambda (b) (and (buffer-file-name b) (equal (file-name-nondirectory (buffer-file-name b)) file))))
         (buffer (or (and (funcall visiting (current-buffer)) (current-buffer))
                     (seq-find visiting (buffer-list))
                     (let* ((here (and buffer-file-name (file-name-directory buffer-file-name)))
                            (main (and buffer-file-name (research--ask-thesis-main buffer-file-name)))
                            (dirs (delq nil (list here (and main (file-name-directory main)))))
                            (found (seq-some (lambda (d)
                                               (let ((f (expand-file-name file d)))
                                                 (if (file-readable-p f) f
                                                   (car (ignore-errors
                                                          (directory-files-recursively d (concat "\\`" (regexp-quote file) "\\'")))))))
                                             dirs)))
                       (and found (find-file-noselect found))))))
    (when (and buffer (not (string-empty-p (or file ""))))
      (with-current-buffer buffer
        (save-restriction
          (widen)
          (if (equal scope "file")
              (research--ask-place (cons scope (cons (point-min) (point-max))))
            (save-excursion
              (goto-char (point-min))
              (when (and passage (search-forward passage nil t))
                (research--ask-place (cons scope (cons (match-beginning 0) (match-end 0))))))))))))

(defun research--ask-insert-turns (turns)
  "Insert the questions and answers TURNS (from `ask_history') at the end."
  (let ((inhibit-read-only t)
        (inhibit-message t)
        (message-log-max nil))
    (while turns
      (let ((turn (pop turns)))
        (when (equal (alist-get 'role turn) "question")
          (goto-char (point-max))
          (insert "\n* " (replace-regexp-in-string "[ \t\n]+" " " (alist-get 'text turn)) "\n")
          (let ((answer (and turns (equal (alist-get 'role (car turns)) "answer") (pop turns))))
            (if (not answer)
                (insert (propertize "sin respuesta (pregúntala de nuevo con f)\n" 'face 'shadow))
              (insert "Respuesta · ")
              (let ((status-beg (point-marker)))
                (insert "…\n\n")
                (let ((status-end (copy-marker (- (point) 2) t))
                      (answer-beg (point-marker)))
                  (plist-put research--ask-state :status (cons status-beg status-end))
                  (plist-put research--ask-state :answer (cons answer-beg (copy-marker (point) t)))
                  (research--ask-show `((status . ,(if (alist-get 'stopped answer) "stopped" "done"))
                                        (text . ,(alist-get 'text answer))
                                        (citations . ,(alist-get 'citations answer))
                                        (unverified . ,(alist-get 'unverified answer))
                                        (goal_verdict . ,(alist-get 'goal_verdict answer))
                                        (costUsd . ,(alist-get 'costUsd answer))
                                        (conversation_cost_usd . ,(plist-get research--ask-state :cost)))))))))))))

;;;###autoload
(defun research-ask-resume (id &optional archived)
  "Reopen in `*research-ask*' the conversation ID started with `research-ask'.
Interactively, choose it from the newest (with \\[universal-argument],
ARCHIVED ones too), each with its date, file › section, first question and
how many questions.  Its questions and answers are shown, and `f' goes on
with it, with its history.  The passage is found in its file (a buffer
visiting it, else the file in this folder or the thesis folder): the
whole file, or the passage's text when you have not changed it; then each
follow-up sends it as it is then.  When not found, the follow-ups go with
the last passage the conversation got (and `\\[research-ask]' with c
continues it with a new passage)."
  (interactive (list (research--ask-read-conversation current-prefix-arg) current-prefix-arg))
  (ignore archived)
  (research--with-errors
   (let ((buffer (get-buffer "*research-ask*")))
     (when (and buffer (plist-get (buffer-local-value 'research--ask-state buffer) :timer))
       (user-error "Claude todavía está respondiendo en `*research-ask*': espera o detén la respuesta con `s'")))
   (let* ((history (research-call "ask_history" `((conversation_id . ,id))))
          (file (or (alist-get 'file history) ""))
          (section (or (alist-get 'section history) ""))
          (scope (or (alist-get 'scope history) "region"))
          (place (research--ask-find-source file scope (alist-get 'passage history)))
          (turns (append (alist-get 'turns history) nil))
          (answering (alist-get 'answering history))
          (last-question (and answering (equal (alist-get 'role (car (last turns))) "question") (car (last turns))))
          (buffer (get-buffer-create "*research-ask*")))
     (with-current-buffer buffer
       (research--ask-forget)
       (research-ask-mode)
       (setq research--ask-state (append (list :id id :failures 0 :cost (alist-get 'conversation_cost_usd history)
                                               :goal (alist-get 'goal history)
                                               :auto (and (alist-get 'goal history) research-ask-goal-review-on-save))
                                         place))
       (let ((inhibit-read-only t))
         (erase-buffer)
         (insert (propertize (format "Preguntar a Claude — %s\n" (string-join (seq-remove #'string-empty-p (list file section)) " › "))
                             'face 'bold)
                 (propertize (format "Conversación retomada · alcance: %s · pasaje: %s\n"
                                     (research--label scope research--ask-scopes)
                                     (if place "tu archivo como está ahora" "el último que se envió (no lo encontré en tu archivo)"))
                             'face 'shadow)
                 (research--ask-goal-line (alist-get 'goal history))
                 (propertize research--ask-keys-line 'face 'shadow))
         (research--ask-insert-turns (if last-question (butlast turns) turns)))
       (when last-question
         (research--ask-begin buffer (alist-get 'text last-question) (or (alist-get 'mode history) "opinion")))
       (goto-char (point-max)))
     (display-buffer buffer '((display-buffer-in-side-window) (side . right) (window-width . 0.45)))
     (message "Conversación retomada en `*research-ask*': f sigue con ella")
     id)))

;;;;; A goal: what the conversation works toward

(defun research--ask-goal-line (goal)
  "The header line of GOAL (nil: none)."
  (if (not goal) ""
    (propertize (format "Objetivo: %s\n" (replace-regexp-in-string "\n" " · " goal)) 'face 'bold)))

(defun research--ask-insert-verdict (verdict)
  "Insert Claude's VERDICT on the goal (from `ask_status') here."
  (if (eq (alist-get 'met verdict) t)
      (insert "\n\n" (propertize "Objetivo: ✓ cumplido" 'face 'success))
    (let ((pending (append (alist-get 'pending verdict) nil)))
      (insert "\n\n" (propertize (format "Objetivo: faltan %d %s" (length pending) (if (= 1 (length pending)) "punto" "puntos"))
                                   'face 'warning)
              (if pending ":\n" "")
              (mapconcat (lambda (p) (concat "- " p)) pending "\n")))))

(defun research--ask-goal-state ()
  "This conversation's state, when it has a goal; else a `user-error'."
  (let ((state (research--ask-buffer-state)))
    (unless (plist-get state :goal)
      (user-error "Esta conversación no tiene objetivo: ponle uno con G, o empieza una con g en `research-ask'"))
    state))

(defun research--ask-goal-send (state &optional goal)
  "Ask for a review against the goal in this buffer's conversation (STATE).
With GOAL, it first becomes the conversation's goal.  The passage, chapter
and outline go as they are now; the mode is the last one used."
  (when (plist-get state :timer)
    (user-error "Claude todavía está respondiendo: espera o detén la respuesta con `s'"))
  (let ((mode (let ((m (plist-get research-ask-last-choice :mode))) (if (and (equal m "edit") (not research-ask-allow-edits)) "opinion" (or m "opinion")))))
    (when (research--ask-send `((question . ,research--ask-goal-question) (conversation_id . ,(plist-get state :id)) (mode . ,mode)
                                ,@(and goal `((goal . ,goal)))
                                ,@(research--ask-fresh-context state)))
      (when goal
        (plist-put research--ask-state :goal goal)
        (plist-put research--ask-state :goal-clear nil)
        (let ((inhibit-read-only t))
          (goto-char (point-max))
          (insert "\n" (propertize (format "Objetivo nuevo: %s\n" (replace-regexp-in-string "\n" " · " goal)) 'face 'bold))))
      (research--ask-begin (current-buffer) research--ask-goal-question mode)
      (goto-char (point-max))
      (message "Claude revisa el texto contra el objetivo (s lo detiene)")
      t)))

(defun research-ask-goal-review ()
  "Ask Claude to review the passage, as it is now, against the conversation's goal.
What already meets it, what is missing, what belongs in another section
(where, and how to connect it) and the writing errors; the answer ends
with the verdict: met, or what is still missing."
  (interactive)
  (research--with-errors
    (research--ask-goal-send (research--ask-goal-state))))

(defvar research--ask-goal-edit-conversation nil
  "The `*research-ask*' buffer whose goal the `*research-ask-goal*' buffer edits.")

(defvar research-ask-goal-edit-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-c") #'research-ask-goal-edit-finish)
    (define-key map (kbd "C-c C-k") #'research-ask-goal-edit-cancel)
    map)
  "Keys of `*research-ask-goal*'.")

(define-derived-mode research-ask-goal-edit-mode text-mode "Research-Goal"
  "Edit the goal of a `research-ask' conversation.
\\[research-ask-goal-edit-finish] saves it and asks for a review against it;
\\[research-ask-goal-edit-cancel] leaves it as it was.
\\{research-ask-goal-edit-mode-map}"
  (setq-local header-line-format
              (substitute-command-keys
               "Objetivo de la conversación · \\[research-ask-goal-edit-finish]: guardar y revisar · \\[research-ask-goal-edit-cancel]: cancelar · vacío: quitarlo")))

(defun research-ask-goal-edit ()
  "Change the conversation's goal (or give it one) in a buffer of its own.
There \\<research-ask-goal-edit-mode-map>\\[research-ask-goal-edit-finish] saves it and asks for a review against it; an empty
goal removes it."
  (interactive)
  (let* ((state (research--ask-buffer-state))
         (conversation (current-buffer))
         (buffer (get-buffer-create "*research-ask-goal*")))
    (when (plist-get state :timer)
      (user-error "Claude todavía está respondiendo: espera o detén la respuesta con `s'"))
    (with-current-buffer buffer
      (research-ask-goal-edit-mode)
      (setq-local research--ask-goal-edit-conversation conversation)
      (erase-buffer)
      (insert (or (plist-get state :goal) "")))
    (pop-to-buffer buffer '((display-buffer-below-selected) (window-height . 8)))
    (goto-char (point-max))))

(defun research--ask-goal-edit-close ()
  "Close this `*research-ask-goal*' buffer and its window."
  (let ((buffer (current-buffer)))
    (when-let* ((window (get-buffer-window buffer)))
      (quit-window nil window))
    (kill-buffer buffer)))

(defun research-ask-goal-edit-finish ()
  "Save the goal of `*research-ask-goal*' and ask for a review against it.
An empty goal removes it (no review)."
  (interactive)
  (let ((goal (string-trim (buffer-string)))
        (conversation research--ask-goal-edit-conversation))
    (unless (buffer-live-p conversation) (user-error "La conversación ya no está abierta"))
    (when (> (length goal) 4000) (user-error "El objetivo tiene %d caracteres y caben 4000" (length goal)))
    (research--ask-goal-edit-close)
    (with-current-buffer conversation
      (research--with-errors
        (if (not (string-empty-p goal))
            (research--ask-goal-send (research--ask-buffer-state) goal)
          ;; Removed with the next question (`f'): removing it costs no answer.
          (when (plist-get (research--ask-buffer-state) :goal)
            (plist-put research--ask-state :goal nil)
            (plist-put research--ask-state :auto nil)
            (plist-put research--ask-state :goal-clear t)
            (let ((inhibit-read-only t))
              (goto-char (point-max))
              (insert "\n" (propertize "Objetivo quitado (desde la próxima pregunta)\n" 'face 'shadow)))
            (message "Quité el objetivo: las próximas preguntas (f) van sin él")))))))

(defun research-ask-goal-edit-cancel ()
  "Leave the goal as it was."
  (interactive)
  (research--ask-goal-edit-close)
  (message "El objetivo quedó como estaba"))

(defun research-ask-goal-add-context (context)
  "Add CONTEXT to the conversation's goal and ask for a review against it.
For instance «puedo regresar los párrafos a la introducción: dime dónde y
cómo conectarlos»: it goes on a line of its own after the goal."
  (interactive (progn (research--ask-goal-state)
                      (list (string-trim (read-string "Contexto para el objetivo: ")))))
  (when (string-empty-p context) (user-error "Escribe el contexto"))
  (research--with-errors
    (let* ((state (research--ask-goal-state))
           (goal (concat (plist-get state :goal) "\n- " context)))
      (when (> (length goal) 4000)
        (user-error "El objetivo con su contexto pasaría de 4000 caracteres: resúmelo con G"))
      (research--ask-goal-send state goal))))

(defun research-ask-goal-toggle-auto ()
  "Turn on or off the review against the goal each time you save the file."
  (interactive)
  (let ((state (research--ask-goal-state)))
    (plist-put research--ask-state :auto (not (plist-get state :auto)))
    (message (if (plist-get research--ask-state :auto)
                 "Al guardar %s, Claude lo revisará contra el objetivo (A lo apaga)"
               "Ya no se revisa al guardar %s")
             (let ((source (plist-get state :source))) (if (buffer-live-p source) (buffer-name source) "el archivo")))))

(defun research--ask-goal-after-save ()
  "Review the saved buffer against the goal of `*research-ask*', if it asks."
  (when-let* ((conversation (get-buffer "*research-ask*"))
              (state (buffer-local-value 'research--ask-state conversation)))
    (when (and (plist-get state :goal) (plist-get state :auto) (eq (plist-get state :source) (current-buffer)))
      (if (plist-get state :timer)
          (message "Claude todavía responde: revisa de nuevo con r cuando termine")
        (with-current-buffer conversation
          (research--with-errors (research--ask-goal-send state)))))))

(add-hook 'after-save-hook #'research--ask-goal-after-save)

(defun research-ask-open-citation ()
  "Show the paper of the citation at point in the app, the quote highlighted."
  (interactive)
  (let ((c (or (get-text-property (point) 'research-ask-citation)
               (and (> (point) (point-min)) (get-text-property (1- (point)) 'research-ask-citation))
               (user-error "No hay una cita aquí"))))
    (research--with-errors
      (research--open-in-app (alist-get 'key c) (alist-get 'page c) (alist-get 'quote c))
      (message "Abriendo %s en la app%s" (alist-get 'key c)
               (if (alist-get 'page c) (format ", p. %s" (alist-get 'page c)) "")))))

(defun research-ask-open-in-app ()
  "Open this buffer's conversation in the app's Chat view."
  (interactive)
  (let ((id (plist-get (research--ask-buffer-state) :id)))
    (research--with-errors
      (research-call "open_chat_in_app" `((conversation_id . ,id)))
      (message "Abriendo la conversación en la app"))))

(defun research-ask-stop ()
  "Stop the answer being written; what arrived is kept."
  (interactive)
  (let ((id (plist-get (research--ask-buffer-state) :id)))
    (research--with-errors
      (if (alist-get 'stopping (research-call "ask_stop" `((conversation_id . ,id))))
          (message "Deteniendo la respuesta…")
        (message "No hay una respuesta en curso")))))

;;;; Minor mode

(defvar research-command-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "c") #'research-insert-citation)
    (define-key map (kbd "k") #'research-check-citations)
    (define-key map (kbd "b") #'research-bibtex-for-file)
    (define-key map (kbd "o") #'research-insert-outline)
    (define-key map (kbd "f") #'research-find-passage)
    (define-key map (kbd "a") #'research-open-citation-at-point)
    (define-key map (kbd "d") #'research-draft)
    (define-key map (kbd "D") #'research-draft-stop)
    (define-key map (kbd "v") #'research-check-citations-with-claude)
    (define-key map (kbd "p") #'research-propose-outline)
    (define-key map (kbd "s") #'research-style-review)
    (define-key map (kbd "t") #'research-tutor)
    (define-key map (kbd "w") #'research-alternatives)
    (define-key map (kbd "r") #'research-reverse-outline)
    (define-key map (kbd "q") #'research-rq-coverage)
    (define-key map (kbd "l") #'research-prose-check)
    (define-key map (kbd "g") #'research-prose-gls-at-point)
    (define-key map (kbd "G") #'research-prose-gls-fix)
    (define-key map (kbd "A") #'research-prose-add-acronym)
    (define-key map (kbd "T") #'research-prose-auto-gls-mode)
    (define-key map (kbd "?") #'research-ask)
    (define-key map (kbd ".") #'research-ask-resume)
    (define-key map (kbd "O") #'research-ask-with-goal)
    (define-key map (kbd "y") #'research-ask-accept-edits)
    (define-key map (kbd "x") #'research-ask-reject-edit)
    map)
  "The research commands, under `research-keymap-prefix' in `research-mode'.")
(defalias 'research-command-map research-command-map)

(autoload 'research-prose-check "research-prose"
  "Check the prose of the region or the buffer (Spanish academic prose, local)." t)
(autoload 'research-prose-gls-at-point "research-prose"
  "Write the bare acronym at point as \\gls{KEY}." t)
(autoload 'research-prose-gls-fix "research-prose"
  "Write the bare acronyms of the region or buffer as \\gls, asking each time." t)
(autoload 'research-prose-add-acronym "research-prose"
  "Define an acronym in the thesis' acronym file." t)
(autoload 'research-prose-auto-gls-mode "research-prose"
  "Write a defined acronym as \\gls{KEY} as soon as you finish typing it." t)

(defvar research-mode-map
  (let ((map (make-sparse-keymap)))
    (when research-keymap-prefix
      (define-key map (kbd research-keymap-prefix) 'research-command-map))
    map)
  "Keymap of `research-mode'.")

;;;###autoload
(define-minor-mode research-mode
  "Use the Research app's library from Org, LaTeX and Markdown buffers.
\\{research-command-map}"
  :lighter " Research"
  :keymap research-mode-map
  (unless research-mode
    (remove-hook 'flymake-diagnostic-functions #'research-flymake t)
    (remove-hook 'flymake-diagnostic-functions #'research-tutor-flymake t)
    (setq research--diagnostics nil
          research--claude-diagnostics nil
          research--tutor-diagnostics nil)))


;; Evil's normal and motion states bind f, c, a, s, n, p…: in these read-only buffers their own keys win.
(declare-function evil-make-intercept-map "evil-core")
(declare-function evil-get-auxiliary-keymap "evil-core")
(with-eval-after-load 'evil
  (dolist (map (list research-ask-mode-map research-passages-mode-map research-alternatives-mode-map research-outline-mode-map
                    research-cite-check-mode-map))
    (dolist (state '(normal motion))
      ;; The state's auxiliary map holds all of MAP's keys and takes precedence in that state.
      (set-keymap-parent (evil-get-auxiliary-keymap map state t t) map)
      (evil-make-intercept-map map state t))))

(provide 'research)
;;; research.el ends here
