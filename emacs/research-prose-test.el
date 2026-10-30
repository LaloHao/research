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
              (should (string-match-p "Escríbelo \\\\glspl{llm}" (car (research-prose-test--messages 'acronyms)))))
            (set-buffer-modified-p nil)))
      (delete-directory root t))))

;;;; Acronyms: conversion and definition

(defconst research-prose-test--defs
  (concat "% Acrónimos de la tesis\n"
          "\\newacronym{llm}{LLM}{modelo de lenguaje grande}\n"
          "\\newacronym{ner}{REN}{reconocimiento de entidades nombradas}\n"
          "\\newacronym{pii}{PII}{información personal identificable}\n")
  "A sorted acronym file: the key of REN is ner.")

(defmacro research-prose-test--thesis (defs text &rest body)
  "Run BODY in an Org buffer visiting cap1.org with TEXT, next to an acronimos.tex holding DEFS.
The variable `root' is the folder."
  (declare (indent 2))
  `(let* ((root (file-name-as-directory (make-temp-file "research-prose" t)))
          (research-prose--acronym-cache nil)
          (research-prose-acronym-files '("acronimos.tex"))
          (research-prose-gls-capitalize t)
          (research-prose-term-groups nil))
     (unwind-protect
         (progn
           (with-temp-file (expand-file-name "acronimos.tex" root) (insert ,defs))
           (with-temp-buffer
             (setq buffer-file-name (expand-file-name "cap1.org" root))
             (insert ,text)
             (org-mode)
             (buffer-enable-undo)
             (goto-char (point-min))
             (unwind-protect (progn ,@body)
               (set-buffer-modified-p nil)
               (setq buffer-file-name nil))))
       (delete-directory root t))))

(defun research-prose-test--goto (text &optional nth)
  "Put point inside the NTH (1 by default) occurrence of TEXT."
  (goto-char (point-min))
  (search-forward text nil nil (or nth 1))
  (goto-char (1+ (match-beginning 0))))

(defun research-prose-test--text ()
  (buffer-substring-no-properties (point-min) (point-max)))

(defmacro research-prose-test--answering (answers &rest body)
  "Run BODY with `research-prose-gls-fix' reading ANSWERS (chars) in turn; the prompts go to `prompts'."
  (declare (indent 1))
  `(let* ((queue (copy-sequence ,answers))
          (prompts nil)
          (research-prose-gls-fix-read-function
           (lambda (prompt) (push prompt prompts) (or (pop queue) ?q))))
     ,@body))

(ert-deftest research-prose-test-gls-at-point ()
  (research-prose-test--thesis research-prose-test--defs
      "Los LLMs y el REN tratan PII. LLM gana; el llm no.\n"
    (research-prose-test--goto "LLMs")
    (research-prose-gls-at-point)
    (research-prose-test--goto "REN")
    (research-prose-gls-at-point)
    ;; At the end of the word, as after typing it.
    (research-prose-test--goto "PII")
    (forward-word)
    (research-prose-gls-at-point)
    (research-prose-test--goto "LLM gana")
    (research-prose-gls-at-point)
    (should (equal (research-prose-test--text)
                   "Los \\glspl{llm} y el \\gls{ner} tratan \\gls{pii}. \\Gls{llm} gana; el llm no.\n"))
    (research-prose-test--goto "llm no")
    (should-error (research-prose-gls-at-point) :type 'user-error))
  (research-prose-test--thesis research-prose-test--defs "Fin. LLMs al inicio.\n"
    (let ((research-prose-gls-capitalize nil))
      (research-prose-test--goto "LLMs")
      (research-prose-gls-at-point)
      (should (equal (research-prose-test--text) "Fin. \\glspl{llm} al inicio.\n")))))

(ert-deftest research-prose-test-gls-at-point-undefined-offers-to-add ()
  (research-prose-test--thesis research-prose-test--defs "El HTTP falla.\n"
    (research-prose-test--goto "HTTP")
    (let (asked)
      (cl-letf (((symbol-function 'y-or-n-p) (lambda (prompt) (setq asked prompt) nil)))
        (research-prose-gls-at-point))
      (should (string-match-p "«HTTP» no está en acronimos.tex" asked)))
    (should (equal (research-prose-test--text) "El HTTP falla.\n"))))

(ert-deftest research-prose-test-gls-fix-asks-like-query-replace ()
  (let ((text "LLM uno, REN dos, PII tres, LLMs cuatro, REN cinco.\n"))
    ;; y n ! : the rest without asking.
    (research-prose-test--thesis research-prose-test--defs text
      (research-prose-test--answering '(?y ?n ?!)
        (should (= (research-prose-gls-fix) 4))
        (should (= (length prompts) 3))
        (should (string-match-p "¿Convertir «LLM» en \\\\Gls{llm}?" (car (last prompts)))))
      (should (equal (research-prose-test--text)
                     "\\Gls{llm} uno, REN dos, \\gls{pii} tres, \\glspl{llm} cuatro, \\gls{ner} cinco.\n"))
      ;; The whole run is one undo step.
      (undo-boundary)
      (let ((last-command nil)) (undo))
      (should (equal (research-prose-test--text) text)))
    ;; q stops.
    (research-prose-test--thesis research-prose-test--defs text
      (research-prose-test--answering '(?y ?q)
        (should (= (research-prose-gls-fix) 1)))
      (should (equal (research-prose-test--text)
                     "\\Gls{llm} uno, REN dos, PII tres, LLMs cuatro, REN cinco.\n")))
    ;; Only the region.
    (research-prose-test--thesis research-prose-test--defs text
      (research-prose-test--answering '(?! )
        (should (= (research-prose-gls-fix 10 30) 2)))
      (should (equal (research-prose-test--text)
                     "LLM uno, \\gls{ner} dos, \\gls{pii} tres, LLMs cuatro, REN cinco.\n")))))

(ert-deftest research-prose-test-gls-fix-skips-what-is-not-prose ()
  (research-prose-test--thesis research-prose-test--defs
      (concat "#+title: El LLM\n"
              "* LLM en un encabezado\n"
              "#+begin_src python\nLLM = 1\n#+end_src\n"
              "#+begin_example\nLLM\n#+end_example\n"
              "# LLM en un comentario\n"
              ": LLM en ancho fijo\n"
              "Prosa con LLM, [cite:@LLM2020], [[file:LLM.org][el archivo]], \\gls{llm}, \\acrshort{llm}, $LLM$, =LLM=, ~LLM~ y \\newacronym{x}{LLM}{y}.\n"
              "| LLM | PII |\n|-----+-----|\n| REN | x   |\n")
    (research-prose-test--answering '(?!)
      (should (= (research-prose-gls-fix) 4)))
    (should (string-match-p (regexp-quote "Prosa con \\gls{llm}, [cite:@LLM2020], [[file:LLM.org][el archivo]], \\gls{llm}, \\acrshort{llm}, $LLM$, =LLM=, ~LLM~ y \\newacronym{x}{LLM}{y}.")
                            (research-prose-test--text)))
    (should (string-match-p (regexp-quote "| \\Gls{llm} | \\Gls{pii} |\n|-----+-----|\n| \\Gls{ner} | x   |")
                            (research-prose-test--text)))
    (should (string-prefix-p "#+title: El LLM\n* LLM en un encabezado\n#+begin_src python\nLLM = 1\n#+end_src\n#+begin_example\nLLM\n#+end_example\n# LLM en un comentario\n: LLM en ancho fijo\n"
                             (research-prose-test--text)))))

(defun research-prose-test--type (string)
  "Type STRING as `self-insert-command' would, one command per character."
  (dolist (c (string-to-list string))
    (let ((last-command-event c) (this-command 'self-insert-command))
      (self-insert-command 1))
    (undo-boundary)))

(ert-deftest research-prose-test-auto-gls-mode ()
  (research-prose-test--thesis research-prose-test--defs ""
    (research-prose-auto-gls-mode 1)
    (research-prose-test--type "Los LLMs y el REN")
    (should (equal (research-prose-test--text) "Los \\glspl{llm} y el REN"))
    (research-prose-test--type ".")
    (should (equal (research-prose-test--text) "Los \\glspl{llm} y el \\gls{ner}."))
    ;; One undo brings the acronym back and keeps the typed character.
    (let ((last-command nil)) (undo))
    (should (equal (research-prose-test--text) "Los \\glspl{llm} y el REN."))
    (goto-char (point-max))
    (research-prose-test--type " LLM\nPII =LLM= [[LLM] $LLM$ HTTP ")
    (should (equal (research-prose-test--text)
                   "Los \\glspl{llm} y el REN. \\Gls{llm}\n\\Gls{pii} =LLM= [[LLM] $LLM$ HTTP "))
    (research-prose-auto-gls-mode -1)
    (research-prose-test--type "LLM ")
    (should (string-suffix-p "HTTP LLM " (research-prose-test--text))))
  ;; Not inside a source block.
  (research-prose-test--thesis research-prose-test--defs "#+begin_src python\n\n#+end_src\n"
    (research-prose-auto-gls-mode 1)
    (forward-line 1)
    (research-prose-test--type "x = LLM ")
    (should (equal (research-prose-test--text) "#+begin_src python\nx = LLM \n#+end_src\n"))))

(ert-deftest research-prose-test-never-in-the-acronym-file ()
  (research-prose-test--thesis research-prose-test--defs "Nada.\n"
    (with-temp-buffer
      (setq buffer-file-name (expand-file-name "acronimos.tex" root))
      (insert "% LLM aquí\nEl LLM ")
      (research-prose-auto-gls-mode 1)
      (research-prose-test--type "PII ")
      (should (equal (research-prose-test--text) "% LLM aquí\nEl LLM PII "))
      (goto-char 15)
      (should-error (research-prose-gls-at-point) :type 'user-error)
      (should-error (research-prose-gls-fix) :type 'user-error)
      (set-buffer-modified-p nil)
      (setq buffer-file-name nil))))

(ert-deftest research-prose-test-spanish-plural ()
  (dolist (case '(("modelo de lenguaje de gran tamaño" . "modelos de lenguaje de gran tamaño")
                  ("inteligencia artificial" . "inteligencias artificiales")
                  ("interfaz de programación de aplicaciones" . "interfaces de programación de aplicaciones")
                  ("análisis de causa raíz" . "análisis de causa raíz")
                  ("red neuronal" . "redes neuronales")
                  ("Reglamento General de Protección de Datos" . "Reglamentos Generales de Protección de Datos")
                  ("algoritmo" . "algoritmos")))
    (should (equal (research-prose-spanish-plural (car case)) (cdr case)))))

(ert-deftest research-prose-test-add-acronym-long-plural ()
  (research-prose-test--thesis "\\newacronym{zz}{ZZ}{zeta}\n" "Texto.\n"
    (cl-letf (((symbol-function 'y-or-n-p) (lambda (_) t)))
      ;; A plural that glossaries wouldn't build by itself is written as longplural …
      (research-prose-add-acronym "LLM" "modelo de lenguaje de gran tamaño" "llm" "modelos de lenguaje de gran tamaño")
      ;; … and one that is just «s» more is left to glossaries.
      (research-prose-add-acronym "SO" "sistema operativo" "so" "sistema operativos")
      (research-prose-add-acronym "UI" "interfaz" "ui" "interfazs"))
    (let ((text (with-temp-buffer (insert-file-contents (expand-file-name "acronimos.tex" root)) (buffer-string))))
      (should (string-match-p (regexp-quote "\\newacronym[longplural={modelos de lenguaje de gran tamaño}]{llm}{LLM}{modelo de lenguaje de gran tamaño}") text))
      (should (string-match-p (regexp-quote "\\newacronym{ui}{UI}{interfaz}") text))
      ;; The reader still knows the acronyms defined with an optional argument.
      (should (equal (gethash "llm" (research-prose-read-acronyms (expand-file-name "acronimos.tex" root))) "LLM")))))

(ert-deftest research-prose-test-add-acronym ()
  (research-prose-test--thesis research-prose-test--defs "El HTTP falla.\n"
    (research-prose-test--goto "HTTP")
    (let (asked)
      (cl-letf (((symbol-function 'y-or-n-p) (lambda (prompt) (setq asked prompt) t)))
        (should (equal (research-prose-add-acronym "HTTP" "protocolo de transferencia de hipertexto") "http")))
      (should (string-match-p "¿Convertir «HTTP» en \\\\gls{http}?" asked)))
    (should (equal (research-prose-test--text) "El \\gls{http} falla.\n"))
    ;; Sorted file: in order of key; the comment stays.
    (should (equal (with-temp-buffer (insert-file-contents (expand-file-name "acronimos.tex" root)) (buffer-string))
                   (concat "% Acrónimos de la tesis\n"
                           "\\newacronym{http}{HTTP}{protocolo de transferencia de hipertexto}\n"
                           "\\newacronym{llm}{LLM}{modelo de lenguaje grande}\n"
                           "\\newacronym{ner}{REN}{reconocimiento de entidades nombradas}\n"
                           "\\newacronym{pii}{PII}{información personal identificable}\n")))
    ;; The cache knows it at once.
    (should (equal (gethash "http" (research-prose-read-acronyms (expand-file-name "acronimos.tex" root)))
                   "HTTP"))
    (should-error (research-prose-add-acronym "HTTP" "otra vez") :type 'user-error)
    (should-error (research-prose-add-acronym "XYZ" "otra" "llm") :type 'user-error))
  ;; Unsorted file: after the last definition (saving in the file's mode may add a final newline).
  (research-prose-test--thesis "\\newacronym{zz}{ZZ}{zeta}\n\\newacronym{aa}{AA}{a}\n% fin\n" "Texto.\n"
    (cl-letf (((symbol-function 'y-or-n-p) (lambda (_) t)))
      (research-prose-add-acronym "API" "interfaz de programación" "api"))
    (should (equal (with-temp-buffer (insert-file-contents (expand-file-name "acronimos.tex" root)) (buffer-string))
                   "\\newacronym{zz}{ZZ}{zeta}\n\\newacronym{aa}{AA}{a}\n\\newacronym{api}{API}{interfaz de programación}\n% fin\n")))
  ;; The user's own buffer of the file is the one changed and saved.
  (research-prose-test--thesis research-prose-test--defs "Texto.\n"
    (let ((own (find-file-noselect (expand-file-name "acronimos.tex" root))))
      (unwind-protect
          (progn
            (research-prose-add-acronym "API" "interfaz" nil)
            (should (buffer-live-p own))
            (should-not (buffer-modified-p own))
            (should (string-match-p "newacronym{api}{API}{interfaz}" (with-current-buffer own (buffer-string)))))
        (kill-buffer own)))))

(ert-deftest research-prose-test-undefined-acronyms-are-noted ()
  (research-prose-test--thesis research-prose-test--defs
      "El HTTP y las APIs del siglo XXI, OK, el LLM y \\gls{llm}; la parte II y la ABCDEFGHI.\n"
    (let ((research-prose-checks '(new-acronyms)))
      (should (equal (research-prose-test--found) '((new-acronyms :note "HTTP") (new-acronyms :note "APIs"))))
      (should (string-match-p "research-prose-add-acronym" (car (research-prose-test--messages 'new-acronyms)))))
    (let ((research-prose-checks '(acronyms)))
      (should (equal (research-prose-test--found) '((acronyms :warning "LLM")))))))

(ert-deftest research-prose-test-acronym-checks-include-table-rows ()
  (research-prose-test--thesis research-prose-test--defs "Prosa.\n\n| LLM | cabe mencionar |\n|-----+---|\n"
    (let ((research-prose-checks research-prose--all-checks))
      ;; Only the acronym check looks at tables.
      (should (equal (research-prose-test--found) '((acronyms :warning "LLM"))))
      (should (string-match-p "Escríbelo \\\\Gls{llm}" (car (research-prose-test--messages 'acronyms)))))))

(ert-deftest research-prose-test-add-acronym-to-a-file-without-definitions ()
  (research-prose-test--thesis "% vacío" "Texto.\n"
    (research-prose-add-acronym "API" "interfaz")
    (should (equal (with-temp-buffer (insert-file-contents (expand-file-name "acronimos.tex" root)) (buffer-string))
                   "% vacío\n\\newacronym{api}{API}{interfaz}\n"))))

(ert-deftest research-prose-test-maybe-enable-turns-on-auto-gls ()
  (research-prose-test--thesis research-prose-test--defs "Texto.\n"
    (let ((research-prose-thesis-directories nil))
      (let ((research-prose-auto-gls nil))
        (research-prose-maybe-enable)
        (should research-prose-mode)
        (should-not research-prose-auto-gls-mode))
      (let ((research-prose-auto-gls t))
        (research-prose-maybe-enable)
        (should research-prose-auto-gls-mode))
      (research-prose-mode -1)
      (research-prose-auto-gls-mode -1)
      (flymake-mode -1))))

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
