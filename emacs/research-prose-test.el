;;; research-prose-test.el --- Tests for research-prose.el -*- lexical-binding: t; -*-

;; Run: emacs --batch -L emacs -l emacs/research-prose-test.el -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'org)
(require 'flymake)
(require 'research-prose)

(defmacro research-prose-test--in (text &rest body)
  "Run BODY in an Org buffer holding TEXT, with every check on and no acronym file."
  (declare (indent 1))
  `(with-temp-buffer
     (let ((research-prose-checks research-prose--all-checks)
           (research-prose-term-groups nil)
           (research-prose-acronym-files '("no-such-acronym-file.tex"))
           (default-directory temporary-file-directory))
       (insert ,text)
       (org-mode)
       ,@body)))

(defun research-prose-test--found (&optional check)
  "The diagnostics of the buffer as (CHECK TYPE TEXT-COVERED), of CHECK only when given."
  (cl-loop for (beg end type _text kind) in (research-prose-diagnostics)
           when (or (null check) (eq kind check))
           collect (list kind type (buffer-substring-no-properties beg end))))

(defun research-prose-test--messages (check)
  "The messages of CHECK's diagnostics in the buffer."
  (cl-loop for d in (research-prose-diagnostics) when (eq (nth 4 d) check) collect (nth 3 d)))

;;;; Words, syllables, sentences

(ert-deftest research-prose-test-syllables ()
  (should (equal (mapcar #'research-prose-syllables
                         '("anonimización" "país" "maíz" "guerra" "que" "guiso" "ciudad" "río" "poeta" "hay" "y" "aéreo" "pingüino"))
                 '(6 2 2 2 1 2 2 2 3 1 1 4 3))))

(ert-deftest research-prose-test-inflesz ()
  ;; 206.835 - 62.3 * 2 - 10 = 72.235
  (should (< (abs (- (research-prose-inflesz 100 200 10) 72.235)) 1e-6)))

(ert-deftest research-prose-test-stem-groups-inflections ()
  (should (equal (research-prose--stem "registros") (research-prose--stem "registro")))
  (should (equal (research-prose--stem "Anonimización") (research-prose--stem "anonimizaciones")))
  (should-not (equal (research-prose--stem "modelo") (research-prose--stem "registro"))))

(ert-deftest research-prose-test-sentences-respect-abbreviations ()
  (let ((text "Los registros, p. ej. los de red, según He et al. (2017) bastan. ¿Y los otros? Sí. Fin"))
    (should (equal (mapcar (lambda (s) (substring text (car s) (cdr s))) (research-prose-sentences text))
                   '("Los registros, p. ej. los de red, según He et al. (2017) bastan." "¿Y los otros?" "Sí." "Fin")))))

;;;; What is ignored

(ert-deftest research-prose-test-mask-keeps-length-and-hides-markup ()
  (let* ((text "Según [cite:@he2017drain p. 3], el \\gls{llm} y $x^2$ en [[https://a.b/en base a][el sitio]] con =cabe mencionar= y \\emph{texto}.")
         (masked (research-prose-mask text)))
    (should (= (length masked) (length text)))
    (should-not (string-match-p "cite\\|gls\\|llm\\|https\\|en base a\\|cabe\\|emph\\|\\$" masked))
    (should (string-match-p "el sitio" masked))
    (should (string-match-p "texto" masked))))

(ert-deftest research-prose-test-ignores-non-prose ()
  (research-prose-test--in
      (concat "#+title: Cabe mencionar en el título\n"
              "* Cabe mencionar en un encabezado\n"
              ":PROPERTIES:\n:NOTE: cabe mencionar en un cajón\n:END:\n"
              "#+begin_src python\ncabe_mencionar = 'en base a'\n#+end_src\n"
              "#+begin_example\ncabe mencionar\n#+end_example\n"
              "#+begin_export latex\ncabe mencionar\n#+end_export\n"
              "| cabe mencionar | en base a |\n"
              "# cabe mencionar en un comentario\n"
              "\\begin{equation}\ncabe mencionar\n\\end{equation}\n"
              "$$\ncabe mencionar\n$$\n"
              ": cabe mencionar en ancho fijo\n"
              "Prosa limpia [cite:@a2020x; @hoy-en-dia] y [[file:en base a.org]].\n")
    (should (null (research-prose-test--found)))))

(ert-deftest research-prose-test-paragraphs-split-on-blank-lines-and-list-items ()
  (research-prose-test--in "Uno dos.\nTres.\n\nCuatro.\n- cinco\n- seis\n* Título\nSiete.\n"
    (should (equal (mapcar (lambda (p) (buffer-substring-no-properties (car p) (cdr p)))
                           (research-prose--paragraphs (point-min) (point-max)))
                   '("Uno dos.\nTres." "Cuatro." "- cinco" "- seis" "Siete.")))))

;;;; Checks

(ert-deftest research-prose-test-long-sentence ()
  (let ((long (concat (mapconcat #'identity (make-list 41 "palabra") " ") ".")))
    (research-prose-test--in (concat long " Corta.")
      (let ((found (research-prose-test--found 'long-sentence)))
        (should (equal (mapcar #'cadr found) '(:warning)))
        (should (equal (nth 2 (car found)) long)))
      (should (string-match-p "41 palabras; máximo 40" (car (research-prose-test--messages 'long-sentence))))
      (let ((research-prose-max-sentence-words 50))
        (should (null (research-prose-test--found 'long-sentence)))))))

(ert-deftest research-prose-test-repetition ()
  (research-prose-test--in "Los registros del sistema son útiles. Analizamos un registro cada vez."
    (should (equal (research-prose-test--found 'repetition) '((repetition :note "registro")))))
  ;; Far apart, stopwords, and terms of a group are not flagged.
  (research-prose-test--in (concat "Los registros importan. " (mapconcat #'identity (make-list 31 "palabra") " ") " registro.")
    (should (cl-notany (lambda (f) (equal (nth 2 f) "registro")) (research-prose-test--found 'repetition))))
  (research-prose-test--in "Además del método, además de otro."
    (should (null (research-prose-test--found 'repetition))))
  (let ((research-prose-term-groups '(("anonimización" "sanitización"))))
    (research-prose-test--in "La anonimización y otra anonimización."
      (let ((research-prose-term-groups '(("anonimización" "sanitización"))))
        (should (null (research-prose-test--found 'repetition)))))))

(ert-deftest research-prose-test-filler-phrases ()
  (research-prose-test--in
      "Cabe mencionar que hay datos. Es importante\nseñalar esto. En este sentido, sigue. Se evalúa a nivel de red y en base a reglas. Hoy en día es así. Se describe en el mismo."
    (should (equal (mapcar #'caddr (research-prose-test--found 'filler))
                   '("Cabe mencionar" "Es importante\nseñalar" "En este sentido" "a nivel de" "en base a" "Hoy en día" "en el mismo")))
    (should (cl-every (lambda (m) (string-prefix-p "Muletilla: «" m)) (research-prose-test--messages 'filler))))
  ;; «el mismo» as an adjective is fine.
  (research-prose-test--in "El mismo autor lo dice."
    (should (null (research-prose-test--found 'filler)))))

(ert-deftest research-prose-test-gerunds ()
  (research-prose-test--in "Usando reglas y aplicando filtros, siendo rápido. Cuando llega, comandos simples."
    (should (equal (research-prose-test--found 'gerund) '((gerund :note "aplicando") (gerund :note "siendo")))))
  (let ((research-prose-max-gerunds 3))
    (research-prose-test--in "Usando reglas y aplicando filtros, siendo rápido."
      (should (null (research-prose-test--found 'gerund))))))

(ert-deftest research-prose-test-mente-adverbs ()
  (research-prose-test--in "Funciona rápidamente y eficientemente. Que se implemente claramente."
    (should (equal (research-prose-test--found 'adverb) '((adverb :note "eficientemente"))))))

(ert-deftest research-prose-test-periphrastic-passive ()
  (research-prose-test--in "Los datos fueron analizados. El texto fue cuidadosamente escrito. El método es válido y es adecuado. Ha sido propuesta."
    (should (equal (mapcar #'caddr (research-prose-test--found 'passive))
                   '("fueron analizados" "fue cuidadosamente escrito" "sido propuesta")))))

(ert-deftest research-prose-test-readability ()
  (let ((hard (concat (mapconcat #'identity (make-list 45 "desensibilización") " ") ".")))
    (research-prose-test--in hard
      (let ((found (research-prose-test--found 'readability)))
        (should (equal (mapcar #'cadr found) '(:note)))
        (should (string-match-p "INFLESZ -?[0-9]+ (muy difícil" (car (research-prose-test--messages 'readability)))))))
  (let ((easy (concat (mapconcat #'identity (make-list 9 "La casa es mía.") " "))))
    (research-prose-test--in easy
      (should (null (research-prose-test--found 'readability)))))
  ;; Short paragraphs are not scored.
  (research-prose-test--in "Desensibilización desensibilización."
    (should (null (research-prose-test--found 'readability)))))

(ert-deftest research-prose-test-term-consistency ()
  (let ((text "#+PROSE_TERMS: desensibilización|anonimización|sanitización\nLa anonimización ayuda. Las anonimizaciones varían. La anonimización falla.\n\nLa desensibilización también.\n"))
    (research-prose-test--in text
      (should (equal (research-prose-test--found 'terms) '((terms :warning "desensibilización"))))
      (should (string-match-p "«anonimización» 3, «desensibilización» 1" (car (research-prose-test--messages 'terms))))))
  ;; From the defcustom too; one variant alone is never flagged.
  (let ((research-prose-term-groups '(("registro" "log"))))
    (research-prose-test--in "Cada registro y cada log."
      (let ((research-prose-term-groups '(("registro" "log"))))
        (should (= (length (research-prose-test--found 'terms)) 1))))
    (research-prose-test--in "Cada registro y otro registro."
      (let ((research-prose-term-groups '(("registro" "log"))))
        (should (null (research-prose-test--found 'terms)))))))

(ert-deftest research-prose-test-acronyms ()
  (let* ((root (make-temp-file "research-prose" t))
         (sub (expand-file-name "capitulos" root))
         (file (expand-file-name "cap1.org" sub)))
    (unwind-protect
        (progn
          (make-directory sub)
          (with-temp-file (expand-file-name "acronimos.tex" root)
            (insert "\\newacronym{llm}{LLM}{modelo de lenguaje grande}\n\\newacronym[longplural={x}]{pii}{PII}{información personal}\n% \\newacronym{old}{OLD}{viejo}\n"))
          (with-temp-buffer
            (setq buffer-file-name file)
            (insert "Los LLMs y el \\gls{llm} tratan PII, no OLD ni \\gls{old} ni \\glspl{xyz}. HTTP no está definido.\n")
            (org-mode)
            (let ((research-prose-checks '(acronyms))
                  (research-prose-acronym-files '("acronimos.tex")))
              (should (research-prose-thesis-file-p))
              (should (equal (research-prose-test--found 'acronyms)
                             '((acronyms :warning "LLMs") (acronyms :warning "PII")
                               (acronyms :error "\\gls{old}") (acronyms :error "\\glspl{xyz}"))))
              (should (string-match-p "Escríbelo \\\\gls{llm}" (car (research-prose-test--messages 'acronyms)))))
            (set-buffer-modified-p nil)))
      (delete-directory root t))))

(ert-deftest research-prose-test-checks-can-be-turned-off ()
  (research-prose-test--in "Cabe mencionar que los datos fueron analizados."
    (let ((research-prose-checks '(passive)))
      (should (equal (mapcar #'car (research-prose-test--found)) '(passive))))))

;;;; Commands

(ert-deftest research-prose-test-check-region-and-flymake ()
  (research-prose-test--in "Cabe mencionar algo.\n\nHoy en día otra cosa.\n"
    (let ((diags (research-prose-check (point-min) 22)))
      (should (equal (mapcar (lambda (d) (nth 4 d)) diags) '(filler))))
    (should (memq #'research-prose-flymake flymake-diagnostic-functions))
    (let (reported)
      (research-prose-flymake (lambda (d) (setq reported d)))
      (should (= (length reported) 1)))
    (flymake-mode -1)))

(ert-deftest research-prose-test-mode-adds-and-removes-the-backend ()
  (research-prose-test--in "Hoy en día.\n"
    (research-prose-mode 1)
    (should (memq #'research-prose-flymake flymake-diagnostic-functions))
    (research-prose-mode -1)
    (should-not (memq #'research-prose-flymake flymake-diagnostic-functions))
    (flymake-mode -1)))

(ert-deftest research-prose-test-fast-enough-for-a-chapter ()
  (research-prose-test--in
      (mapconcat #'identity
                 (make-list 400 "Cabe mencionar que los registros del sistema fueron analizados usando reglas y aplicando filtros, como muestra [cite:@he2017drain p. 3]. La anonimización de los registros es claramente y evidentemente útil hoy en día.")
                 "\n\n")
    (let ((start (float-time)))
      (research-prose-diagnostics)
      (should (< (- (float-time) start) 5.0)))))

(provide 'research-prose-test)
;;; research-prose-test.el ends here
