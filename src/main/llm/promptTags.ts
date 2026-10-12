/**
 * The tags that structure a prompt (the chat's input and the tool answers it reads). Data may neither open nor close
 * one of them: every opener of such a tag is neutralized, wherever the data comes from. A new prompt tag is added here
 * and nowhere else.
 */
export const PROMPT_TAG_NAMES = ['thesis', 'paper', 'earlier', 'conversation', 'turn', 'excerpt', 'question', 'actions_done', 'library_data', 'protocol', 'record'] as const

/** `<` and the look-alikes a model may read as one: full-width (U+FF1C) and small-form (U+FE64). */
const OPENERS = '<\uff1c\ufe64'
/**
 * Characters a model does not see between `<`, the slash and the letters of a name: format characters (zero-width
 * spaces and joiners, bidi marks), non-spacing marks (the combining grapheme joiner U+034F, variation selectors) and
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0).
 */
const INVISIBLE = '\\p{Cf}\\p{Mn}\u115f\u1160\u3164\uffa0'
const GAP = `[\\s${INVISIBLE}]*`
/** The slash and its look-alikes: full-width (U+FF0F), division slash (U+2215), fraction slash (U+2044) and a backslash. */
const SLASHES = '/\uff0f\u2215\u2044\\\\'

/** One character of a tag name in ASCII or full-width form, either case, with invisible characters allowed after it. */
function nameChar(c: string): string {
  const forms = new Set([c, c.toUpperCase()])
  if (c === '_') forms.add('\uff3f')
  else for (const f of [...forms]) forms.add(String.fromCodePoint(f.codePointAt(0)! + 0xfee0))
  return `[${[...forms].join('')}][${INVISIBLE}]*`
}

const NAMES = PROMPT_TAG_NAMES.map((name) => [...name].map(nameChar).join('')).join('|')
/**
 * An opener that starts a prompt tag (opening or closing), tolerating spaces and invisible characters around any
 * number of slashes or slash look-alikes (`<\/question>` included).
 */
const TAG_OPENER = new RegExp(`[${OPENERS}](?=${GAP}(?:[${SLASHES}]${GAP})*(?:${NAMES})(?![\\p{L}\\p{N}_\uff3f]))`, 'gu')

const escapeChar = (c: string): string => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`

/**
 * Neutralizes every prompt tag in a text without changing anything else: the opener of `<question>`, `</ turn>`,
 * `<` + U+200B + `/library_data>` or a full-width `</question>` becomes its six-character escape (backslash, `u` and
 * four hex digits: 003c, ff1c or fe64). That is a valid JSON escape that reads back as the same character, so a JSON
 * tool answer stays valid and exact; in plain text it stays readable but is no longer a tag. Everything else, quotes
 * the model copies included, stays verbatim.
 */
export function neutralizePromptTags(text: string): string {
  return text.replace(TAG_OPENER, escapeChar)
}

/**
 * Data written into a prompt the app builds itself: NFKC folds full-width and small-form characters into ASCII,
 * format characters (zero-width spaces and joiners, word joiners, bidi marks) are removed, then every prompt tag is
 * neutralized.
 */
export function escapePromptData(text: string): string {
  return neutralizePromptTags(text.normalize('NFKC').replace(/\p{Cf}/gu, ''))
}
