;;; research-test.el --- Tests for research.el -*- lexical-binding: t; -*-

;; Run: emacs --batch -L emacs -l emacs/research-test.el -f ert-run-tests-batch-and-exit

;;; Commentary:

;; The HTTP layer is replaced in `research-test--with-app': each test says what
;; each tool answers, and the requests are recorded.  No network, no app.

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'research)
(require 'flymake)

(defvar research-test--requests nil "The requests sent: (URL HEADERS BODY-AS-LISP).")

(defun research-test--result (value &optional error)
  "A JSON-RPC answer whose tool result is VALUE.
VALUE is JSON-encoded unless a string; the result is an error when ERROR."
  (cons 200 (json-serialize
             `((jsonrpc . "2.0") (id . 1)
               (result . ((content . [((type . "text") (text . ,(if (stringp value) value (decode-coding-string (json-serialize value) 'utf-8))))])
                          ,@(and error '((isError . t)))))))))

(defmacro research-test--with-app (handler &rest body)
  "Run BODY with the app answering through HANDLER, called with (TOOL ARGUMENTS).
HANDLER returns (STATUS . BODY); `research-test--result' builds one."
  (declare (indent 1))
  (let ((dir (make-symbol "dir")))
  `(let* ((,dir (make-temp-file "research-test" t))
          (research-api-file (expand-file-name "api.json" ,dir))
          (research--papers nil)
          (research-test--requests nil)
          (research-http-function
           (lambda (url headers body)
             (let* ((json (json-parse-string body :object-type 'alist :array-type 'list))
                    (params (alist-get 'params json)))
               (push (list url headers json) research-test--requests)
               (funcall ,handler (alist-get 'name params) (alist-get 'arguments params))))))
     (with-temp-file research-api-file
       (insert "{\"url\": \"http://127.0.0.1:47823/mcp\", \"token\": \"secret-token\"}"))
     (unwind-protect (progn ,@body)
       (delete-directory ,dir t)))))

(defconst research-test--papers
  '(((key . "he2017drain") (title . "Drain") (authors . "He et al.") (year . 2017) (has_text . t))
    ((key . "zhu2020loghub") (title . "Loghub") (authors . "Zhu et al.") (year . 2020) (has_text . t))))

(defun research-test--papers-handler (tool _args)
  "Answers `list_papers_for_citation' (TOOL) with two papers."
  (should (equal tool "list_papers_for_citation"))
  (research-test--result (vconcat research-test--papers)))

;;;; Transport

(ert-deftest research-test-call-sends-a-tools-call-with-the-token ()
  (research-test--with-app (lambda (_tool _args) (research-test--result '((ok . t))))
    (should (equal (research-call "outline" '((format . "org") (reviewed_only . t))) '((ok . t))))
    (pcase-let ((`(,url ,headers ,json) (car research-test--requests)))
      (should (equal url "http://127.0.0.1:47823/mcp"))
      (should (equal (cdr (assoc "Authorization" headers)) "Bearer secret-token"))
      (should (string-match-p "application/json" (cdr (assoc "Accept" headers))))
      (should (equal (alist-get 'method json) "tools/call"))
      (should (equal (alist-get 'params json)
                     '((name . "outline") (arguments . ((format . "org") (reviewed_only . t)))))))))

(ert-deftest research-test-call-without-arguments-sends-an-empty-object ()
  (research-test--with-app (lambda (_tool args) (should (null args)) (research-test--result "[]"))
    (research-call "list_papers_for_citation")
    (should (string-match-p "\"arguments\":{}" (json-serialize (nth 2 (car research-test--requests)))))))

(ert-deftest research-test-call-turns-errors-into-codes-and-spanish-messages ()
  (research-test--with-app (lambda (_tool _args) (research-test--result "no_project: No project is open in the app." t))
    (let ((err (should-error (research-call "outline") :type 'research-error)))
      (should (equal (nth 1 err) "no_project"))
      (should (string-match-p "No hay un proyecto abierto" (nth 2 err)))))
  (research-test--with-app (lambda (_tool _args) (research-test--result "not_found: No library paper has the key \"x\"." t))
    (let ((err (should-error (research-call "open_in_app" '((key . "x"))) :type 'research-error)))
      (should (equal (nth 1 err) "not_found"))
      (should (string-match-p "No encontrado: No library paper" (nth 2 err)))))
  (research-test--with-app (lambda (_tool _args) (cons 401 ""))
    (should (equal (nth 1 (should-error (research-call "outline") :type 'research-error)) "unauthorized")))
  (research-test--with-app (lambda (_tool _args) (research-test--result "MCP error -32602: Tool draft not found" t))
    (should (equal (nth 1 (should-error (research-call "draft") :type 'research-error)) "unavailable"))))

(ert-deftest research-test-missing-connection-file ()
  (let ((research-api-file "/nonexistent/research/api.json"))
    (should (equal (nth 1 (should-error (research-call "outline") :type 'research-error)) "no_connection"))
    (should-error (with-temp-buffer (research-insert-outline)) :type 'user-error)))

;;;; Citations

(ert-deftest research-test-format-citation ()
  (should (equal (research-format-citation "a2020x" nil 'org) "[cite:@a2020x]"))
  (should (equal (research-format-citation "a2020x" 3 'org) "[cite:@a2020x p. 3]"))
  (should (equal (research-format-citation "a2020x" 3 'markdown) "[@a2020x, p. 3]"))
  (should (equal (research-format-citation "a2020x" nil 'latex) "\\cite{a2020x}"))
  (let ((research-latex-cite-command "parencite"))
    (should (equal (research-format-citation "a2020x" 7 'latex) "\\parencite[p.~7]{a2020x}"))))

(ert-deftest research-test-insert-citation-per-mode ()
  (research-test--with-app #'research-test--papers-handler
    (cl-letf (((symbol-function 'completing-read)
               (lambda (_prompt collection &rest _)
                 (let ((all (all-completions "" collection)))
                   (should (= (length all) 2))
                   (should (string-match-p "Drain (2017)" (car all)))
                   (cadr all)))))
      (with-temp-buffer
        (org-mode)
        (research-insert-citation)
        (should (equal (buffer-string) "[cite:@zhu2020loghub]")))
      (with-temp-buffer
        (latex-mode)
        (research-insert-citation)
        (should (equal (buffer-string) "\\cite{zhu2020loghub}")))
      (with-temp-buffer
        (setq buffer-file-name "/tmp/chapter.md")
        (research-insert-citation)
        (setq buffer-file-name nil)
        (should (equal (buffer-string) "[@zhu2020loghub]"))))
    ;; The papers were asked for once and kept.
    (should (= (length research-test--requests) 1))))

;;;; Checking citations

(ert-deftest research-test-check-citations-makes-diagnostics-at-character-offsets ()
  (let ((text "😀 A [cite:@nobody] and [cite:@gone;@gone]."))
    (research-test--with-app
        (lambda (tool args)
          (should (equal tool "check_citations_local"))
          (should (equal (alist-get 'format args) "org"))
          (should (equal (alist-get 'text args) text))
          (research-test--result
           `((format . "org") (unknown . ["nobody"]) (trashed . ["gone"]) (no_text . []) (duplicates . ["gone"])
             (citations . [((start . 4) (end . 18) (keys . ["nobody"]) (states . ((nobody . "unknown"))) (duplicates . []))
                           ((start . 23) (end . 41) (keys . ["gone" "gone"]) (states . ((gone . "trashed"))) (duplicates . ["gone"]))]))))
      (with-temp-buffer
        (org-mode)
        (insert "Intro.\n" text)
        (research-check-citations (+ (point-min) 7) (point-max))
        (should (equal (mapcar (lambda (d) (list (buffer-substring (nth 0 d) (nth 1 d)) (nth 2 d))) research--diagnostics)
                       '(("[cite:@nobody]" :error) ("[cite:@gone;@gone]" :warning) ("[cite:@gone;@gone]" :warning))))
        (should (memq #'research-flymake flymake-diagnostic-functions))
        ;; The backend reports them where they are now, after an edit before them.
        (goto-char (point-min))
        (insert "New. ")
        (let (reported)
          (research-flymake (lambda (diags) (setq reported diags)))
          (should (= (length reported) 3))
          (should (equal (buffer-substring (flymake-diagnostic-beg (car reported)) (flymake-diagnostic-end (car reported)))
                         "[cite:@nobody]")))))))

;;;; BibTeX

(ert-deftest research-test-bibtex-for-file-writes-the-bib-and-sets-the-bibliography ()
  (let* ((dir (make-temp-file "research-bib" t))
         (file (expand-file-name "thesis.org" dir)))
    (unwind-protect
        (research-test--with-app
            (lambda (tool args)
              (should (equal tool "bibtex_for_file"))
              (should (equal (alist-get 'path args) file))
              (should (equal (alist-get 'order args) "appearance"))
              (research-test--result
               '((bib . "@article{he2017drain,\n  title = {Drain}\n}\n") (citations . 1)
                 (report . ((keys . ["he2017drain" "x"]) (entries . ["he2017drain"])
                            (unknown . [((key . "x") (suggestion . :null))]) (trashed . []))))))
          (with-temp-file file (insert "#+title: Thesis\nText [cite:@he2017drain].\n"))
          (with-current-buffer (find-file-noselect file)
            (unwind-protect
                (cl-letf (((symbol-function 'y-or-n-p) (lambda (&rest _) t)))
                  (research-bibtex-for-file)
                  (should (equal (with-temp-buffer (insert-file-contents (expand-file-name "thesis.bib" dir)) (buffer-string))
                                 "@article{he2017drain,\n  title = {Drain}\n}\n"))
                  (should (equal (buffer-string) "#+title: Thesis\n#+bibliography: thesis.bib\nText [cite:@he2017drain].\n"))
                  ;; Not added twice.
                  (research--set-org-bibliography (expand-file-name "thesis.bib" dir))
                  (should (= 1 (how-many "^#\\+bibliography:" (point-min) (point-max)))))
              (set-buffer-modified-p nil)
              (kill-buffer))))
      (delete-directory dir t))))

;;;; Outline

(ert-deftest research-test-insert-outline-in-the-buffer-format ()
  (research-test--with-app
      (lambda (tool args)
        (should (equal tool "outline"))
        (should (equal (alist-get 'format args) "latex"))
        (should (equal (alist-get 'rq args) "RQ1"))
        (should (equal (alist-get 'reviewed_only args) t))
        (should-not (alist-get 'facet args))
        (research-test--result '((text . "\\section{parsing}\n"))))
    (with-temp-buffer
      (latex-mode)
      (let ((answers '("" "" "rq1")))
        (cl-letf (((symbol-function 'read-string) (lambda (&rest _) (pop answers)))
                  ((symbol-function 'y-or-n-p) (lambda (&rest _) t)))
          (research-insert-outline t)))
      (should (equal (buffer-string) "\\section{parsing}\n")))))

;;;; Passages

(ert-deftest research-test-find-passage-inserts-quote-and-citation-and-opens-in-the-app ()
  (research-test--with-app
      (lambda (tool args)
        (pcase tool
          ("find_passages"
           (should (equal (alist-get 'query args) "datasets"))
           (research-test--result
            '[((key . "zhu2020loghub") (title . "Loghub") (page . 2) (text . "…") (quote . "We evaluate Drain on all sixteen Loghub datasets."))
              ((key . "he2017drain") (title . "Drain") (page . 1) (text . "…") (quote . "Drain reaches the highest accuracy."))]))
          ("open_in_app"
           (should (equal args '((key . "he2017drain") (page . 1) (quote . "Drain reaches the highest accuracy."))))
           (research-test--result '((opened . t))))))
    (let ((origin (generate-new-buffer "chapter.org")))
      (unwind-protect
          (progn
            (with-current-buffer origin
              (org-mode)
              (insert "As shown: ")
              (research-find-passage "datasets"))
            (with-current-buffer "*research passages*"
              (should (get-text-property (point) 'research-passage))
              (research-passages-insert)
              (research-passages-next)
              (should (equal (alist-get 'key (get-text-property (point) 'research-passage)) "he2017drain"))
              (research-passages-open)
              (research-passages-previous)
              (should (equal (alist-get 'key (get-text-property (point) 'research-passage)) "zhu2020loghub")))
            (with-current-buffer origin
              (should (equal (buffer-string)
                             "As shown: \"We evaluate Drain on all sixteen Loghub datasets.\" [cite:@zhu2020loghub p. 2]")))
            (should (equal (mapcar (lambda (r) (alist-get 'name (alist-get 'params (nth 2 r)))) research-test--requests)
                           '("open_in_app" "find_passages"))))
        (kill-buffer origin)
        (when (get-buffer "*research passages*") (kill-buffer "*research passages*"))))))

;;;; Citation at point

(defun research-test--at (mode text marker)
  "The citation at the position of MARKER (removed) in TEXT, in MODE."
  (with-temp-buffer
    (funcall mode)
    (insert text)
    (goto-char (point-min))
    (search-forward marker)
    (delete-char (- (length marker)))
    (research-citation-at-point)))

(ert-deftest research-test-citation-at-point ()
  (should (equal (research-test--at #'org-mode "See [cite:@a2020x p. 4;@b2021|y p. 12] here." "|") '("b2021y" . 12)))
  (should (equal (research-test--at #'org-mode "See [cite/t:|@a2020x p. 4;@b2021y] here." "|") '("a2020x" . 4)))
  (should (equal (research-test--at #'org-mode "No |citation here." "|") nil))
  (should (equal (research-test--at #'latex-mode "As \\parencite[p.~33]{a2020x, b20|21y} said." "|") '("b2021y" . 33)))
  (should (equal (research-test--at #'latex-mode "As \\cite{a20|20x}." "|") '("a2020x")))
  (with-temp-buffer
    (setq buffer-file-name "/tmp/x.md")
    (insert "Per [see @a2020x, pp. 3-4; @b2021y] and @c20|22z.")
    (goto-char (point-min))
    (search-forward "|")
    (delete-char -1)
    (should (equal (research-citation-at-point) '("c2022z")))
    (goto-char (point-min))
    (search-forward "a20")
    (should (equal (research-citation-at-point) '("a2020x" . 3)))
    (setq buffer-file-name nil)))

(ert-deftest research-test-open-citation-at-point-calls-open-in-app ()
  (research-test--with-app
      (lambda (tool args)
        (should (equal tool "open_in_app"))
        (should (equal args '((key . "a2020x") (page . 4))))
        (research-test--result '((opened . t))))
    (with-temp-buffer
      (org-mode)
      (insert "[cite:@a2020x p. 4]")
      (goto-char 5)
      (research-open-citation-at-point)
      (should (= (length research-test--requests) 1)))))

;;;; Operations with cost

(ert-deftest research-test-costly-call-asks-with-the-estimate-then-confirms ()
  (let ((plan '((confirmation_required . t) (operation . "draft") (model . "claude-sonnet-5")
                (estimate_usd . 0.2) (cap_usd . 1) (month_spent_usd . 0.5) (month_cap_usd . :null))))
    (research-test--with-app
        (lambda (tool args)
          (should (equal tool "draft"))
          (if (alist-get 'confirmed args)
              (research-test--result '((costUsd . 0.12) (model . "claude-sonnet-5") (text . "Draft.")))
            (research-test--result plan)))
      (let (asked)
        (cl-letf (((symbol-function 'yes-or-no-p) (lambda (prompt) (setq asked prompt) nil)))
          (should (null (research-call-with-cost "draft" '((title . "Intro")))))
          (should (string-match-p "\\$0.20" asked))
          (should (string-match-p "tope \\$1.00" asked))
          (should (= (length research-test--requests) 1)))
        (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t)))
          (with-temp-buffer
            (org-mode)
            (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "x"))
                      ((symbol-function 'research-read-key) (lambda (&rest _) "")))
              (call-interactively #'research-draft))
            (should (equal (buffer-string) "Draft."))))
        (should (equal (alist-get 'confirmed (alist-get 'arguments (alist-get 'params (nth 2 (car research-test--requests))))) t))))))

(ert-deftest research-test-costly-call-explains-when-disabled ()
  (research-test--with-app (lambda (_tool _args) (research-test--result "costly_disabled: Operations that spend Claude quota are off." t))
    (with-temp-buffer
      (let ((err (should-error (research-style-review) :type 'user-error)))
        (should (string-match-p "Ajustes → Aplicación → API local" (cadr err)))))))

;;;; Minor mode

(ert-deftest research-test-mode-binds-the-commands ()
  (with-temp-buffer
    (org-mode)
    (research-mode 1)
    (should (eq (key-binding (kbd "C-c r c")) #'research-insert-citation))
    (should (eq (key-binding (kbd "C-c r f")) #'research-find-passage))
    (research-mode -1)
    (should-not (eq (key-binding (kbd "C-c r c")) #'research-insert-citation))))

(provide 'research-test)
;;; research-test.el ends here
