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
;;   `\gls{KEY}', and `\gls{KEY}' of an undefined acronym;
;; - uppercase words that look like an acronym but are not defined there.
;;
;; Org markup and what is not prose are ignored: headings, keywords, drawers,
;; src/example/export/comment/quote blocks, tables (but for the acronym
;; checks, since a table exports to LaTeX too), comment lines, LaTeX
;; commands, environments and math, citations `[cite:…]', link targets,
;; macros, verbatim and code.
;;
;; `research-prose-check' checks the buffer (or the region) once;
;; `research-prose-mode' keeps the checks on while you write.
;;
;; Acronyms are the only thing it ever writes, and only on request:
;; `research-prose-gls-at-point' turns the bare acronym at point into
;; `\gls{KEY}', `research-prose-gls-fix' walks them all like `query-replace',
;; `research-prose-auto-gls-mode' converts one as you finish typing it, and
;; `research-prose-add-acronym' adds an undefined one to `acronimos.tex'.

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
  '(long-sentence repetition filler gerund adverb passive readability terms acronyms new-acronyms)
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
              (const :tag "Acrónimos y \\gls" acronyms)
              (const :tag "Siglas sin definir en acronimos.tex" new-acronyms)))

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

(defcustom research-prose-acronym-ignore '("OK" "TODO" "DONE" "NB" "PS" "FAQ")
  "Uppercase words never noted as undefined acronyms (check `new-acronyms').
Roman numerals (II to XXXIX) are never noted either."
  :type '(repeat string))

(defcustom research-prose-gls-capitalize t
  "Whether a converted acronym that starts a sentence becomes `\\Gls'.
When non-nil, `research-prose-gls-at-point', `research-prose-gls-fix' and
`research-prose-auto-gls-mode' write `\\Gls{KEY}' (`\\Glspl{KEY}') for an
acronym at the start of a sentence, a paragraph, a list item or a table
cell: the first use of an acronym is expanded to its long form, which
must then start with a capital.  When nil, always `\\gls'."
  :type 'boolean)

(defcustom research-prose-auto-gls t
  "Whether `research-prose-maybe-enable' turns on the auto \\gls too.
That is `research-prose-auto-gls-mode': with it, in thesis files a
defined acronym becomes `\\gls{KEY}' as soon as you finish typing it."
  :type 'boolean)

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
    (setq s (research-prose--blank-matches s "\\\\new\\(?:acronym\\|glossaryentry\\)\\(?:\\[[^]]*\\]\\)?\\(?:{[^}]*}\\)+"))
    (setq s (research-prose--blank-matches s research-prose--argument-commands))
    (setq s (research-prose--blank-matches s "\\\\[a-zA-Z]+\\*?\\(?:\\[[^]\n]*\\]\\)?"))
    (setq s (research-prose--blank-matches s "\\\\[^a-zA-Z \t\n]"))
    (setq s (research-prose--blank-matches s "[{}]"))
    (setq s (research-prose--blank-matches s "^[ \t]*\\(?:[-+]\\|[0-9]+[.)]\\)[ \t]+\\(?:\\[[ X-]\\][ \t]+\\)?"))
    s))

(defun research-prose--paragraphs (beg end &optional tables)
  "The prose paragraphs between BEG and END, as (START . END) positions.
Lines that are not prose (headings, keywords, drawers, skipped blocks and
environments, tables, comments, display math, lone LaTeX commands) end a
paragraph, as blank lines do; a list item starts a new one.  With TABLES,
each row of an Org table (not its rules) is a paragraph of its own too."
  (let ((case-fold-search t) out start last block)
    (save-excursion
      (goto-char beg)
      (forward-line 0)
      (while (< (point) end)
        (let* ((bol (point)) (eol (line-end-position))
               (prose nil) (row nil))
          (cond
           (block
            (when (looking-at block) (setq block nil)))
           ((and tables (looking-at "^[ \t]*|") (not (looking-at "^[ \t]*|[-+]")))
            (setq row t))
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
            (when start (push (cons start last) out) (setq start nil))
            (when row (push (cons bol (min eol end)) out)))
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

(defun research-prose--acronym-shorts (table)
  "TABLE's acronyms by how they are written: a hash from SHORT to KEY.
A key with an uppercase letter, and every key in upper case, count as
written forms too."
  (let ((shorts (make-hash-table :test #'equal)))
    (maphash (lambda (key short)
               (unless (string-empty-p short) (puthash short key shorts))
               (when (string-match-p "[[:upper:]]" key) (puthash key key shorts))
               (unless (gethash (upcase key) shorts) (puthash (upcase key) key shorts)))
             table)
    shorts))

(defun research-prose--acronym-lookup (token shorts)
  "(KEY . PLURAL) when TOKEN is a defined acronym of SHORTS, else nil.
PLURAL is non-nil when TOKEN is the short form followed by «s» (LLMs)."
  (let ((key (gethash token shorts)))
    (cond (key (cons key nil))
          ((and (string-suffix-p "s" token)
                (setq key (gethash (substring token 0 -1) shorts)))
           (cons key t)))))

(defconst research-prose--acronym-regexp "\\<[[:upper:]][[:upper:][:digit:]]+s?\\>"
  "An uppercase word that may be an acronym, with an optional plural «s».")

(defun research-prose--sentence-start-p (text index)
  "Whether the word at INDEX of the masked paragraph TEXT starts a sentence.
At the start of the paragraph (or list item), after . ! ? or …, or at the
start of a table cell; opening quotes and parentheses in between are
skipped."
  (let ((i index))
    (while (and (> i 0) (memq (aref text (1- i)) '(?\s ?\t ?\n ?« ?\" ?“ ?‘ ?' ?\( ?¿ ?¡)))
      (cl-decf i))
    (or (= i 0) (and (memq (aref text (1- i)) '(?. ?! ?? ?… ?|)) t))))

(defun research-prose--acronym-tokens (paragraphs shorts)
  "The uppercase words of PARAGRAPHS ((START TEXT RAW) ...), outside non-prose.
Each is (BEG END TOKEN KEY PLURAL CAPITAL), in buffer order: KEY is nil
when SHORTS does not define it, PLURAL non-nil for SHORT + «s», CAPITAL
non-nil when it starts a sentence.  Run with `research-prose--syntax-table'."
  (let ((case-fold-search nil) out)
    (dolist (p paragraphs)
      (let ((base (nth 0 p)) (text (nth 1 p)) (pos 0))
        (while (string-match research-prose--acronym-regexp text pos)
          (let* ((b (match-beginning 0)) (e (match-end 0))
                 (token (match-string 0 text))
                 (hit (research-prose--acronym-lookup token shorts)))
            (push (list (+ base b) (+ base e) token (car hit) (cdr hit)
                        (research-prose--sentence-start-p text b))
                  out)
            (setq pos e)))))
    (nreverse out)))

(defun research-prose--acronym-candidate-p (token)
  "Whether the undefined TOKEN looks like an acronym worth defining.
2 to 8 uppercase letters or digits (plus a plural «s»), not a Roman
numeral, not in `research-prose-acronym-ignore'."
  (let* ((case-fold-search nil)
         (base (if (string-suffix-p "s" token) (substring token 0 -1) token)))
    (and (<= 2 (length base) 8)
         (not (string-match-p "\\`X\\{0,3\\}\\(?:IX\\|IV\\|VI\\{0,3\\}\\|I\\{0,3\\}\\)\\'" base))
         (not (member base research-prose-acronym-ignore))
         (not (member token research-prose-acronym-ignore)))))

(defun research-prose--gls-command (key plural capital)
  "The `\\gls' command for KEY: plural with PLURAL, capitalized with CAPITAL."
  (format "\\%s%s{%s}" (if (and capital research-prose-gls-capitalize) "Gls" "gls") (if plural "pl" "") key))

(defun research-prose--acronyms (paragraphs checks)
  "Run the acronym CHECKS over PARAGRAPHS.
Flag bare defined acronyms and `\\gls' of undefined keys (`acronyms') and
undefined acronym-like words (`new-acronyms').  Each paragraph is (START
TEXT RAW): RAW is the buffer text, TEXT masked."
  (when-let* ((file (research-prose--acronym-file)))
    (let* ((table (research-prose-read-acronyms file))
           (name (file-name-nondirectory file))
           (shorts (research-prose--acronym-shorts table))
           (case-fold-search nil))
      (dolist (tk (research-prose--acronym-tokens paragraphs shorts))
        (pcase-let ((`(,b ,e ,token ,key ,plural ,capital) tk))
          (cond ((and key (memq 'acronyms checks))
                 (research-prose--add b e :warning 'acronyms
                                      (format "Acrónimo «%s» sin \\gls: está definido en %s. Escríbelo %s para que el glosario lo desarrolle la primera vez y lo enlace (research-prose-gls-at-point lo convierte; research-prose-gls-fix, todos)."
                                              token name (research-prose--gls-command key plural capital))))
                ((and (not key) (memq 'new-acronyms checks) (research-prose--acronym-candidate-p token))
                 (research-prose--add b e :note 'new-acronyms
                                      (format "«%s» parece una sigla, pero no está en %s. Si lo es, research-prose-add-acronym la define (pide la forma larga) y la convierte en \\gls; si no, agrégala a research-prose-acronym-ignore."
                                              token name))))))
      (when (memq 'acronyms checks)
        (dolist (p paragraphs)
          (let ((base (nth 0 p)) (raw (nth 2 p)) (pos 0))
            (while (string-match "\\\\\\(?:[Gg]ls[a-zA-Z]*\\|acr[a-zA-Z]*\\)\\*?\\(?:\\[[^]]*\\]\\)?{\\([^}]+\\)}" raw pos)
              (let ((key (string-trim (match-string 1 raw))))
                (unless (gethash key table)
                  (research-prose--add (+ base (match-beginning 0)) (+ base (match-end 0)) :error 'acronyms
                                       (format "\\gls{%s} no está definido en %s: la compilación lo mostrará como un error. ¿Falta el \\newacronym o la clave es otra?"
                                               key name))))
              (setq pos (match-end 0)))))))))

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
         (acronyms (or (memq 'acronyms checks) (memq 'new-acronyms checks)))
         ;; Table rows only for the acronym checks: a table exports to LaTeX too.
         (all (with-syntax-table research-prose--syntax-table
                (mapcar (lambda (p)
                          (let ((raw (buffer-substring-no-properties (car p) (cdr p))))
                            (list (car p) (research-prose-mask raw) raw)))
                        (research-prose--paragraphs beg end acronyms))))
         (paragraphs (if acronyms
                         (cl-remove-if (lambda (p) (string-match-p "\\`[ \t]*|" (nth 2 p))) all)
                       all))
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
      (when acronyms (research-prose--acronyms all checks)))
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
  "Turn on `research-prose-mode' in a thesis file (for `org-mode-hook').
And `research-prose-auto-gls-mode' too, when `research-prose-auto-gls'."
  (when (research-prose-thesis-file-p)
    (research-prose-mode 1)
    (when research-prose-auto-gls (research-prose-auto-gls-mode 1))))

;;;; Converting acronyms

(defun research-prose--in-acronym-file-p ()
  "Whether the buffer visits the thesis' acronym file itself."
  (let ((file (research-prose--acronym-file)))
    (and file buffer-file-name (file-equal-p file buffer-file-name))))

(defun research-prose--acronym-file-or-error ()
  "The thesis' acronym file, or a user error when there is none."
  (or (research-prose--acronym-file)
      (user-error "No encontré %s en la carpeta de este archivo ni arriba de ella"
                  (string-join research-prose-acronym-files " ni "))))

(defun research-prose--tokens-in (beg end)
  "The uppercase prose words between BEG and END.
As (BEG END TOKEN KEY PLURAL CAPITAL), see `research-prose--acronym-tokens'.
Every paragraph is found from the start of the buffer, so that BEG inside
a block or a drawer is recognized as such.  Nil without an acronym file."
  (when-let* ((file (research-prose--acronym-file)))
    (let ((shorts (research-prose--acronym-shorts (research-prose-read-acronyms file))))
      (with-syntax-table research-prose--syntax-table
        (let ((paragraphs
               (cl-loop for p in (research-prose--paragraphs (point-min) (point-max) t)
                        when (and (>= (cdr p) beg) (<= (car p) end))
                        collect (let ((raw (buffer-substring-no-properties (car p) (cdr p))))
                                  (list (car p) (research-prose-mask raw) raw)))))
          (cl-remove-if-not (lambda (tk) (and (>= (nth 0 tk) beg) (<= (nth 1 tk) end)))
                            (research-prose--acronym-tokens paragraphs shorts)))))))

(defun research-prose--token-at (pos)
  "The uppercase prose word around POS (it may end at POS), or nil."
  (save-excursion
    (goto-char pos)
    (cl-find-if (lambda (tk) (<= (nth 0 tk) pos (nth 1 tk)))
                (research-prose--tokens-in (line-beginning-position) (line-end-position)))))

(defun research-prose--convert (token-info)
  "Replace the acronym of TOKEN-INFO with its `\\gls'.
TOKEN-INFO is (BEG END TOKEN KEY PLURAL CAPITAL).  Returns the command written."
  (pcase-let ((`(,b ,e ,_token ,key ,plural ,capital) token-info))
    (let ((command (research-prose--gls-command key plural capital)))
      (save-excursion
        (goto-char b)
        (delete-region b e)
        (insert command))
      command)))

(defun research-prose--refresh ()
  "Recheck the buffer when `research-prose-mode' is on."
  (when (and (bound-and-true-p research-prose-mode) (bound-and-true-p flymake-mode) (fboundp 'flymake-start))
    (flymake-start)))

;;;###autoload
(defun research-prose-gls-at-point ()
  "Write the bare acronym at point as `\\gls{KEY}' (`\\glspl{KEY}' for its plural).
The acronym at point is the one the Flymake diagnostic at point is about.
It is matched on its short form in the acronym file
\(`\\newacronym{KEY}{SHORT}{LONG}') and written with its KEY; at the start
of a sentence it becomes `\\Gls' (see `research-prose-gls-capitalize').
An undefined acronym is offered to `research-prose-add-acronym'."
  (interactive)
  (research-prose--acronym-file-or-error)
  (when (research-prose--in-acronym-file-p)
    (user-error "Este es el archivo de acrónimos: aquí no se convierte nada"))
  (let ((tk (research-prose--token-at (point))))
    (cond
     ((null tk) (user-error "No hay un acrónimo en el punto (o está donde no es prosa: código, cita, comando de LaTeX…)"))
     ((nth 3 tk)
      (let ((command (research-prose--convert tk)))
        (research-prose--refresh)
        (message "«%s» → %s" (nth 2 tk) command)))
     ((y-or-n-p (format "«%s» no está en %s. ¿Agregarlo? "
                        (nth 2 tk) (file-name-nondirectory (research-prose--acronym-file))))
      (call-interactively #'research-prose-add-acronym)))))

(defvar research-prose-gls-fix-read-function #'research-prose--gls-fix-read
  "Function that asks about one conversion of `research-prose-gls-fix'.
Called with the prompt; returns ?y, ?n, ?! or ?q.")

(defun research-prose--gls-fix-read (prompt)
  "Read the answer to PROMPT: y (or SPC), n (or DEL), ! or q (or RET)."
  (pcase (read-char-choice prompt '(?y ?n ?! ?q ?\s ?\d ?\r))
    (?\s ?y) (?\d ?n) (?\r ?q) (c c)))

;;;###autoload
(defun research-prose-gls-fix (&optional beg end)
  "Write the bare acronyms of the region or buffer as `\\gls', asking each time.
BEG and END delimit the region.  Like `query-replace': y (or SPC)
converts this one, n (or DEL) skips it, ! converts it and the rest
without asking, q (or RET) stops.  What is not
prose is skipped, as in the checks (code, examples, comments, `#+' lines,
headings, citations, link targets, LaTeX commands such as an existing
`\\gls{…}', math, verbatim); table rows are included.  The whole run is
one undo step."
  (interactive (if (use-region-p) (list (region-beginning) (region-end))))
  (research-prose--acronym-file-or-error)
  (when (research-prose--in-acronym-file-p)
    (user-error "Este es el archivo de acrónimos: aquí no se convierte nada"))
  (let* ((beg (or beg (point-min))) (end (or end (point-max)))
         (found (cl-remove-if-not (lambda (tk) (nth 3 tk)) (research-prose--tokens-in beg end)))
         (items (mapcar (lambda (tk) (cons (cons (copy-marker (nth 0 tk)) (copy-marker (nth 1 tk))) tk)) found))
         (overlay (make-overlay (point) (point)))
         (converted 0) (skipped 0) all)
    (overlay-put overlay 'face 'query-replace)
    (overlay-put overlay 'priority 1000)
    (unwind-protect
        (with-undo-amalgamate
          (catch 'quit
            (dolist (item items)
              (let* ((b (marker-position (caar item))) (e (marker-position (cdar item)))
                     (tk (append (list b e) (nthcdr 2 (cdr item)))))
                (when (equal (buffer-substring-no-properties b e) (nth 2 tk))
                  (let ((answer
                         (if all ?y
                           (move-overlay overlay b e)
                           (goto-char e)
                           (funcall research-prose-gls-fix-read-function
                                    (format "¿Convertir «%s» en %s? (y sí, n no, ! todos, q salir) "
                                            (nth 2 tk) (apply #'research-prose--gls-command (nthcdr 3 tk)))))))
                    (pcase answer
                      (?! (setq all t) (research-prose--convert tk) (cl-incf converted))
                      (?y (research-prose--convert tk) (cl-incf converted))
                      (?q (throw 'quit nil))
                      (_ (cl-incf skipped)))))))))
      (delete-overlay overlay)
      (dolist (item items) (set-marker (caar item) nil) (set-marker (cdar item) nil)))
    (research-prose--refresh)
    (message (if found "Acrónimos: %d convertidos a \\gls, %d sin tocar" "Acrónimos: ninguno escrito sin \\gls")
             converted (- (length found) converted))
    converted))

;;;; Auto conversion

(defconst research-prose--auto-gls-triggers '(?\s ?\t ?\n ?. ?, ?\; ?: ?! ?? ?\) ?» ?” ?’ ?\")
  "Characters that, typed after an acronym, end it.")

(defconst research-prose--auto-gls-before "[ \t\n(«\"“‘'¿¡—]"
  "Characters that may come right before an acronym converted as you type.
Anything else (`{', `[', `=', `~', `$', `\\', `@', `:', `/'…) may start
markup not finished yet, so the acronym is left alone.")

(defun research-prose--auto-gls ()
  "Convert the defined acronym just typed before the character at point.
For `post-self-insert-hook' in `research-prose-auto-gls-mode'."
  (when (and (memq (char-before) research-prose--auto-gls-triggers)
             (> (point) (1+ (point-min))))
    (let ((end (1- (point))) (case-fold-search nil) beg token)
      (save-excursion
        (goto-char end)
        (with-syntax-table research-prose--syntax-table
          (when (and (looking-back "\\<[[:upper:]][[:upper:][:digit:]]+s?" (line-beginning-position) t)
                     (= (match-end 0) end))
            (setq beg (match-beginning 0) token (match-string-no-properties 0)))))
      (when (and beg
                 (or (= beg (point-min))
                     (string-match-p research-prose--auto-gls-before (string (char-before beg)))))
        (when-let* ((file (research-prose--acronym-file))
                    ((research-prose--acronym-lookup token (research-prose--acronym-shorts (research-prose-read-acronyms file))))
                    ((not (research-prose--in-acronym-file-p)))
                    (tk (cl-find-if (lambda (tk) (and (= (nth 0 tk) beg) (= (nth 1 tk) end) (nth 3 tk)))
                                    (research-prose--tokens-in beg end))))
          ;; Its own undo step: one undo brings the acronym back and keeps what was typed.
          (undo-boundary)
          (research-prose--convert tk))))))

;;;###autoload
(define-minor-mode research-prose-auto-gls-mode
  "Write a defined acronym as `\\gls{KEY}' as soon as you finish typing it.
After a space, a newline or punctuation, a bare acronym of the thesis'
acronym file just typed becomes `\\gls{KEY}' (`\\glspl{KEY}' for its
plural, `\\Gls' at the start of a sentence), unless it is where the
checks see no prose (code, comments, `#+' lines, headings, citations,
links, LaTeX, math, verbatim) or right after a character that may open
markup.  `undo' right after it brings the bare acronym back.  Never in the
acronym file itself.  `research-prose-maybe-enable' turns it on in thesis
files when `research-prose-auto-gls' is non-nil."
  :lighter " gls"
  (if research-prose-auto-gls-mode
      (add-hook 'post-self-insert-hook #'research-prose--auto-gls nil t)
    (remove-hook 'post-self-insert-hook #'research-prose--auto-gls t)))

;;;; Adding acronyms

(defconst research-prose--plural-stop-words
  '("de" "del" "para" "con" "en" "a" "al" "por" "sobre" "entre" "sin" "y" "o" "e" "u" "la" "el" "los" "las")
  "Words that end the noun group a Spanish long form's plural changes.")

(defun research-prose--pluralize-word (word)
  "WORD in Spanish plural, by the usual spelling rules (a heuristic)."
  (let ((case-fold-search nil)
        (lower (downcase word)))
    (cond
     ((string-empty-p word) word)
     ;; Already plural or invariant (análisis, crisis, tórax): unstressed -s/-x.
     ((and (string-match-p "[sx]\\'" lower) (> (length lower) 3)) word)
     ((string-match-p "[aeiouáéó]\\'" lower) (concat word "s"))
     ((string-match-p "[íú]\\'" lower) (concat word "es"))
     ((string-match-p "z\\'" lower) (concat (substring word 0 -1) (if (equal (substring word -1) "Z") "CES" "ces")))
     ;; -ión, -án, -én, -ín, -ón, -ún lose the written accent: información → informaciones.
     ((string-match "\\([áéíóú]\\)\\([ns]\\)\\'" word)
      (let ((plain (cdr (assoc (match-string 1 word) '(("á" . "a") ("é" . "e") ("í" . "i") ("ó" . "o") ("ú" . "u"))))))
        (concat (substring word 0 (match-beginning 1)) plain (match-string 2 word) "es")))
     (t (concat word "es")))))

(defun research-prose-spanish-plural (long)
  "Plural of the Spanish LONG form: the words before the first preposition,
article or conjunction (the noun and its adjectives) go to plural:
«modelo de lenguaje de gran tamaño» → «modelos de lenguaje de gran tamaño»,
«inteligencia artificial» → «inteligencias artificiales»."
  (let ((words (split-string long " " t)) (done nil) out)
    (dolist (w words)
      (if (or done (member (downcase w) research-prose--plural-stop-words))
          (progn (setq done t) (push w out))
        (push (research-prose--pluralize-word w) out)))
    (string-join (nreverse out) " ")))

(defun research-prose--insert-acronym-definition (key short long &optional long-plural)
  "Insert `\\newacronym{KEY}{SHORT}{LONG}' into the current acronym file buffer.
With LONG-PLURAL (and when it isn't just LONG plus «s», which is what
glossaries does by itself), the line carries `[longplural={LONG-PLURAL}]'.
In order of key when the definitions are sorted, else after the last one
\(or at the end); comments and everything else are kept."
  (save-excursion
    (save-restriction
      (widen)
      (goto-char (point-min))
      (let ((case-fold-search nil) entries)
        (while (re-search-forward "^[ \t]*\\\\newacronym\\(?:\\[[^]]*\\]\\)?{\\([^}]+\\)}" nil t)
          (push (cons (downcase (string-trim (match-string-no-properties 1))) (line-beginning-position)) entries))
        (setq entries (nreverse entries))
        (let* ((sorted (cl-loop for (a b) on entries while b always (not (string< (car b) (car a)))))
               (next (and sorted (cl-find-if (lambda (e) (string< (downcase key) (car e))) entries))))
          (cond (next (goto-char (cdr next)))
                (entries (goto-char (cdr (car (last entries)))) (forward-line 1))
                (t (goto-char (point-max))))
          (when (and (eobp) (not (bolp))) (insert "\n"))
          (insert (if (and long-plural (not (string-empty-p long-plural))
                           (not (equal long-plural (concat long "s"))))
                      (format "\\newacronym[longplural={%s}]{%s}{%s}{%s}\n" long-plural key short long)
                    (format "\\newacronym{%s}{%s}{%s}\n" key short long))))))))

;;;###autoload
(defun research-prose-add-acronym (short long &optional key long-plural)
  "Define the acronym SHORT, with LONG form and KEY, in the thesis' acronym file.
LONG-PLURAL is the long form's plural (glossaries' `longplural', used by
`\\glspl'); interactively it is asked with a Spanish guess
\(`research-prose-spanish-plural'), since glossaries would otherwise just
append «s» («modelo de lenguaje de gran tamaños»).
Appends `\\newacronym{KEY}{SHORT}{LONG}' (in order when the file is sorted by
key), saves the file (your buffer, if you have it open) and offers to
convert the acronym at point.  Interactively, SHORT defaults to the
uppercase word at point (without a plural «s») and KEY to SHORT in lower
case."
  (interactive
   (let* ((file (research-prose--acronym-file-or-error))
          (at (let ((tk (research-prose--token-at (point))))
                (and tk (let ((token (nth 2 tk)))
                          (if (and (string-suffix-p "s" token) (> (length token) 2)) (substring token 0 -1) token)))))
          (short (string-trim (read-string (format-prompt "Sigla" at) nil nil at)))
          (long (string-trim (read-string (format "Forma larga de %s (en %s): " short (file-name-nondirectory file)))))
          (guess (research-prose-spanish-plural long))
          (long-plural (string-trim (read-string (format-prompt "Plural de la forma larga (para \\glspl)" guess) nil nil guess)))
          (key (string-trim (read-string (format-prompt "Clave" (downcase short)) nil nil (downcase short)))))
     (list short long key long-plural)))
  (let* ((file (research-prose--acronym-file-or-error))
         (key (if (or (null key) (string-empty-p key)) (downcase short) key))
         (table (research-prose-read-acronyms file))
         (name (file-name-nondirectory file)))
    (when (or (string-empty-p short) (string-empty-p long))
      (user-error "La sigla y la forma larga no pueden quedar vacías"))
    (when (string-match-p "[{}\\\\%,]" key)
      (user-error "La clave «%s» no puede llevar llaves, barras, comas ni %%" key))
    (when (gethash key table)
      (user-error "La clave «%s» ya está definida en %s" key name))
    (when-let* ((other (gethash short (research-prose--acronym-shorts table))))
      (user-error "«%s» ya está definido en %s como \\gls{%s}" short name other))
    (let* ((visiting (find-buffer-visiting file))
           (modified (and visiting (buffer-modified-p visiting)))
           (buffer (or visiting (find-file-noselect file))))
      (with-current-buffer buffer
        (research-prose--insert-acronym-definition key short long long-plural)
        (when (or (not modified)
                  (y-or-n-p (format "%s tenía cambios sin guardar; ¿guardarlo con todo? " name)))
          (save-buffer)))
      (unless visiting (kill-buffer buffer)))
    (setq research-prose--acronym-cache (assoc-delete-all file research-prose--acronym-cache))
    (message "Agregado \\newacronym{%s}{%s}{%s} a %s" key short long name)
    (let ((tk (and (not (research-prose--in-acronym-file-p)) (research-prose--token-at (point)))))
      (when (and tk (equal (nth 3 tk) key)
                 (y-or-n-p (format "¿Convertir «%s» en %s? " (nth 2 tk) (apply #'research-prose--gls-command (nthcdr 3 tk)))))
        (research-prose--convert tk)))
    (research-prose--refresh)
    key))


(provide 'research-prose)
;;; research-prose.el ends here
