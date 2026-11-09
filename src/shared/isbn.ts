/** ISBN-13 check digit of its first 12 digits. */
function isbn13CheckDigit(first12: string): string {
  const sum = [...first12].reduce((acc, c, i) => acc + Number(c) * (i % 2 ? 3 : 1), 0)
  return String((10 - (sum % 10)) % 10)
}

/**
 * The ISBN-13 (digits only) of an ISBN-10 or ISBN-13, with or without hyphens, spaces or an «ISBN» prefix; null when
 * it is not one or its check digit is wrong. An ISBN-10 becomes its 978 ISBN-13, so both forms of a book are equal.
 */
export function normalizeIsbn(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^isbn(?:-?1[03])?:?\s*/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0)
    if (sum % 11 !== 0) return null
    const first12 = `978${s.slice(0, 9)}`
    return first12 + isbn13CheckDigit(first12)
  }
  if (/^97[89]\d{10}$/.test(s)) return isbn13CheckDigit(s.slice(0, 12)) === s[12] ? s : null
  return null
}
