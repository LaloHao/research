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
  (research-test--with-app (lambda (_tool _args) (cons 403 ""))
    (let ((err (should-error (research-call "outline") :type 'research-error)))
      (should (equal (nth 1 err) "forbidden"))
      (should (string-match-p "Host u Origin" (nth 2 err)))))
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
              (should (equal (alist-get 'path args) (file-truename file)))
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

(ert-deftest research-test-bibtex-for-file-sends-a-symlinked-chapter-as-its-target ()
  (let* ((dir (make-temp-file "research-bib" t))
         (real (expand-file-name "chapters/one.org" dir))
         (link (expand-file-name "one.org" dir)))
    (unwind-protect
        (research-test--with-app
            (lambda (_tool args)
              (should (equal (alist-get 'path args) (file-truename real)))
              (research-test--result '((bib . "") (citations . 0) (report . ((keys . []) (entries . []) (unknown . []) (trashed . []))))))
          (make-directory (file-name-directory real))
          (with-temp-file real (insert "Text.\n"))
          (make-symbolic-link real link)
          (let ((find-file-visit-truename nil))
            (with-current-buffer (find-file-noselect link)
              (unwind-protect
                  (cl-letf (((symbol-function 'y-or-n-p) (lambda (&rest _) nil)))
                    (research-bibtex-for-file)
                    ;; The .bib goes next to the file as visited.
                    (should (file-exists-p (expand-file-name "one.bib" dir))))
                (kill-buffer)))))
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
          (should (equal (research-call-with-cost "draft" '((title . "Intro")))
                         '((costUsd . 0.12) (model . "claude-sonnet-5") (text . "Draft.")))))
        (should (equal (alist-get 'confirmed (alist-get 'arguments (alist-get 'params (nth 2 (car research-test--requests))))) t))))))

;; The draft's timer is captured: each test runs its polls by hand.
(defmacro research-test--with-draft-timer (poll &rest body)
  "Run BODY with `run-with-timer' storing its function in POLL (a symbol)."
  (declare (indent 1))
  `(let ((research--draft nil))
     (cl-letf (((symbol-function 'run-with-timer) (lambda (_secs _repeat fn &rest _) (setq ,poll fn) 'research-test-timer))
               ((symbol-function 'cancel-timer) #'ignore))
       ,@body)))

(ert-deftest research-test-draft-asks-starts-and-opens-the-text-when-written ()
  (let ((statuses (list '((draft_id . "20261022-120000-a1b2") (status . "running") (chars . 120) (tools . 2))
                        '((draft_id . "20261022-120000-a1b2") (status . "done") (title . "Log parsing") (format . "org")
                          (text . "Online parsers exist [cite:@he2017drain p. 1]. [SIN CITA]")
                          (unverified . 0) (outside . 0) (uncited . 1) (costUsd . 0.12))))
        poll messages)
    (research-test--with-app
        (lambda (tool args)
          (pcase tool
            ("list_papers_for_citation" (research-test--result (vconcat research-test--papers)))
            ("draft"
             (should (equal (alist-get 'keys args) '("he2017drain" "zhu2020loghub")))
             (should (equal (alist-get 'length args) "long"))
             (should (equal (alist-get 'rq args) "RQ1"))
             (if (alist-get 'confirmed args)
                 (research-test--result '((draft_id . "20261022-120000-a1b2") (status . "running") (costUsd . 0) (model . "sonnet")))
               (research-test--result '((confirmation_required . t) (operation . "draft") (model . "sonnet") (estimate_usd . 0.2)
                                        (cap_usd . 1) (month_spent_usd . 0) (month_cap_usd . :null) (papers . 2) (running_draft . :null)))))
            ("draft_status"
             (should (equal args '((draft_id . "20261022-120000-a1b2") (format . "org"))))
             (research-test--result (pop statuses)))))
      (research-test--with-draft-timer poll
        (let ((answers '("Log parsing" "Compare online parsers." "rq1")))
          (cl-letf (((symbol-function 'read-string) (lambda (&rest _) (pop answers)))
                    ((symbol-function 'completing-read-multiple)
                     (lambda (_prompt table &rest _)
                       (should (equal (all-completions "" table) '("he2017drain" "zhu2020loghub")))
                       (should (string-match-p "Drain (2017)" (funcall (alist-get 'annotation-function (cdr (funcall table "" nil 'metadata))) "he2017drain")))
                       '("he2017drain" "zhu2020loghub" "he2017drain")))
                    ((symbol-function 'completing-read) (lambda (&rest _) "long"))
                    ((symbol-function 'yes-or-no-p) (lambda (_) t))
                    ((symbol-function 'message) (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
            ;; It answers at once with the id; the text comes later, on the timer.
            (should (equal (call-interactively #'research-draft) "20261022-120000-a1b2"))
            (should-not (get-buffer "*research-draft*"))
            (should (equal (plist-get research--draft :id) "20261022-120000-a1b2"))
            ;; A second draft while this one runs is refused before asking anything.
            (let ((sent (length research-test--requests)))
              (should-error (research-draft "Other" "" '("he2017drain")) :type 'user-error)
              (should (= (length research-test--requests) sent)))
            (funcall poll)
            (should (string-match-p "120 caracteres, 2 consultas" (car messages)))
            (should-not (get-buffer "*research-draft*"))
            (funcall poll)))
        (should-not research--draft)
        (let ((buffer (get-buffer "*research-draft*")))
          (unwind-protect
              (with-current-buffer buffer
                (should (derived-mode-p 'org-mode))
                (should (equal (buffer-string) "#+title: Log parsing\n\nOnline parsers exist [cite:@he2017drain p. 1]. [SIN CITA]\n")))
            (kill-buffer buffer)))
        (should (string-match-p "1 sin cita" (car messages)))))))

(ert-deftest research-test-draft-refuses-while-the-app-writes-one-started-from-the-api ()
  (research-test--with-app
      (lambda (_tool args)
        (should-not (alist-get 'confirmed args))
        (research-test--result '((confirmation_required . t) (operation . "draft") (model . "sonnet") (estimate_usd . 0.2)
                                 (cap_usd . 1) (month_spent_usd . 0) (month_cap_usd . :null) (running_draft . "20261022-110000-ffff"))))
    (research-test--with-draft-timer _poll
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) (error "Must not ask"))))
        (let ((err (should-error (research-draft "T" "" '("he2017drain")) :type 'user-error)))
          (should (string-match-p "20261022-110000-ffff" (cadr err)))))
      (should (= (length research-test--requests) 1))
      (should-not research--draft))))

(ert-deftest research-test-draft-stop-and-a-failed-draft ()
  (let ((status '((draft_id . "20261022-120000-a1b2") (status . "error") (error . "llm_quota")))
        poll messages)
    (research-test--with-app
        (lambda (tool args)
          (pcase tool
            ("draft_stop"
             (should (equal args '((draft_id . "20261022-120000-a1b2"))))
             (research-test--result '((draft_id . "20261022-120000-a1b2") (stopping . t))))
            ("draft_status" (research-test--result status))))
      (research-test--with-draft-timer poll
        (cl-letf (((symbol-function 'message) (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
          (research--draft-follow "20261022-120000-a1b2" "T")
          (research-draft-stop)
          (should (string-match-p "Deteniendo el borrador 20261022-120000-a1b2" (car messages)))
          (funcall poll)
          (should (string-match-p "no se escribió: se agotó la cuota de Claude" (car messages)))
          (should-not research--draft))))))

(ert-deftest research-test-draft-declined-writes-nothing ()
  (research-test--with-app (research-test--costly "draft" '((text . "never")))
    (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) nil)))
      (research-draft "T" "" '("he2017drain"))
      (should (= (length research-test--requests) 1))
      (should-not (get-buffer "*research-draft*")))))

(ert-deftest research-test-costly-call-explains-when-disabled ()
  (research-test--with-app (lambda (_tool _args) (research-test--result "costly_disabled: Operations that spend Claude quota are off." t))
    (with-temp-buffer
      (let ((err (should-error (research-style-review) :type 'user-error)))
        (should (string-match-p "Ajustes → Aplicación → API local" (cadr err)))))))

;;;; Claude through the app

(defun research-test--costly (tool answer &optional on-run)
  "A handler for costly TOOL: the plan without `confirmed', ANSWER with it.
ON-RUN, when given, runs before answering the confirmed call."
  (lambda (name args)
    (should (equal name tool))
    (if (alist-get 'confirmed args)
        (progn (when on-run (funcall on-run args)) (research-test--result answer))
      (research-test--result '((confirmation_required . t) (operation . "x") (model . "sonnet")
                               (estimate_usd . 0.2) (cap_usd . 1) (month_spent_usd . 0) (month_cap_usd . :null))))))

(ert-deftest research-test-check-with-claude-shows-verdicts-in-flymake ()
  (let* ((text "😀 Fast [cite:@a2020x;@b2021y]. Other [cite:@c2022z].")
         (c1 (string-search "[cite:@a2020x" text))
         (c2 (string-search "[cite:@c2022z" text))
         (answer
          `((format . "org") (counts . ((supports . 1) (partial . 1) (does_not_support . 0) (not_found . 0) (unverified . 1)))
            (stopped . :false) (error . :null) (costUsd . 0.07)
            (sentences . [((start . 0) (end . ,(+ c1 22)) (text . "s1")
                           (citations . [((start . ,c1) (end . ,(+ c1 22)) (keys . ["a2020x" "b2021y"]))])
                           (entries . [((key . "a2020x") (outcome . "supports") (quote . "fast parser") (page . 3) (note . "Matches."))
                                       ((key . "b2021y") (outcome . "no_evidence") (quote . "invented") (page . :null) (note . :null))]))
                          ((start . ,(+ c1 23)) (end . ,(length text)) (text . "s2")
                           (citations . [((start . ,c2) (end . ,(+ c2 14)) (keys . ["c2022z"]))])
                           (entries . [((key . "c2022z") (outcome . "partial") (quote . "somewhat") (page . 7) (note . :null))]))]))))
    (research-test--with-app (research-test--costly "cite_check" answer)
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t)))
        (with-temp-buffer
          (org-mode)
          (insert "Intro.\n" text)
          (research-check-citations-with-claude (+ (point-min) 7) (point-max))
          (should (equal (mapcar (lambda (d) (list (buffer-substring (nth 0 d) (nth 1 d)) (nth 2 d) (nth 3 d)))
                                 research--claude-diagnostics)
                         '(("[cite:@a2020x;@b2021y]" :note "a2020x: respalda — «fast parser», p. 3. Matches.")
                           ("[cite:@a2020x;@b2021y]" :error "b2021y: evidencia no encontrada en el paper — «invented»")
                           ("[cite:@c2022z]" :warning "c2022z: respalda en parte — «somewhat», p. 7"))))
          (let (reported)
            (research-flymake (lambda (diags) (setq reported diags)))
            (should (= (length reported) 3))))))))

(ert-deftest research-test-check-with-claude-declined-runs-nothing ()
  (research-test--with-app (research-test--costly "cite_check" '((sentences . [])))
    (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) nil)))
      (with-temp-buffer
        (insert "x [cite:@a2020x].")
        (research-check-citations-with-claude)
        (should (null research--claude-diagnostics))
        (should (= (length research-test--requests) 1))))))

(ert-deftest research-test-propose-outline-inserts-the-proposal ()
  (research-test--with-app
      (research-test--costly "outline_proposal" '((format . "latex") (text . "\\section{Parsing logs}\n") (unverified . 1) (costUsd . 0.03))
                             (lambda (args) (should (equal (alist-get 'format args) "latex"))))
    (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t)))
      (with-temp-buffer
        (latex-mode)
        (research-propose-outline)
        (should (equal (buffer-string) "\\section{Parsing logs}\n"))))))

(defconst research-test--style-text "Drain are fast. It parse logs. Third one here.")

(defun research-test--style-answer ()
  "Three suggestions for `research-test--style-text', at character offsets."
  (let ((text research-test--style-text))
    (vconcat
     (mapcar (lambda (o)
               `((id . 0) (start . ,(string-search (car o) text)) (end . ,(+ (string-search (car o) text) (length (car o))))
                 (original . ,(car o)) (suggestion . ,(cdr o)) (reason . "Better.") (category . "grammar")))
             '(("It parse logs" . "It parses logs") ("Drain are fast" . "Drain is fast") ("Third one" . "The third one"))))))

(defun research-test--style-run (keys &optional on-run)
  "Run the style review answering KEYS; return the buffer text.
ON-RUN runs in the buffer before the confirmed call answers."
  (let (buffer)
    (research-test--with-app
        (research-test--costly "style" `((suggestions . ,(research-test--style-answer)) (dropped . ((protected . 1))) (costUsd . 0.02))
                               (and on-run (lambda (_) (with-current-buffer buffer (funcall on-run)))))
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t))
                ((symbol-function 'read-char-choice) (lambda (prompt _) (should (string-match-p "→" prompt)) (pop keys))))
        (with-temp-buffer
          (setq buffer (current-buffer))
          (insert research-test--style-text)
          (research-style-review)
          (should-not (overlays-in (point-min) (point-max)))
          (buffer-string))))))

(ert-deftest research-test-style-review-walks-suggestions-like-query-replace ()
  ;; In text order: Drain are fast (y), It parse logs (n), Third one (y).
  (should (equal (research-test--style-run (list ?y ?n ?y)) "Drain is fast. It parse logs. The third one here."))
  ;; ! accepts this one and the rest.
  (should (equal (research-test--style-run (list ?n ?!)) "Drain are fast. It parses logs. The third one here."))
  ;; q stops, keeping what was accepted.
  (should (equal (research-test--style-run (list ?y ?q)) "Drain is fast. It parse logs. Third one here.")))

(ert-deftest research-test-style-review-refuses-when-the-buffer-changed ()
  (let ((err (should-error (research-test--style-run (list ?y ?y ?y) (lambda () (goto-char (point-min)) (insert "New. ")))
                           :type 'user-error)))
    (should (string-match-p "cambió" (cadr err)))))

;;;; The tutor

(ert-deftest research-test-tutor-notes-the-paragraph-at-point-in-its-own-backend ()
  (let* ((para "Esto mejora 😀 el modelo. Se aplicó la técnica.")
         (start (string-search "Se aplicó" para))
         (answer `((format . "org") (dropped . ((not_found . 0) (ambiguous . 0) (rewrite . 1))) (costUsd . 0.02)
                   (issues . [((start . ,start) (end . ,(+ start 20)) (excerpt . "Se aplicó la técnica") (kind . "lost_subject")
                               (explanation . "No se sabe quién.") (question . "¿Quién la aplicó?"))])))
         sent)
    (research-test--with-app (research-test--costly "tutor" answer (lambda (args) (setq sent args)))
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t)))
        (with-temp-buffer
          (org-mode)
          (insert "Primer párrafo.\n\n" para "\n\nOtro.\n")
          (goto-char (point-min))
          (search-forward "aplicó")
          (research-tutor)
          (should (equal (alist-get 'text sent) para))
          (should (equal (mapcar (lambda (d) (list (buffer-substring (nth 0 d) (nth 1 d)) (nth 2 d) (nth 3 d))) research--tutor-diagnostics)
                         '(("Se aplicó la técnica" :note "Tutor [sujeto perdido]: No se sabe quién. ¿Quién la aplicó?"))))
          (should (memq #'research-tutor-flymake flymake-diagnostic-functions))
          (should-not (memq #'research-flymake flymake-diagnostic-functions))
          ;; Asking again about the same paragraph replaces its notes.
          (research-tutor)
          (should (= (length research--tutor-diagnostics) 1))
          (let (reported)
            (research-tutor-flymake (lambda (d) (setq reported d)))
            (should (= (length reported) 1)))
          (flymake-mode -1))))))

(ert-deftest research-test-tutor-refuses-a-long-text-before-asking-and-declining-runs-nothing ()
  (research-test--with-app (research-test--costly "tutor" '((issues . [])))
    (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) nil)))
      (with-temp-buffer
        (insert (make-string 8001 ?a))
        (should-error (research-tutor (point-min) (point-max)) :type 'user-error)
        (should (null research-test--requests))
        (erase-buffer)
        (insert "Una oración.")
        (research-tutor (point-min) (point-max))
        (should (= (length research-test--requests) 1))
        (should (null research--tutor-diagnostics))))))

(defun research-test--alternatives-answer ()
  "Two alternatives of the test sentence."
  '((format . "org") (dropped . ((protected . 0))) (costUsd . 0.01)
    (alternatives . [((text . "Existen parsers en línea [cite:@a2020x].") (aspect . "order") (what_changes . "Empieza por el verbo."))
                     ((text . "Hay parsers en línea [cite:@a2020x].") (aspect . "register") (what_changes . "Más llano."))])))

(defmacro research-test--with-alternatives (&rest body)
  "Run BODY in the alternatives buffer of «Los parsers en línea existen [cite:@a2020x].»."
  (declare (indent 0))
  `(let (sent)
     (research-test--with-app (research-test--costly "alternatives" (research-test--alternatives-answer) (lambda (args) (setq sent args)))
       (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t))
                 ((symbol-function 'pop-to-buffer) (lambda (b &rest _) (set-buffer b))))
         (with-temp-buffer
           (org-mode)
           (insert "Primero. Los parsers en línea existen [cite:@a2020x]. Después.")
           (goto-char (point-min))
           (search-forward "parsers")
           (let ((origin (current-buffer)))
             (save-current-buffer
               (research-alternatives)
               (should (equal (alist-get 'sentence sent) "Los parsers en línea existen [cite:@a2020x]."))
               (should (string-match-p "Primero\\." (alist-get 'context sent)))
               (should (derived-mode-p 'research-alternatives-mode))
               ,@body)
             (with-current-buffer origin (buffer-string))))))))

(ert-deftest research-test-alternatives-ret-replaces-the-unchanged-sentence ()
  (should (equal (research-test--with-alternatives
                   (should (string-match-p "1\\. orden: Empieza por el verbo\\." (buffer-string)))
                   (should (string-match-p "2\\. registro: Más llano\\." (buffer-string)))
                   (research-alternatives-next)
                   (research-alternatives-choose))
                 "Primero. Hay parsers en línea [cite:@a2020x]. Después."))
  (should (equal (research-test--with-alternatives (research-alternatives-keep))
                 "Primero. Los parsers en línea existen [cite:@a2020x]. Después.")))

(ert-deftest research-test-alternatives-refuse-when-the-sentence-changed ()
  (research-test--with-alternatives
    (pcase-let ((`(,buffer ,beg) research--alternatives-origin))
      (with-current-buffer buffer (save-excursion (goto-char (1+ beg)) (insert "X"))))
    (should-error (research-alternatives-choose) :type 'user-error)))

(ert-deftest research-test-reverse-outline-lists-paragraphs-and-jumps-to-them ()
  (let* ((text "* Métodos\nUno sobre el método.\n\nDos sobre otra cosa.\n")
         (answer `((format . "org") (costUsd . 0.04) (dropped . ((off_topic_without_heading . 0)))
                   (paragraphs . [((index . 1) (start . 10) (end . 30) (heading . "Métodos") (main_idea . "El método.") (flags . []))
                                  ((index . 2) (start . 32) (end . 52) (heading . "Métodos") (main_idea . "Otra cosa.")
                                   (flags . [((flag . "off_topic") (note . "No trata del método."))]))])))
         sent)
    (research-test--with-app (research-test--costly "reverse_outline" answer (lambda (args) (setq sent args)))
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t))
                ((symbol-function 'display-buffer) #'ignore)
                ((symbol-function 'pop-to-buffer) (lambda (b &rest _) (set-buffer b))))
        (with-temp-buffer
          (org-mode)
          (insert "Antes.\n" text "* Otra\nFuera.\n")
          (goto-char (point-min))
          (search-forward "Dos")
          (let ((origin (current-buffer)))
            (research-reverse-outline)
            (should (equal (alist-get 'text sent) text))
            (with-current-buffer "*research reverse outline*"
              (should (string-match-p "  1\\. El método\\.\n" (buffer-string)))
              (should (string-match-p "  2\\. Otra cosa\\.  \\[fuera del tema: No trata del método\\.\\]" (buffer-string)))
              (goto-char (point-min))
              (search-forward "Otra cosa")
              (research-outline-visit)
              (should (eq (current-buffer) origin))
              (should (looking-at "Dos sobre otra cosa")))
            (kill-buffer "*research reverse outline*")))))))

(ert-deftest research-test-rq-coverage-reports-per-heading-and-what-is-left ()
  (let* ((text "* Introducción\nLa sanitización preserva la utilidad.\n")
         (answer `((format . "org") (costUsd . 0.03) (dropped . ((not_found . 0)))
                   (questions . [((id . "RQ1") (text . "¿Qué técnicas preservan la utilidad?")) ((id . "RQ2") (text . "¿Cómo trazar la evidencia?"))])
                   (sections . [((id . "S1") (heading . "Introducción") (start . 0) (end . ,(length text))
                                 (addresses . [((rq . "RQ1") (excerpt . "La sanitización preserva la utilidad.") (start . 15) (end . 52))]))])
                   (not_addressed . ["RQ2"]))))
    (research-test--with-app (research-test--costly "rq_coverage" answer)
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t))
                ((symbol-function 'pop-to-buffer) (lambda (b &rest _) (set-buffer b))))
        (with-temp-buffer
          (org-mode)
          (insert text)
          (let ((origin (current-buffer)))
            (save-current-buffer (research-rq-coverage))
            (with-current-buffer "*research RQ coverage*"
              (should (string-match-p "RQ1: ¿Qué técnicas" (buffer-string)))
              (should (string-match-p "Introducción — RQ1\n  RQ1: «La sanitización preserva la utilidad\\.»" (buffer-string)))
              (should (string-match-p "Sin abordar: RQ2" (buffer-string)))
              (goto-char (point-min))
              (search-forward "«La")
              (research-outline-visit)
              (should (eq (current-buffer) origin))
              (should (looking-at "La sanitización")))
            (kill-buffer "*research RQ coverage*")))))))

;;;; Asking Claude

(defconst research-test--ask-id "20261029-120000-a1b2")

(defconst research-test--ask-doc
  "* Capítulo 2\n** Parsers\nPrimer párrafo.\n\nDrain es el mejor [cite:@he2017drain].\nSigue la idea.\n\n** Otra\nFin.\n")

(defun research-test--ask-plan (&rest extra)
  "A plan of `ask' with EXTRA fields."
  (research-test--result (append '((confirmation_required . t) (operation . "chat") (model . "sonnet") (estimate_usd . 0.1)
                                   (cap_usd . 0.5) (month_spent_usd . 0) (month_cap_usd . :null) (answering . :false))
                                 extra)))

(defconst research-test--ask-done
  '((conversation_id . "20261029-120000-a1b2") (status . "done") (mode . "opinion")
    (text . "*Bien*: la idea se apoya en [he2017drain, p. 1] pero falta [zhu2020loghub].")
    (citations . [((start . 29) (end . 48) (key . "he2017drain") (page . 1) (quote . "Drain parses log messages online") (state . "found") (verified . t))
                  ((start . 60) (end . 75) (key . "zhu2020loghub") (page . :null) (quote . "A dataset") (state . "not_found") (verified . :false))])
    (unverified . 1) (costUsd . 0.04) (conversation_cost_usd . 0.04) (model . "claude-sonnet-5")))

(defmacro research-test--with-ask-buffer (&rest body)
  "Run BODY in an Org buffer holding `research-test--ask-doc', point in its second paragraph."
  (declare (indent 0))
  `(with-temp-buffer
     (org-mode)
     (insert research-test--ask-doc)
     (set-buffer-modified-p nil)
     (goto-char (point-min))
     (search-forward "mejor")
     (unwind-protect (progn ,@body)
       (when (get-buffer "*research-ask*") (kill-buffer "*research-ask*")))))

(ert-deftest research-test-ask-sends-the-paragraph-and-streams-the-answer-without-touching-the-buffer ()
  (let ((statuses (list '((conversation_id . "20261029-120000-a1b2") (status . "running") (text . "*Bien*: la idea") (tools . 1))
                        research-test--ask-done))
        poll asked messages)
    (research-test--with-app
        (lambda (tool args)
          (pcase tool
            ("ask"
             (push args asked)
             (if (alist-get 'confirmed args)
                 (research-test--result `((conversation_id . ,research-test--ask-id) (status . "running") (costUsd . 0) (model . "sonnet")))
               (research-test--ask-plan '(mode . "opinion"))))
            ("ask_status"
             (should (equal args `((conversation_id . ,research-test--ask-id))))
             (research-test--result (pop statuses)))))
      (research-test--with-draft-timer poll
        (research-test--with-ask-buffer
          (let ((before (buffer-string)) prompts)
            (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "¿Se sostiene?"))
                      ((symbol-function 'read-char-choice) (lambda (prompt &rest _) (push prompt prompts) ?\r))
                      ((symbol-function 'yes-or-no-p) (lambda (prompt) (push prompt prompts) t))
                      ((symbol-function 'message) (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
              (should (equal (call-interactively #'research-ask) research-test--ask-id)))
            (should (string-match-p "(y/N)" (cadr prompts)))
            (should (string-match-p "chat con sonnet: costo estimado \\$0\\.10" (car prompts)))
            ;; The plan and the run send the same: the paragraph, its file and heading path, opinion.
            (let ((run (car asked)))
              (should (equal (cl-remove 'confirmed (cadr asked) :key #'car) (cl-remove 'confirmed run :key #'car)))
              (should (equal (alist-get 'text run) "Drain es el mejor [cite:@he2017drain].\nSigue la idea."))
              (should (equal (alist-get 'scope run) "paragraph"))
              (should (equal (alist-get 'section run) "Capítulo 2 › Parsers"))
              (should (equal (alist-get 'mode run) "opinion"))
              (should (equal (alist-get 'question run) "¿Se sostiene?")))
            (with-current-buffer "*research-ask*"
              (should (derived-mode-p 'org-mode))
              (should buffer-read-only)
              (should (string-match-p "Alcance: párrafo" (buffer-string)))
              (should (string-match-p "\\* ¿Se sostiene\\?\nModo: opinión (sin reescribir tu texto) · respondiendo…" (buffer-string))))
            (funcall poll)
            (with-current-buffer "*research-ask*"
              (should (string-match-p "respondiendo…\n\n\\*Bien\\*: la idea\\'" (buffer-string))))
            (cl-letf (((symbol-function 'message) (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
              (funcall poll))
            (should-not (plist-get (buffer-local-value 'research--ask-state (get-buffer "*research-ask*")) :timer))
            (with-current-buffer "*research-ask*"
              (should (string-match-p "Modo: opinión (sin reescribir tu texto) · US\\$0\\.04 (conversación US\\$0\\.04)" (buffer-string)))
              (should (string-match-p "pero falta \\[zhu2020loghub\\]\\.\n\nCitas:\n- \\[he2017drain, p\\. 1\\] verificada: «Drain parses log messages online»\n- \\[zhu2020loghub\\] sin verificar: «A dataset»\n" (buffer-string)))
              (goto-char (point-min))
              (search-forward "[he2017")
              (should (equal (alist-get 'key (get-text-property (point) 'research-ask-citation)) "he2017drain"))
              (should (eq (get-text-property (point) 'face) 'link))
              (search-forward "[zhu2020")
              (should (eq (get-text-property (point) 'face) 'warning)))
            (should (string-match-p "2 citas, 1 sin verificar" (car messages)))

            ;; The user's buffer is never changed.
            (should (equal (buffer-string) before))
            (should-not (buffer-modified-p))))))))

(ert-deftest research-test-ask-follow-up-stop-citation-and-conversation-in-the-app ()
  (let (poll asked opened)
    (research-test--with-app
        (lambda (tool args)
          (pcase tool
            ("ask"
             (push args asked)
             (if (alist-get 'confirmed args)
                 (research-test--result `((conversation_id . ,research-test--ask-id) (status . "running")))
               (research-test--ask-plan)))
            ("ask_status" (research-test--result research-test--ask-done))
            ("ask_stop" (push (cons tool args) opened) (research-test--result `((conversation_id . ,research-test--ask-id) (stopping . t))))
            ((or "open_in_app" "open_chat_in_app") (push (cons tool args) opened) (research-test--result '((opened . t))))))
      (research-test--with-draft-timer poll
        (research-test--with-ask-buffer
          (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "Q1"))
                    ((symbol-function 'read-char-choice) (lambda (&rest _) ?n))
                    ((symbol-function 'yes-or-no-p) (lambda (_) t))
                    ((symbol-function 'message) #'ignore))
            (call-interactively #'research-ask)
            (with-current-buffer "*research-ask*"
              ;; While it answers, another question is refused before asking the app anything.
              (let ((sent (length research-test--requests)))
                (should-error (call-interactively #'research-ask-follow-up) :type 'user-error)
                (should (= (length research-test--requests) sent)))
              (should (eq (key-binding (kbd "s")) #'research-ask-stop))
              (research-ask-stop)
              (should (equal (car opened) `("ask_stop" (conversation_id . ,research-test--ask-id))))
              (funcall poll)
              ;; `c' on a citation opens its paper at the page with the quote; `a' the conversation.
              (goto-char (point-min))
              (search-forward "[he2017")
              (should (eq (key-binding (kbd "c")) #'research-ask-open-citation))
              (research-ask-open-citation)
              (should (equal (car opened) '("open_in_app" (key . "he2017drain") (page . 1) (quote . "Drain parses log messages online"))))
              (search-forward "\n- [zhu")
              (research-ask-open-citation)
              (should (equal (car opened) '("open_in_app" (key . "zhu2020loghub") (quote . "A dataset"))))
              (goto-char (point-min))
              (should-error (research-ask-open-citation) :type 'user-error)
              (research-ask-open-in-app)
              (should (equal (car opened) `("open_chat_in_app" (conversation_id . ,research-test--ask-id))))
              ;; `f': a follow-up in the same conversation, without the passage; a rewrite only when allowed.
              (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "¿Y si lo reescribes?"))
                        ((symbol-function 'read-char-choice) (lambda (&rest _) ?y)))
                (call-interactively #'research-ask-follow-up))
              (should (equal (cl-remove 'confirmed (car asked) :key #'car)
                             `((question . "¿Y si lo reescribes?") (conversation_id . ,research-test--ask-id) (mode . "rewrite"))))
              (should (string-match-p "\\* ¿Y si lo reescribes\\?\nModo: propuesta de redacción permitida · respondiendo…" (buffer-string)))
              (funcall poll)
              (should (= 2 (how-many "^Citas:" (point-min) (point-max))))
              (should (string-match-p "\\* Q1\n.*US\\$0\\.04" (buffer-string))))))))))

(ert-deftest research-test-ask-scopes-region-subtree-and-file ()
  (research-test--with-ask-buffer
    (should (equal (research--ask-scope nil) (cons "paragraph" (research--paragraph-bounds))))
    (let ((subtree (research--ask-scope '(4))))
      (should (equal (car subtree) "subtree"))
      (should (equal (buffer-substring-no-properties (cadr subtree) (cddr subtree))
                     "** Parsers\nPrimer párrafo.\n\nDrain es el mejor [cite:@he2017drain].\nSigue la idea.\n\n")))
    (should (equal (research--ask-scope '(16)) (cons "file" (cons (point-min) (point-max)))))
    (should (equal (research--ask-section (point)) "Capítulo 2 › Parsers"))
    (transient-mark-mode 1)
    (set-mark (point-min))
    (goto-char 5)
    (activate-mark)
    (should (equal (research--ask-scope '(16)) (cons "region" (cons (point-min) 5))))
    (deactivate-mark))
  ;; Without headings, C-u is the whole file and the section is empty.
  (with-temp-buffer
    (insert "Solo texto.\n")
    (should (equal (research--ask-scope '(4)) (cons "file" (cons (point-min) (point-max)))))
    (should (equal (research--ask-section (point)) ""))))

(ert-deftest research-test-ask-refuses-and-cancels-before-starting ()
  (research-test--with-app
      (lambda (tool args)
        (should (equal tool "ask"))
        (should-not (alist-get 'confirmed args))
        (research-test--ask-plan))
    (research-test--with-ask-buffer
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) nil))
                ((symbol-function 'message) #'ignore))
        (should-not (research-ask "Q" "opinion"))
        (should-not (get-buffer "*research-ask*")))
      (erase-buffer)
      (insert "\n\n\n")
      (goto-char 2)
      (should-error (research-ask "Q" "opinion") :type 'user-error)
      (let ((long (make-string 30001 ?a)))
        (erase-buffer)
        (insert long)
        (goto-char 10)
        (should-error (research-ask "Q" "opinion" '(16)) :type 'user-error))
      (should (= 1 (length research-test--requests))))))

(ert-deftest research-test-ask-shows-why-an-answer-failed ()
  (let (poll messages)
    (research-test--with-app
        (lambda (tool args)
          (pcase tool
            ("ask" (if (alist-get 'confirmed args) (research-test--result `((conversation_id . ,research-test--ask-id))) (research-test--ask-plan)))
            ("ask_status" (research-test--result `((conversation_id . ,research-test--ask-id) (status . "error") (error . "chat_message_budget"))))))
      (research-test--with-draft-timer poll
        (research-test--with-ask-buffer
          (cl-letf (((symbol-function 'yes-or-no-p) (lambda (_) t))
                    ((symbol-function 'message) (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
            (research-ask "Q" "rewrite")
            (funcall poll)
            (with-current-buffer "*research-ask*"
              (should (string-match-p "Modo: propuesta de redacción permitida · sin respuesta: se alcanzó el tope por mensaje de chat" (buffer-string)))
              (should-not (plist-get research--ask-state :timer)))
            (should (string-match-p "Claude no respondió" (car messages)))))))))

;;;; Minor mode

(ert-deftest research-test-mode-binds-the-commands ()
  (with-temp-buffer
    (org-mode)
    (research-mode 1)
    (should (eq (key-binding (kbd "C-c r c")) #'research-insert-citation))
    (should (eq (key-binding (kbd "C-c r f")) #'research-find-passage))
    (should (eq (key-binding (kbd "C-c r t")) #'research-tutor))
    (should (eq (key-binding (kbd "C-c r w")) #'research-alternatives))
    (should (eq (key-binding (kbd "C-c r r")) #'research-reverse-outline))
    (should (eq (key-binding (kbd "C-c r q")) #'research-rq-coverage))
    (should (eq (key-binding (kbd "C-c r l")) #'research-prose-check))
    (should (eq (key-binding (kbd "C-c r ?")) #'research-ask))
    (should (commandp 'research-prose-check))
    (research-mode -1)
    (should-not (eq (key-binding (kbd "C-c r c")) #'research-insert-citation))))

(provide 'research-test)
;;; research-test.el ends here
