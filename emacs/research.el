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
;; `research-style-review') always ask for the API's cost estimate first and run
;; only after `yes-or-no-p'.
;;
;; Pure Emacs Lisp: url.el for HTTP and the native JSON parser.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'url)
(require 'url-http)

(declare-function flymake-make-diagnostic "flymake")
(declare-function flymake-start "flymake")
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
    ("unauthorized" . "La app rechazó el token: revisa el archivo de conexión (¿regeneraste el token?).")
    ("connection" . "No se pudo conectar con la app: ¿está abierta y con la API local activada?")
    ("no_connection" . "No encuentro el archivo de conexión de la app: activa la API local en Ajustes → Aplicación.")
    ("unavailable" . "Esta función todavía no está disponible en la app."))
  "Spanish messages for the API's error codes.")

(defun research--fail (code &optional detail)
  "Signal `research-error' with CODE (a string) and optional DETAIL."
  (let ((base (or (cdr (assoc code research--error-messages)) code)))
    (signal 'research-error
            (list code (if (and detail (not (string-empty-p detail))
                                (not (member code '("no_project" "costly_disabled" "unauthorized" "connection" "no_connection"))))
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
    (cond ((memq status '(401 403)) (research--fail "unauthorized"))
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
  "The last check's diagnostics: (BEG-MARKER END-MARKER TYPE TEXT).")

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
  "Flymake backend: report the last `research-check-citations' to REPORT-FN."
  (funcall report-fn
           (cl-loop for (beg end type text) in research--diagnostics
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
      (setq research--diagnostics
            (mapcar (lambda (d) (list (copy-marker (nth 0 d)) (copy-marker (nth 1 d)) (nth 2 d) (nth 3 d)))
                    diagnostics))
      (when (require 'flymake nil t)
        (add-hook 'flymake-diagnostic-functions #'research-flymake nil t)
        (if flymake-mode (flymake-start) (flymake-mode 1)))
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
    (let* ((source (expand-file-name buffer-file-name))
           (default (concat (file-name-sans-extension source) ".bib"))
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

;;;###autoload
(defun research-insert-outline (&optional ask)
  "Insert the app's state-of-the-art outline in the buffer's format.
Without a prefix argument: the whole library, the form's first facet.
With ASK (a prefix argument), ask for the facets, the research question
and whether to count only reviewed values."
  (interactive "P")
  (research--with-errors
    (let ((args `((format . ,(symbol-name (research--format))))))
      (when ask
        (let ((facet (read-string "Faceta principal (vacío: la primera del formulario): "))
              (secondary (read-string "Faceta secundaria (vacío: ninguna): "))
              (rq (read-string "Pregunta de investigación, p. ej. RQ1 (vacío: ninguna): ")))
          (unless (string-empty-p facet) (push `(facet . ,facet) args))
          (unless (string-empty-p secondary) (push `(secondary . ,secondary) args))
          (unless (string-empty-p rq) (push `(rq . ,(upcase rq)) args))
          (when (y-or-n-p "¿Solo valores revisados?") (push '(reviewed_only . t) args))))
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

;;;###autoload
(defun research-draft (title purpose keys)
  "Ask Claude, through the app, for a draft section TITLE with PURPOSE citing KEYS.
Shows the estimated cost and asks before running."
  (interactive
   (list (read-string "Título de la sección: ")
         (read-string "Propósito o indicaciones: ")
         (let (keys key)
           (while (not (string-empty-p (setq key (research-read-key "Paper (vacío para terminar): "))))
             (push key keys))
           (nreverse keys))))
  (research--with-errors
    (research--show-answer
     (research-call-with-cost "draft" `((title . ,title) (purpose . ,purpose) (keys . ,(vconcat keys))
                                        (format . ,(symbol-name (research--format)))))
     "*research draft*")))

;;;###autoload
(defun research-check-citations-with-claude (&optional beg end)
  "Ask Claude, through the app, whether the cited papers support each sentence.
The region (BEG..END) or the buffer.  Shows the estimated cost and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (research--show-answer
     (research-call-with-cost "cite_check" `((text . ,(buffer-substring-no-properties (or beg (point-min)) (or end (point-max))))
                                             (format . ,(symbol-name (research--format)))))
     "*research cite check*")))

;;;###autoload
(defun research-propose-outline ()
  "Ask Claude, through the app, to propose the outline's wording.
Shows the estimated cost and asks first."
  (interactive)
  (research--with-errors
    (research--show-answer
     (research-call-with-cost "outline_proposal" `((format . ,(symbol-name (research--format)))))
     "*research outline proposal*")))

;;;###autoload
(defun research-style-review (&optional beg end)
  "Ask Claude, through the app, for style suggestions.
On the region (BEG..END) or the buffer.
Shows the estimated cost and asks first."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research--with-errors
    (research--show-answer
     (research-call-with-cost "style" `((text . ,(buffer-substring-no-properties (or beg (point-min)) (or end (point-max))))
                                        (format . ,(symbol-name (research--format)))))
     "*research style*")))

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
    (define-key map (kbd "v") #'research-check-citations-with-claude)
    (define-key map (kbd "p") #'research-propose-outline)
    (define-key map (kbd "s") #'research-style-review)
    map)
  "The research commands, under `research-keymap-prefix' in `research-mode'.")
(defalias 'research-command-map research-command-map)

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
    (setq research--diagnostics nil)))

(provide 'research)
;;; research.el ends here
