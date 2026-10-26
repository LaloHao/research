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
;; `yes-or-no-p'.  The tutor's never write your text: they point, explain, ask,
;; outline, or offer options of one sentence for you to choose from.
;;
;; `research-prose-check' (research-prose.el, `l' in the command map) checks
;; Spanish academic prose locally, without the app.
;;
;; Pure Emacs Lisp: url.el for HTTP and the native JSON parser.

;;; Code:

(require 'cl-lib)
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

(defun research--papers (&optional refresh)
  "The library papers for completion; asks the app again when REFRESH."
  (when (or refresh (null research--papers))
    (setq research--papers (research-call "list_papers_for_citation")))
  research--papers)

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
when it supports it."
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
        (let ((counts (alist-get 'counts answer)))
          (message "Claude: %d respaldan, %d en parte, %d no respaldan, %d sin pasaje, %d sin verificar%s (US$%.2f)"
                   (or (alist-get 'supports counts) 0) (or (alist-get 'partial counts) 0)
                   (or (alist-get 'does_not_support counts) 0) (or (alist-get 'not_found counts) 0)
                   (or (alist-get 'unverified counts) 0)
                   (cond ((alist-get 'error answer) (format "; se detuvo: %s" (alist-get 'error answer)))
                         ((alist-get 'stopped answer) "; se detuvo")
                         (t ""))
                   (or (alist-get 'costUsd answer) 0)))
        answer))))

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
      (quit-window t)
      (message "Oración reemplazada (deshaz con %s en el búfer)" (substitute-command-keys "\\[undo]")))))

(defun research-alternatives-keep ()
  "Close the alternatives and keep your sentence."
  (interactive)
  (quit-window t)
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
    map)
  "The research commands, under `research-keymap-prefix' in `research-mode'.")
(defalias 'research-command-map research-command-map)

(autoload 'research-prose-check "research-prose"
  "Check the prose of the region or the buffer (Spanish academic prose, local)." t)

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

(provide 'research)
;;; research.el ends here
