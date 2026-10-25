;;; research-prose.el --- Spanish academic prose checks for Org -*- lexical-binding: t; -*-

;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: wp, tex, convenience
;; URL: https://github.com/lalohao/research

;;; Commentary:

;; Local checks of Spanish academic prose, as Flymake diagnostics, for a thesis
;; written in Org.  Pure Emacs Lisp: no app, no external process, no cost.
;;
;; They point at a passage and explain why it may read badly; they never
;; rewrite it.  Each check can be turned off in `research-prose-checks':
;;
;; - long sentences (`research-prose-max-sentence-words');
;; - the same content word repeated within a few words (crude stemming);
;; - academic filler and frowned-upon phrases (`research-prose-filler-phrases');
;; - more than one gerund in a sentence;
;; - several adverbs in -mente in a sentence;
;; - periphrastic passive (ser + participle);
;; - INFLESZ readability per paragraph, below a threshold;
;; - term consistency (`research-prose-term-groups' and `#+PROSE_TERMS:');
;; - acronyms of the thesis' `acronimos.tex' written bare instead of with
;;   `\gls{KEY}', and `\gls{KEY}' of an undefined acronym.
;;
;; Org markup and what is not prose are ignored: headings, keywords, drawers,
;; src/example/export/comment/quote blocks, tables, comment lines, LaTeX
;; commands, environments and math, citations `[cite:…]', link targets,
;; macros, verbatim and code.
;;
;; `research-prose-check' checks the buffer (or the region) once;
;; `research-prose-mode' keeps the checks on while you write.

;;; Code:

(require 'cl-lib)
(require 'subr-x)

(declare-function flymake-make-diagnostic "flymake")
(declare-function flymake-start "flymake")
(defvar flymake-diagnostic-functions)
(defvar flymake-mode)

(defgroup research-prose nil
  "Spanish academic prose checks."
  :group 'research
  :prefix "research-prose-")

(defconst research-prose--all-checks
  '(long-sentence repetition filler gerund adverb passive readability terms acronyms)
  "Every check, in the order they run.")

(defcustom research-prose-checks research-prose--all-checks
  "The checks that run.  Remove one to turn it off."
  :type '(set (const :tag "Oraciones largas" long-sentence)
              (const :tag "Palabras repetidas" repetition)
              (const :tag "Muletillas académicas" filler)
              (const :tag "Varios gerundios en una oración" gerund)
              (const :tag "Varios adverbios en -mente" adverb)
              (const :tag "Pasiva perifrástica" passive)
              (const :tag "Legibilidad INFLESZ" readability)
              (const :tag "Coherencia de términos" terms)
              (const :tag "Acrónimos y \\gls" acronyms)))

(defcustom research-prose-max-sentence-words 40
  "A sentence with more words than this is flagged."
  :type 'integer)

(defcustom research-prose-repetition-window 30
  "Words within which a repeated content word is flagged."
  :type 'integer)

(defcustom research-prose-repetition-min-length 5
  "Words shorter than this are never flagged as repeated."
  :type 'integer)

(defcustom research-prose-max-gerunds 1
  "Gerunds a sentence may have before the next ones are flagged."
  :type 'integer)

(defcustom research-prose-max-mente-adverbs 1
  "Adverbs in -mente a sentence may have before the next ones are flagged."
  :type 'integer)

(defcustom research-prose-readability-threshold 40
  "A paragraph whose INFLESZ score is below this is noted.
INFLESZ (Szigriszt-Pazos): below 40 very hard, 40-55 somewhat hard (usual
in academic prose), 55-65 normal, 65-80 fairly easy, above 80 very easy."
  :type 'number)

(defcustom research-prose-readability-min-words 40
  "Paragraphs with fewer words are not scored."
  :type 'integer)

(defcustom research-prose-term-groups nil
  "Groups of terms that name the same concept, e.g.
\((\"desensibilización\" \"anonimización\" \"sanitización\")).
When a text uses several terms of a group, the less used ones are
flagged.  A file adds its own groups with keyword lines such as
`#+PROSE_TERMS: desensibilización|anonimización|sanitización'."
  :type '(repeat (repeat string)))

(defcustom research-prose-acronym-files '("acronimos.tex")
  "File names of the thesis' acronym list, looked for in the buffer's
directory and its parents (`locate-dominating-file').  The first one found
is read: its `\\newacronym{KEY}{SHORT}{LONG}' define the acronyms."
  :type '(repeat string))

(defcustom research-prose-skipped-blocks '("src" "example" "export" "comment" "quote" "verse")
  "Org blocks (#+begin_NAME) whose content is not checked."
  :type '(repeat string))

(defcustom research-prose-skipped-environments
  '("equation" "equation*" "align" "align*" "gather" "gather*" "multline" "multline*" "eqnarray" "eqnarray*"
    "displaymath" "math" "figure" "figure*" "table" "table*" "tabular" "tabularx" "longtable" "lstlisting"
    "verbatim" "minted" "tikzpicture" "algorithm" "algorithmic")
  "LaTeX environments whose content is not checked."
  :type '(repeat string))

(defcustom research-prose-thesis-directories nil
  "Directories of thesis files, for `research-prose-maybe-enable'.
When nil, a file is a thesis file when an acronym file of
`research-prose-acronym-files' is found above it."
  :type '(repeat directory))

;;;; Words

(defconst research-prose--stopwords
  (let ((table (make-hash-table :test #'equal)))
    (dolist (w '("acerca" "además" "ahora" "algún" "alguna" "algunas" "alguno" "algunos" "allí" "antes" "aquel"
                 "aquella" "aquellas" "aquellos" "aquí" "aunque" "bajo" "bastante" "cabe" "cada" "casi" "cierta"
                 "ciertas" "cierto" "ciertos" "como" "cómo" "contra" "cual" "cuales" "cuál" "cualquier" "cuando"
                 "cuanto" "cuya" "cuyas" "cuyo" "cuyos" "debe" "deben" "debido" "decir" "desde" "después" "dicha"
                 "dichas" "dicho" "dichos" "donde" "dónde" "durante" "ejemplo" "embargo" "entonces" "entre" "esta"
                 "estaba" "estaban" "estado" "estar" "estas" "este" "esto" "estos" "están" "fueron" "general"
                 "haber" "había" "habían" "hacer" "hacen" "hacia" "hasta" "hecho" "hemos" "luego" "manera" "mayor"
                 "mediante" "mejor" "menor" "menos" "mientras" "misma" "mismas" "mismo" "mismos" "mucha" "muchas"
                 "mucho" "muchos" "nuestra" "nuestras" "nuestro" "nuestros" "nunca" "otra" "otras" "otro" "otros"
                 "parte" "pero" "poco" "poder" "porque" "primer" "primera" "primero" "pueda" "puede" "pueden"
                 "puedan" "pues" "quien" "quienes" "sean" "según" "segundo" "sería" "serían" "será" "serán"
                 "siempre" "siendo" "sido" "sino" "sobre" "solo" "sólo" "también" "tanto" "tanta" "tantas" "tantos"
                 "tener" "tiene" "tienen" "toda" "todas" "todo" "todos" "través" "usted" "varias" "varios" "vez"
                 "veces" "forma" "formas" "tipo" "tipos" "caso" "casos" "modo" "lugar" "último" "última"))
      (puthash w t table))
    table)
  "Function words and very common words never flagged as repeated.")

(defun research-prose--fold (word)
  "WORD in lower case without accents (ñ is kept)."
  (concat (mapcar (lambda (c) (pcase c (?á ?a) (?é ?e) (?í ?i) (?ó ?o) ((or ?ú ?ü) ?u) (_ c))) (downcase word))))

(defconst research-prose--suffixes
  (sort (copy-sequence
         '("amientos" "imientos" "amiento" "imiento" "aciones" "iciones" "uciones" "acion" "icion" "ucion" "ciones"
           "cion" "idades" "idad" "mente" "ismos" "ismo" "istas" "ista" "ables" "ibles" "able" "ible" "ancias"
           "encias" "ancia" "encia" "adoras" "adores" "adora" "ador" "ivas" "ivos" "iva" "ivo" "osas" "osos" "osa"
           "oso" "aron" "ieron" "amos" "emos" "imos" "ando" "iendo" "ados" "adas" "idos" "idas" "ado" "ada" "ido"
           "ida" "ar" "er" "ir" "an" "en" "es" "as" "os" "s" "a" "o" "e"))
        (lambda (a b) (> (length a) (length b))))
  "Spanish endings stripped by `research-prose--stem', longest first.")

(defun research-prose--stem (word)
  "A crude Spanish stem of WORD: folded, one ending stripped (stem of 4+)."
  (let ((w (research-prose--fold word)))
    (or (cl-loop for suffix in research-prose--suffixes
                 when (and (string-suffix-p suffix w) (>= (- (length w) (length suffix)) 4))
                 return (substring w 0 (- (length w) (length suffix))))
        w)))

(defconst research-prose--word-regexp "[[:alpha:]]+"
  "A word: a run of letters.")

(defun research-prose--words (text &optional from to)
  "The words of TEXT between FROM and TO, as (START END WORD)."
  (let ((pos (or from 0)) (to (or to (length text))) out)
    (while (and (< pos to) (string-match research-prose--word-regexp text pos) (< (match-beginning 0) to))
      (push (list (match-beginning 0) (min (match-end 0) to) (match-string 0 text)) out)
      (setq pos (match-end 0)))
    (nreverse out)))

;;;; Syllables and readability

(defun research-prose--strong-p (c) (memq c '(?a ?e ?o ?á ?é ?ó ?í ?ú)))
(defun research-prose--vowel-p (c) (memq c '(?a ?e ?i ?o ?u ?á ?é ?í ?ó ?ú ?ü)))

(defun research-prose-syllables (word)
  "How many syllables the Spanish WORD has (vowel nuclei, with hiatus).
Two strong vowels (a, e, o) in a row, or an accented í or ú next to
another vowel, are in different syllables; the u of que, qui, gue and gui
is silent; a final y after a vowel joins it.  At least 1."
  (let* ((w (downcase word))
         (w (replace-regexp-in-string "\\([qg]\\)u\\([eéií]\\)" "\\1\\2" w))
         (n 0) (prev nil))
    (dotimes (i (length w))
      (let* ((c (aref w i))
             (c (if (and (eq c ?y) (= i (1- (length w))) (> i 0) (research-prose--vowel-p (aref w (1- i)))) ?i c)))
        (if (research-prose--vowel-p c)
            (progn
              ;; í and ú count as strong: next to any vowel they make a hiatus (ma-íz, rí-o).
              (when (or (null prev) (and (research-prose--strong-p prev) (research-prose--strong-p c)))
                (cl-incf n))
              (setq prev c))
          (setq prev nil))))
    (max 1 (if (string= w "y") 1 n))))

(defun research-prose-inflesz (words syllables sentences)
  "The INFLESZ (Szigriszt-Pazos) score of WORDS, SYLLABLES and SENTENCES."
  (- 206.835 (* 62.3 (/ (float syllables) words)) (/ (float words) (max 1 sentences))))

(defun research-prose--inflesz-label (score)
  "The INFLESZ scale's words for SCORE."
  (cond ((< score 40) "muy difícil") ((< score 55) "algo difícil") ((< score 65) "normal")
        ((< score 80) "bastante fácil") (t "muy fácil")))

;;;; What is prose

(defun research-prose--blank-spans (text spans)
  "TEXT with each of SPANS ((FROM . TO) ...) replaced by spaces, keeping newlines.
A new string of the same length (an `aset' could not put an ASCII space
where a multibyte character was)."
  (if (null spans)
      text
    (let ((pos 0) pieces)
      (dolist (span (sort spans (lambda (a b) (< (car a) (car b)))))
        (let ((from (max pos (car span))) (to (cdr span)))
          (when (< from to)
            (push (substring text pos from) pieces)
            (push (replace-regexp-in-string "[^\n]" " " (substring text from to) t t) pieces)
            (setq pos to))))
      (push (substring text pos) pieces)
      (apply #'concat (nreverse pieces)))))

(defun research-prose--blank-matches (text regexp &optional keep only)
  "TEXT with every match of REGEXP blanked.
With KEEP, all of the match but its group KEEP; with ONLY, only its group
ONLY."
  (let ((pos 0) spans)
    (while (string-match regexp text pos)
      (let ((b (match-beginning 0)) (e (match-end 0)))
        (cond ((and keep (match-beginning keep))
               (push (cons b (match-beginning keep)) spans)
               (push (cons (match-end keep) e) spans))
              (only (push (cons (match-beginning only) (match-end only)) spans)
                    (setq e (match-end only)))
              (t (push (cons b e) spans)))
        (setq pos (max e (1+ b)))))
    (research-prose--blank-spans text spans)))

(defconst research-prose--argument-commands
  "\\\\\\(?:[a-zA-Z]*cite[a-zA-Z]*\\|[Gg]ls[a-zA-Z]*\\|acr[a-zA-Z]*\\|[a-zA-Z]*ref\\|label\\|url\\|href\\|input\\|include\\|includegraphics\\|footnotemark\\|index\\|glossary\\)\\*?\\(?:\\[[^]]*\\]\\)*{[^}]*}"
  "LaTeX commands whose argument is not prose (a key, a label, a path).")

(defun research-prose-mask (text)
  "A copy of TEXT where what is not prose is blanked (same length).
Citations, link targets, footnote labels, macros, inline source, verbatim
and code, math, LaTeX commands (with their argument when it is a key or a
label) and leftover braces become spaces; a link's description stays."
  (let ((s text))
    (setq s (research-prose--blank-matches s "\\[cite[^]:]*:[^]]*\\]"))
    (setq s (research-prose--blank-matches s "\\[\\[[^]\n]*\\]\\[\\([^]]*\\)\\]\\]" 1))
    (setq s (research-prose--blank-matches s "\\[\\[[^]\n]*\\]\\]"))
    (setq s (research-prose--blank-matches s "\\[fn:[^]:\n]*\\]"))
    (setq s (research-prose--blank-matches s "\\[fn:[^]:\n]*:"))
    (setq s (research-prose--blank-matches s "{{{[^}]*}}}"))
    (setq s (research-prose--blank-matches s "\\(?:src\\|call\\)_[a-zA-Z0-9-]+\\(?:\\[[^]\n]*\\]\\)?{[^}\n]*}"))
    (setq s (research-prose--blank-matches s "\\(?:^\\|[^[:alnum:]]\\)\\(\\([=~]\\)[^ \t\n=~]\\(?:[^\n]*?[^ \t\n]\\)??\\2\\)\\(?:[^[:alnum:]]\\|$\\)" nil 1))
    (setq s (research-prose--blank-matches s "\\\\(\\(?:.\\|\n\\)*?\\\\)"))
    (setq s (research-prose--blank-matches s "\\\\\\[\\(?:.\\|\n\\)*?\\\\\\]"))
    (setq s (research-prose--blank-matches s "\\$\\$\\(?:.\\|\n\\)*?\\$\\$"))
    (setq s (research-prose--blank-matches s "\\$[^ \t\n$]\\(?:[^$\n]*?[^ \t\n$]\\)?\\$"))
    (setq s (research-prose--blank-matches s research-prose--argument-commands))
    (setq s (research-prose--blank-matches s "\\\\[a-zA-Z]+\\*?\\(?:\\[[^]\n]*\\]\\)?"))
    (setq s (research-prose--blank-matches s "\\\\[^a-zA-Z \t\n]"))
    (setq s (research-prose--blank-matches s "[{}]"))
    (setq s (research-prose--blank-matches s "^[ \t]*\\(?:[-+]\\|[0-9]+[.)]\\)[ \t]+\\(?:\\[[ X-]\\][ \t]+\\)?"))
    s))

(defun research-prose--paragraphs (beg end)
  "The prose paragraphs between BEG and END, as (START . END) positions.
Lines that are not prose (headings, keywords, drawers, skipped blocks and
environments, tables, comments, display math, lone LaTeX commands) end a
paragraph, as blank lines do; a list item starts a new one."
  (let ((case-fold-search t) out start last block)
    (save-excursion
      (goto-char beg)
      (forward-line 0)
      (while (< (point) end)
        (let* ((bol (point)) (eol (line-end-position))
               (prose nil))
          (cond
           (block
            (when (looking-at block) (setq block nil)))
           ((looking-at "^[ \t]*#\\+begin_\\([a-zA-Z0-9]+\\)")
            (when (member (downcase (match-string 1)) research-prose-skipped-blocks)
              (setq block (concat "^[ \t]*#\\+end_" (regexp-quote (match-string 1)) "\\b"))))
           ((looking-at "^[ \t]*\\\\begin{\\([a-zA-Z*]+\\)}")
            (when (member (match-string 1) research-prose-skipped-environments)
              (let ((close (concat "\\\\end{" (regexp-quote (match-string 1)) "}")))
                (unless (re-search-forward close eol t)
                  (setq block close)))))
           ((looking-at "^[ \t]*:\\([a-zA-Z0-9_-]+\\):[ \t]*$")
            (unless (string-equal (match-string 1) "END") (setq block "^[ \t]*:END:[ \t]*$")))
           ((looking-at "^[ \t]*\\$\\$")
            (unless (string-match-p "\\$\\$.*\\$\\$" (buffer-substring-no-properties bol eol))
              (setq block "^.*\\$\\$")))
           ((looking-at "^[ \t]*\\\\\\[")
            (unless (string-match-p "\\\\\\]" (buffer-substring-no-properties bol eol))
              (setq block "^.*\\\\\\]")))
           ((looking-at (concat "^\\(?:[ \t]*$\\|\\*+[ \t]\\|[ \t]*#\\+\\|[ \t]*#\\([ \t]\\|$\\)\\|[ \t]*|\\|[ \t]*\\+-"
                                "\\|[ \t]*%\\|[ \t]*:\\([ \t]\\|$\\)\\|[ \t]*\\(?:CLOSED\\|DEADLINE\\|SCHEDULED\\):"
                                "\\|[ \t]*\\\\[a-zA-Z]+\\*?\\(?:\\[[^]\n]*\\]\\)?\\(?:{[^}\n]*}\\)*[ \t]*$\\)")))
           (t (setq prose t)))
          (when (and prose start
                     (save-excursion (looking-at "^[ \t]*\\(?:[-+]\\|[0-9]+[.)]\\)[ \t]")))
            (push (cons start last) out)
            (setq start nil))
          (if prose
              (setq start (or start bol) last (min eol end))
            (when start (push (cons start last) out) (setq start nil)))
          (forward-line 1)
          (when (and (= (point) eol) (= eol (point-max))) (goto-char end))))
      (when start (push (cons start last) out)))
    (nreverse out)))

;;;; Sentences

(defconst research-prose--abbreviations
  '("p" "pp" "pág" "págs" "cap" "caps" "fig" "figs" "vol" "vols" "núm" "núms" "no" "ed" "eds" "al" "ej" "cf" "vs"
    "sr" "sra" "dr" "dra" "aprox" "art" "sec" "ec" "tab" "op" "cit" "ibid" "etc" "e.g" "i.e" "a.C" "d.C")
  "Words that end with a period without ending the sentence.")

(defun research-prose-sentences (text)
  "The sentences of TEXT as (START . END), END after the final punctuation.
A sentence ends at . ! ? or … followed by space and an uppercase letter,
a digit, ¿, ¡, « or a quote (or at the end); not after an abbreviation of
`research-prose--abbreviations' or an initial."
  (let ((case-fold-search nil) (pos 0) (start nil) out)
    (while (string-match "[.!?…]+[»\"”’')]*" text pos)
      (let* ((b (match-beginning 0)) (e (match-end 0))
             (after (and (string-match "[ \t\n]+" text e) (= (match-beginning 0) e) (match-end 0)))
             (next (and after (< after (length text)) (aref text after)))
             (before (substring text (max 0 (- b 12)) b))
             (word (and (eq (aref text b) ?.)
                        (string-match "\\([[:alpha:].]+\\)\\'" before)
                        (match-string 1 before)))
             (ends (and (or (= e (length text)) after)
                        (or (null next) (memq next '(?¿ ?¡ ?« ?\" ?“ ?\( ?\[))
                            (and (characterp next) (or (/= (downcase next) next) (<= ?0 next ?9))))
                        (not (and word (or (member (downcase word) research-prose--abbreviations)
                                           (= (length word) 1)))))))
        (when ends
          (let ((s (or start 0)))
            (when (string-match "[^ \t\n]" text s)
              (when (< (match-beginning 0) e) (push (cons (match-beginning 0) e) out))))
          (setq start e))
        (setq pos (max e (1+ b)))))
    (let ((s (or start 0)))
      (when (string-match "[^ \t\n]" text s)
        (let ((b (match-beginning 0)) (e (length text)))
          (while (and (> e b) (memq (aref text (1- e)) '(?\s ?\t ?\n))) (cl-decf e))
          (push (cons b e) out))))
    (nreverse out)))

;;;; Checks

(defvar research-prose--diags nil "Diagnostics being collected: (BEG END TYPE TEXT CHECK).")

(defun research-prose--add (beg end type check text)
  "Collect a diagnostic BEG..END of TYPE from CHECK with TEXT."
  (push (list beg end type text check) research-prose--diags))

(defun research-prose--long-sentences (text base sentences)
  "Flag SENTENCES of TEXT (at BASE) longer than the maximum."
  (dolist (s sentences)
    (let ((n (length (research-prose--words text (car s) (cdr s)))))
      (when (> n research-prose-max-sentence-words)
        (research-prose--add (+ base (car s)) (+ base (cdr s)) :warning 'long-sentence
                             (format "Oración larga (%d palabras; máximo %d): el lector tiene que sostener demasiadas ideas a la vez. ¿Dónde cambia el sujeto o la idea? Ahí puede haber un punto."
                                     n research-prose-max-sentence-words))))))

(defun research-prose--term-words ()
  "Folded words of the term groups, never flagged as repeated."
  (let ((table (make-hash-table :test #'equal)))
    (dolist (group (research-prose--term-groups))
      (dolist (term group)
        (dolist (w (split-string term))
          (puthash (research-prose--fold w) t table))))
    table))

(defun research-prose--repetition (text base terms)
  "Flag content words of TEXT (at BASE) repeated within the window.
TERMS (a hash of folded words) are never flagged: a term is repeated on
purpose."
  (let ((seen (make-hash-table :test #'equal)) (index 0))
    (dolist (w (research-prose--words text))
      (let* ((word (nth 2 w)) (folded (research-prose--fold word)))
        (when (and (>= (length word) research-prose-repetition-min-length)
                   (not (gethash (downcase word) research-prose--stopwords))
                   (not (gethash folded research-prose--stopwords))
                   (not (gethash folded terms))
                   (not (let ((case-fold-search nil)) (string-match-p "\\`[[:upper:]]+\\'" word))))
          (let* ((stem (research-prose--stem word))
                 (last (gethash stem seen)))
            (when (and last (<= (- index (car last)) research-prose-repetition-window))
              (research-prose--add (+ base (nth 0 w)) (+ base (nth 1 w)) :note 'repetition
                                   (format "Repetición: «%s» repite «%s» de %d palabras antes. Cerca se nota y empobrece el ritmo; ¿hay un sinónimo exacto o puedes reordenar? Si es un término técnico, mantenlo."
                                           word (cdr last) (- index (car last)))))
            (puthash stem (cons index word) seen))))
      (cl-incf index))))

(defcustom research-prose-filler-phrases
  '(("cabe \\(?:mencionar\\|señalar\\|destacar\\|resaltar\\|recalcar\\|notar\\|decir\\)"
     . "Fórmula de relleno: anuncia que vas a decir algo en vez de decirlo. Si es importante, el contenido lo demuestra; ¿qué pasa si empiezas por la afirmación?")
    ("es \\(?:importante\\|necesario\\|preciso\\|conveniente\\|relevante\\) \\(?:señalar\\|mencionar\\|destacar\\|resaltar\\|notar\\|recalcar\\|aclarar\\|subrayar\\)"
     . "Fórmula de relleno: anuncia la importancia en lugar de mostrarla. ¿Puedes empezar directamente por lo que quieres señalar?")
    ("vale la pena \\(?:mencionar\\|señalar\\|destacar\\|resaltar\\|notar\\)"
     . "Fórmula de relleno: si vale la pena, dilo sin anunciarlo.")
    ("en \\(?:este\\|ese\\|tal\\) sentido"
     . "Conector comodín: no dice qué relación tiene con lo anterior (causa, consecuencia, contraste, ejemplo). ¿Cuál es exactamente?")
    ("a nivel \\(?:de\\|del\\)"
     . "«A nivel de» solo es propio con niveles reales (a nivel del mar). Aquí suele ser una muletilla: ¿quieres decir «en», «entre» o «en cuanto a»?")
    ("en base a"
     . "«En base a» es una construcción que la norma desaconseja; las recomendadas son «con base en», «a partir de» o «según».")
    ("de cara a"
     . "«De cara a» con sentido de finalidad es coloquial en un texto académico. ¿Expresa finalidad o perspectiva?")
    ("\\(?:hoy en día\\|hoy día\\|a día de hoy\\|en la actualidad\\)"
     . "Marca temporal vaga: en una tesis envejece mal y no dice desde cuándo ni según quién. ¿Puedes dar una fecha o una referencia?")
    ("\\(?:de\\|del\\|en\\|al\\|con\\|por\\|para\\|sobre\\|entre\\) \\(?:\\(?:el\\|la\\|los\\|las\\) \\)?mism[oa]s?\\(?:[[:blank:]\n]*[.,;:)]\\|[[:blank:]\n]*\\'\\)"
     . "«El mismo / la misma» como pronombre es un uso que la RAE desaconseja y suena burocrático. ¿Puedes nombrar el referente o usar un posesivo o un pronombre?")
    ("\\(?:el\\|la\\|los\\|las\\) mism[oa]s? \\(?:es\\|son\\|fue\\|fueron\\|se\\|ha\\|han\\|tiene\\|tienen\\|permite\\|permiten\\|presenta\\|presentan\\|consiste\\|cuenta\\|cuentan\\|incluye\\|incluyen\\)\\>"
     . "«El mismo / la misma» como sujeto pronominal es un uso que la RAE desaconseja. ¿Puedes nombrar el referente?")
    ("es por \\(?:ello\\|esto\\|eso\\|lo anterior\\) que"
     . "«Es por eso que» es un calco del francés; en registro académico se prefiere «por ello» o «por eso», sin «es… que».")
    ("a la hora de"
     . "Muletilla sin valor temporal: ¿significa «al», «para» o «cuando»?")
    ("en lo que \\(?:respecta\\|se refiere\\|concierne\\|corresponde\\) a"
     . "Rodeo que alarga la frase sin añadir sentido. ¿Puede el tema ser el sujeto de la oración?")
    ("el hecho de que"
     . "Suele sobrar: «el hecho de que X demuestra» dice lo mismo que «que X demuestra». ¿Lo necesitas?")
    ("\\(?:juega\\|juegan\\|jugar\\|jugó\\|jugaron\\|jugaba\\|jugaban\\) un \\(?:papel\\|rol\\)"
     . "Calco del inglés «play a role». En español se desempeña o se cumple un papel, o se dice directamente qué hace.")
    ("de acuerdo a"
     . "La norma prefiere «de acuerdo con».")
    ("bajo \\(?:el\\|este\\|ese\\|mi\\|nuestro\\) punto de vista"
     . "Un punto de vista se adopta «desde», no «bajo».")
    ("en orden a"
     . "«En orden a» con valor de finalidad es un anglicismo («in order to»); la finalidad se expresa con «para».")
    ("\\(?:llevar\\|lleva\\|llevan\\|llevó\\|llevaron\\|llevamos\\|llevará\\|llevarán\\|llevado\\|llevando\\) a cabo"
     . "Verbo vacío: «llevar a cabo un análisis» esconde la acción en un sustantivo. ¿Cuál es el verbo de la acción?")
    ("\\(?:realizar\\|realiza\\|realizan\\|realizó\\|realizaron\\|realizamos\\|realizará\\|realizado\\|realizada\\|realizando\\) \\(?:un\\|una\\|el\\|la\\|los\\|las\\|unos\\|unas\\)\\>"
     . "«Realizar» es un verbo comodín: suele esconder la acción en el sustantivo que le sigue. ¿Cuál es el verbo preciso?")
    ("y/o"
     . "«y/o» sobra: en español «o» ya admite que se den ambas opciones.")
    ("así como también"
     . "Redundante: «así como» ya suma; «también» repite la idea.")
    ("más sin embargo"
     . "Redundante: «mas» y «sin embargo» son ambos adversativos; basta uno.")
    ("\\(?:previa\\|anterior\\)mente \\(?:mencionad\\|citad\\|descrit\\|señalad\\)[oa]s?"
     . "Remite al lector hacia atrás sin decirle dónde. ¿Puedes nombrar otra vez lo que mencionas o indicar la sección?"))
  "Filler and frowned-upon phrases: (REGEXP . WHY).
REGEXP is matched case-insensitively, at word boundaries; a space in it
stands for any run of spaces and newlines.  WHY says, in Spanish, why the
phrase reads badly."
  :type '(alist :key-type regexp :value-type string))

(defun research-prose--phrase-regexp (regexp)
  "REGEXP at word boundaries, each space allowing any whitespace."
  (concat "\\<" (replace-regexp-in-string " " "[ \t\n]+" regexp t t)))

(defun research-prose--filler (text base)
  "Flag the filler phrases of TEXT (at BASE)."
  (let ((case-fold-search t))
    (dolist (entry research-prose-filler-phrases)
      (let ((re (research-prose--phrase-regexp (car entry))) (pos 0))
        (while (string-match re text pos)
          (let ((b (match-beginning 0)) (e (match-end 0)))
            (while (and (> e b) (memq (aref text (1- e)) '(?\s ?\t ?\n ?. ?, ?\; ?: ?\)))) (cl-decf e))
            (research-prose--add (+ base b) (+ base e) :warning 'filler
                                 (format "Muletilla: «%s». %s" (replace-regexp-in-string "[ \t\n]+" " " (substring text b e)) (cdr entry)))
            (setq pos (max (match-end 0) (1+ b)))))))))

(defconst research-prose--not-gerunds
  '("cuando" "mando" "comando" "comandos" "blando" "bando" "contrabando" "nefando" "remiendo" "estupendo" "segundo")
  "Words ending like a gerund that are not one.")

(defun research-prose--gerunds (text base sentences)
  "Flag the gerunds of each of SENTENCES of TEXT (at BASE) beyond the maximum."
  (let ((case-fold-search t))
    (dolist (s sentences)
      (let ((n 0))
        (dolist (w (research-prose--words text (car s) (cdr s)))
          (let ((word (downcase (nth 2 w))))
            (when (and (string-match-p "\\(?:[aá]ndo\\|i[eé]ndo\\|y[eé]ndo\\)\\(?:l[oa]s?\\|les?\\|se\\|me\\|te\\|nos\\)?\\'" word)
                       (> (length word) 5)
                       (not (member word research-prose--not-gerunds)))
              (cl-incf n)
              (when (> n research-prose-max-gerunds)
                (research-prose--add (+ base (nth 0 w)) (+ base (nth 1 w)) :note 'gerund
                                     (format "Gerundio n.º %d en la oración («%s»): encadenar gerundios difumina quién hace qué y en qué orden. ¿Puede alguno ser un verbo conjugado o una oración aparte?"
                                             n (nth 2 w)))))))))))

(defcustom research-prose-not-mente-adverbs
  '("mente" "demente" "clemente" "inclemente" "vehemente" "implemente" "complemente" "incremente" "documente"
    "experimente" "fomente" "aumente" "lamente" "alimente" "argumente" "comente" "segmente" "fragmente"
    "suplemente" "cimente" "atormente" "orimente" "sedimente" "reglamente")
  "Words ending in -mente that are not adverbs (mostly subjunctive verbs)."
  :type '(repeat string))

(defun research-prose--adverbs (text base sentences)
  "Flag each of SENTENCES of TEXT (at BASE) with too many -mente adverbs."
  (dolist (s sentences)
    (let ((n 0))
      (dolist (w (research-prose--words text (car s) (cdr s)))
        (let ((word (downcase (nth 2 w))))
          (when (and (string-suffix-p "mente" word) (> (length word) 6)
                     (not (member word research-prose-not-mente-adverbs)))
            (cl-incf n)
            (when (> n research-prose-max-mente-adverbs)
              (research-prose--add (+ base (nth 0 w)) (+ base (nth 1 w)) :note 'adverb
                                   (format "Adverbio en -mente n.º %d en la oración («%s»): varios pesan y suenan monótonos. ¿Alguno sobra o dice algo que el verbo ya dice?"
                                           n (nth 2 w))))))))))

(defconst research-prose--passive-regexp
  (concat "\\<\\(?:es\\|son\\|fue\\|fueron\\|era\\|eran\\|será\\|serán\\|sería\\|serían\\|sea\\|sean"
          "\\|fuera\\|fueran\\|fuese\\|fuesen\\|ser\\|sido\\|siendo\\)[ \t\n]+"
          "\\(?:[[:alpha:]]+mente[ \t\n]+\\)?"
          "\\([[:alpha:]]+\\(?:ad\\|id\\|íd\\)[oa]s?"
          "\\|\\(?:[[:alpha:]]*\\(?:escrit\\|hech\\|puest\\|vist\\|abiert\\|resuelt\\|dich\\|cubiert\\|devuelt\\|impres\\|frit\\|rot\\|provist\\)\\)[oa]s?\\)\\>")
  "Ser + an optional -mente adverb + a participle (group 1).")

(defcustom research-prose-not-participles
  '("adecuado" "apropiado" "complicado" "delicado" "privado" "pesado" "sagrado" "moderado" "avanzado" "adelantado"
    "demasiado" "cuidado" "estado" "lado" "nado" "todo" "nido" "ruido" "sentido" "partido" "contenido" "vestido"
    "marido" "olvido" "sonido" "apellido" "pedido" "medido" "unido" "dado" "grado" "mercado" "resultado" "pasado"
    "agrado" "honrado" "malvado" "helado")
  "Words that look like a participle after «ser» but are usually not passive."
  :type '(repeat string))

(defun research-prose--passive (text base)
  "Flag the periphrastic passives of TEXT (at BASE)."
  (let ((case-fold-search t) (pos 0))
    (while (string-match research-prose--passive-regexp text pos)
      (let* ((b (match-beginning 0)) (e (match-end 0))
             (participle (downcase (match-string 1 text)))
             (singular (replace-regexp-in-string "\\([oa]\\)s?\\'" "o" participle)))
        ;; A participle carries no accent but on -ído (leído): «es válido», «es rápido» are adjectives.
        (unless (or (member singular research-prose-not-participles)
                    (member participle research-prose-not-participles)
                    (string-match-p "[áéóú]" participle)
                    (and (string-match-p "í" participle) (not (string-match-p "íd[oa]s?\\'" participle))))
          (research-prose--add (+ base b) (+ base e) :note 'passive
                               (format "Pasiva perifrástica («%s»): oculta quién actúa y alarga la frase. En español académico suele leerse mejor la activa o la pasiva refleja con «se». ¿Quién realiza la acción, y importa decirlo?"
                                       (replace-regexp-in-string "[ \t\n]+" " " (substring text b e)))))
        (setq pos (max e (1+ b)))))))

(defun research-prose--readability (text base sentences)
  "Note the paragraph TEXT (at BASE) when its INFLESZ is below the threshold."
  (let* ((words (research-prose--words text))
         (n (length words)))
    (when (and (>= n research-prose-readability-min-words) sentences)
      (let* ((syllables (apply #'+ (mapcar (lambda (w) (research-prose-syllables (nth 2 w))) words)))
             (score (research-prose-inflesz n syllables (length sentences))))
        (when (< score research-prose-readability-threshold)
          (let* ((first (car sentences))
                 (line-end (or (string-search "\n" text (car first)) (length text))))
            (research-prose--add (+ base (car first)) (+ base (min (cdr first) line-end)) :note 'readability
                                 (format "Legibilidad INFLESZ %.0f (%s; %.1f sílabas por palabra, %.0f palabras por oración): no es un error, la prosa académica suele quedar entre 40 y 55. ¿Cuál es la idea central del párrafo y puede llegar antes?"
                                         score (research-prose--inflesz-label score) (/ (float syllables) n) (/ (float n) (length sentences))))))))))

;;;; Terms

(defun research-prose--term-groups ()
  "`research-prose-term-groups' and the buffer's `#+PROSE_TERMS:' groups."
  (append research-prose-term-groups
          (save-excursion
            (save-restriction
              (widen)
              (goto-char (point-min))
              (let ((case-fold-search t) out)
                (while (re-search-forward "^[ \t]*#\\+PROSE_TERMS:[ \t]*\\(.*\\)$" nil t)
                  (let ((group (cl-remove-if #'string-empty-p (mapcar #'string-trim (split-string (match-string-no-properties 1) "|")))))
                    (when (cdr group) (push group out))))
                (nreverse out))))))

(defun research-prose--plural (word)
  "The Spanish plural of WORD.
-s after a vowel, -es after a consonant, losing the accent of a final
stressed syllable (anonimización, anonimizaciones)."
  (cond ((string-match "\\([áéíóú]\\)\\([nsl]\\)\\'" word)
         (concat (substring word 0 (match-beginning 1)) (research-prose--fold (match-string 1 word)) (match-string 2 word) "es"))
        ((string-match-p "[aeiouáéíóú]\\'" word) (concat word "s"))
        (t (concat word "es"))))

(defun research-prose--term-regexp (term)
  "TERM or its plural, any case, its words separated by any whitespace."
  (let* ((words (split-string term))
         (plural (append (butlast words) (list (research-prose--plural (car (last words)))))))
    (concat "\\<\\(?:" (mapconcat #'regexp-quote plural "[ \t\n]+")
            "\\|" (mapconcat #'regexp-quote words "[ \t\n]+") "\\)\\>")))

(defun research-prose--terms (paragraphs)
  "Flag the minority terms of each group across PARAGRAPHS ((START TEXT) ...)."
  (let ((case-fold-search t))
    (dolist (group (research-prose--term-groups))
      (let* ((hits (mapcar (lambda (term)
                             (let ((re (research-prose--term-regexp term)) out)
                               (dolist (p paragraphs)
                                 (let ((pos 0) (text (cadr p)))
                                   (while (string-match re text pos)
                                     (push (cons (+ (car p) (match-beginning 0)) (+ (car p) (match-end 0))) out)
                                     (setq pos (match-end 0)))))
                               (cons term (nreverse out))))
                           group))
             (used (cl-remove-if-not #'cdr hits)))
        (when (cdr used)
          (let* ((preferred (car (cl-reduce (lambda (a b) (if (> (length (cdr b)) (length (cdr a))) b a)) used)))
                 (counts (mapconcat (lambda (h) (format "«%s» %d" (car h) (length (cdr h))))
                                 (cl-sort (copy-sequence used) #'> :key (lambda (h) (length (cdr h)))) ", ")))
            (dolist (h used)
              (unless (equal (car h) preferred)
                (dolist (span (cdr h))
                  (research-prose--add (car span) (cdr span) :warning 'terms
                                       (format "Término: aquí «%s», pero el texto usa sobre todo «%s» (%s). Si nombran el mismo concepto, elige uno: alternar términos hace pensar al lector que son cosas distintas."
                                               (car h) preferred counts)))))))))))

;;;; Acronyms

(defvar research-prose--acronym-cache nil
  "Read acronym files: (FILE MTIME . TABLE).
TABLE maps each key to its short form.")

(defun research-prose--acronym-file ()
  "The thesis' acronym file above the buffer's directory, or nil."
  (let ((dir (or (and buffer-file-name (file-name-directory buffer-file-name)) default-directory)))
    (cl-loop for name in research-prose-acronym-files
             for found = (and dir (locate-dominating-file dir name))
             when found return (expand-file-name name found))))

(defun research-prose-read-acronyms (file)
  "The acronyms FILE defines: a hash from each KEY to its SHORT form.
Reads `\\newacronym[...]{KEY}{SHORT}{LONG}' (and, as a defined key only,
`\\newglossaryentry{KEY}'), ignoring commented lines.  Cached by mtime."
  (let ((mtime (file-attribute-modification-time (file-attributes file)))
        (cached (assoc file research-prose--acronym-cache)))
    (if (and cached (equal (cadr cached) mtime))
        (cddr cached)
      (let ((table (make-hash-table :test #'equal)))
        (with-temp-buffer
          (insert-file-contents file)
          (goto-char (point-min))
          (while (re-search-forward "^\\([^%\n]*?\\)\\\\\\(newacronym\\|newglossaryentry\\)\\(?:\\[[^]]*\\]\\)?{\\([^}]+\\)}\\(?:{\\([^}]*\\)}\\)?" nil t)
            (puthash (string-trim (match-string 3))
                     (if (equal (match-string 2) "newacronym") (string-trim (or (match-string 4) "")) "")
                     table)))
        (setq research-prose--acronym-cache
              (cons (cons file (cons mtime table)) (assoc-delete-all file research-prose--acronym-cache)))
        table))))

(defun research-prose--acronyms (paragraphs)
  "Flag bare defined acronyms and `\\gls' of undefined keys in PARAGRAPHS.
Each paragraph is (START TEXT RAW): RAW is the buffer text, TEXT masked."
  (when-let* ((file (research-prose--acronym-file)))
    (let* ((table (research-prose-read-acronyms file))
           (name (file-name-nondirectory file))
           (shorts (make-hash-table :test #'equal))
           (case-fold-search nil))
      (maphash (lambda (key short)
                 (unless (string-empty-p short) (puthash short key shorts))
                 (when (string-match-p "[[:upper:]]" key) (puthash key key shorts))
                 (puthash (upcase key) key shorts))
               table)
      (dolist (p paragraphs)
        (let ((base (nth 0 p)) (text (nth 1 p)) (raw (nth 2 p)) (pos 0))
          (while (string-match "\\<[[:upper:]][[:upper:][:digit:]]+s?\\>" text pos)
            (let* ((token (match-string 0 text))
                   (key (or (gethash token shorts)
                            (and (string-suffix-p "s" token) (gethash (substring token 0 -1) shorts)))))
              (when key
                (research-prose--add (+ base (match-beginning 0)) (+ base (match-end 0)) :warning 'acronyms
                                     (format "Acrónimo «%s» sin \\gls: está definido en %s. Escríbelo \\gls{%s} (\\glspl{%s} en plural) para que el glosario lo desarrolle la primera vez y lo enlace."
                                             token name key key)))
              (setq pos (match-end 0))))
          (setq pos 0)
          (while (string-match "\\\\\\(?:[Gg]ls[a-zA-Z]*\\|acr[a-zA-Z]*\\)\\*?\\(?:\\[[^]]*\\]\\)?{\\([^}]+\\)}" raw pos)
            (let ((key (string-trim (match-string 1 raw))))
              (unless (gethash key table)
                (research-prose--add (+ base (match-beginning 0)) (+ base (match-end 0)) :error 'acronyms
                                     (format "\\gls{%s} no está definido en %s: la compilación lo mostrará como un error. ¿Falta el \\newacronym o la clave es otra?"
                                             key name))))
            (setq pos (match-end 0))))))))

;;;; Running the checks

(defvar research-prose--syntax-table
  (let ((table (make-syntax-table text-mode-syntax-table)))
    (modify-syntax-entry ?' "." table)
    (modify-syntax-entry ?_ "." table)
    table)
  "Syntax table for the word boundaries of the checks.")

(defun research-prose-diagnostics (&optional beg end)
  "The prose diagnostics between BEG and END (the buffer by default).
A list of (BEG END TYPE TEXT CHECK), in buffer order."
  (let* ((beg (or beg (point-min)))
         (end (or end (point-max)))
         (research-prose--diags nil)
         (checks research-prose-checks)
         (paragraphs
          (with-syntax-table research-prose--syntax-table
            (mapcar (lambda (p)
                      (let ((raw (buffer-substring-no-properties (car p) (cdr p))))
                        (list (car p) (research-prose-mask raw) raw)))
                    (research-prose--paragraphs beg end))))
         (terms (and (memq 'repetition checks) (research-prose--term-words))))
    (with-syntax-table research-prose--syntax-table
      (dolist (p paragraphs)
        (let* ((base (nth 0 p)) (text (nth 1 p))
               (sentences (research-prose-sentences text)))
          (when (memq 'long-sentence checks) (research-prose--long-sentences text base sentences))
          (when (memq 'repetition checks) (research-prose--repetition text base terms))
          (when (memq 'filler checks) (research-prose--filler text base))
          (when (memq 'gerund checks) (research-prose--gerunds text base sentences))
          (when (memq 'adverb checks) (research-prose--adverbs text base sentences))
          (when (memq 'passive checks) (research-prose--passive text base))
          (when (memq 'readability checks) (research-prose--readability text base sentences))))
      (when (memq 'terms checks) (research-prose--terms paragraphs))
      (when (memq 'acronyms checks) (research-prose--acronyms paragraphs)))
    (sort research-prose--diags (lambda (a b) (or (< (car a) (car b)) (and (= (car a) (car b)) (< (cadr a) (cadr b))))))))

(defvar-local research-prose--scope nil
  "What `research-prose-flymake' checks.
nil for the buffer, or (BEG-MARKER . END-MARKER).")

(defun research-prose-flymake (report-fn &rest _)
  "Flymake backend: report the prose diagnostics to REPORT-FN.
Those of the buffer, or of the region `research-prose-check' checked."
  (let* ((scope research-prose--scope)
         (beg (if scope (marker-position (car scope)) (point-min)))
         (end (if scope (marker-position (cdr scope)) (point-max))))
    (funcall report-fn
             (cl-loop for (b e type text) in (research-prose-diagnostics beg end)
                      when (< b e)
                      collect (flymake-make-diagnostic (current-buffer) b e type text)))))

(defvar research-prose-mode)

(defun research-prose--summary (diagnostics)
  "A one-line count of DIAGNOSTICS per check."
  (if (null diagnostics)
      "Prosa: sin observaciones"
    (let (counts)
      (dolist (d diagnostics) (cl-incf (alist-get (nth 4 d) counts 0)))
      (concat (format "Prosa: %d observaciones (" (length diagnostics))
              (mapconcat (lambda (c) (format "%s %d" (car c) (cdr c)))
                         (cl-sort counts #'> :key #'cdr) ", ")
              ")"))))

;;;###autoload
(defun research-prose-check (&optional beg end)
  "Check the prose of the region (BEG..END) or the buffer, as Flymake diagnostics.
Long sentences, repetitions, filler phrases, gerunds, -mente adverbs,
periphrastic passive, readability, term consistency and acronyms; each
diagnostic says why the passage may read badly, without rewriting it.
Returns the diagnostics (BEG END TYPE TEXT CHECK)."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (let ((diagnostics (research-prose-diagnostics beg end)))
    (setq research-prose--scope (and beg end (not research-prose-mode) (cons (copy-marker beg) (copy-marker end t))))
    (when (require 'flymake nil t)
      (add-hook 'flymake-diagnostic-functions #'research-prose-flymake nil t)
      (if flymake-mode (flymake-start) (flymake-mode 1)))
    (message "%s" (research-prose--summary diagnostics))
    diagnostics))

;;;###autoload
(define-minor-mode research-prose-mode
  "Check Spanish academic prose with Flymake while you write.
See `research-prose-check' for the checks and `research-prose-checks' to
turn some off."
  :lighter " Prosa"
  (if research-prose-mode
      (progn
        (setq research-prose--scope nil)
        (when (require 'flymake nil t)
          (add-hook 'flymake-diagnostic-functions #'research-prose-flymake nil t)
          (if flymake-mode (flymake-start) (flymake-mode 1))))
    (remove-hook 'flymake-diagnostic-functions #'research-prose-flymake t)
    (when (and (bound-and-true-p flymake-mode) (fboundp 'flymake-start)) (flymake-start))))

;;;###autoload
(defun research-prose-thesis-file-p ()
  "Whether the buffer visits a thesis file.
A file under `research-prose-thesis-directories', or, when that is nil,
one with an acronym file of `research-prose-acronym-files' above it."
  (and buffer-file-name
       (if research-prose-thesis-directories
           (cl-some (lambda (dir) (file-in-directory-p buffer-file-name dir)) research-prose-thesis-directories)
         (and (research-prose--acronym-file) t))))

;;;###autoload
(defun research-prose-maybe-enable ()
  "Turn on `research-prose-mode' in a thesis file (for `org-mode-hook')."
  (when (research-prose-thesis-file-p) (research-prose-mode 1)))

(provide 'research-prose)
;;; research-prose.el ends here
