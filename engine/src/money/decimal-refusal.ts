/**
 * Why `canonicalDecimal` refused a money or percent answer, and the refusal
 * that names it. Shared by the payroll engine and routes: openings, prior-run
 * imports, carry-ins, profiles, pay-run adjustments — anywhere an
 * operator-supplied decimal crosses the wire.
 *
 * Moved verbatim out of `web/lib/payroll-decimal-refusal.ts` (which is now a
 * compatibility re-export) so every site classifies the same way. A second
 * implementation of this classifier would be a defect even if every message
 * read well: the decimal-comma reading is a 100x money error when it is
 * wrong, and this logic already cost three rounds to get right. Fix it here
 * once, never beside a caller. This module lives in `money` (no database, no
 * floats) so engine code can import it without an upward edge.
 */

/**
 * What the operator supplied, safe to put in a refusal. The body is arbitrary
 * JSON: an object would stringify to "[object Object]" and tell them nothing,
 * and a pasted megabyte would come back whole. Name the type instead, and cap
 * the echo — a refusal has to be readable in a toast.
 */
export function suppliedValue(raw: unknown): string {
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw !== 'string') return Array.isArray(raw) ? 'a list' : `a ${raw === null ? 'null' : typeof raw}`
  return raw.length > 40 ? `${raw.slice(0, 40)}… (${raw.length} characters)` : raw
}

/**
 * Why canonicalDecimal refused a money or percent answer, read off the
 * supplied string itself — never by retrying looser parses and inferring the
 * cause from which attempt accepts. That ladder admits by accident; this
 * classifies the text the operator typed. canonicalDecimal is one strict gate
 * (plain digits, bounded decimals), so its single null covers seven situations
 * with seven different remedies: too many decimals (round), a thousands
 * separator (retype without it, using "." for decimals — a spreadsheet paste
 * must never be silently re-valued), a decimal comma (rewrite with "." as the
 * point), an ambiguous comma (retype unambiguously, both readings named), a
 * currency symbol (retype without it), scientific notation (write it out in
 * full — how Excel renders a large figure), or no number at all.
 */
export type DecimalNullCause =
  | { cause: 'scale'; decimals: number }
  | { cause: 'separator'; separator: string }
  | { cause: 'decimal-comma'; dotted: string }
  | { cause: 'ambiguous-comma'; grouped: string; dotted: string }
  | { cause: 'currency'; symbol: string }
  | { cause: 'scientific' }
  | { cause: 'not-a-number' }

const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/
const GROUPING_SEPARATORS = [',', '_', "'", '\u2019', ' ', '\u00a0', '\u2009']
const GROUPING_DISPLAY: Record<string, string> = { ' ': 'space', '\u00a0': 'non-breaking space', '\u2009': 'thin space' }
const CURRENCY_SYMBOLS = ['$', '€', '£', '¥', '₹', '₩']

export function decimalNullCause(raw: unknown): DecimalNullCause {
  // Numbers stringify faithfully ("1234.567", "1e+21"); anything else that is
  // not a string has no digits to classify, so it is not a number.
  if (typeof raw !== 'string' && typeof raw !== 'number') return { cause: 'not-a-number' }
  const text = String(raw).trim()
  const plain = PLAIN_DECIMAL.exec(text)
  // A plain shape with an acceptable scale would not have refused, so a plain
  // shape here is over scale by construction.
  if (plain) return { cause: 'scale', decimals: plain[3]?.length ?? 0 }
  const ungrouped = text.replace(/[,_'\u2019\s\u00a0\u2009]/g, '')
  if (ungrouped !== text && PLAIN_DECIMAL.test(ungrouped)) {
    // When a dot and a comma both appear, the last one is the decimal
    // point — true across essentially every locale, so it is a rule rather
    // than a guess. "1.234,56" is dot-grouping with a decimal comma (the
    // standard money format in DE, IT, ES, NL, BR and PT): strip the dots
    // and read the comma as the point. "1,234.56" keeps the grouping
    // message below, unchanged.
    if (text.includes('.') && text.includes(',') && text.lastIndexOf(',') > text.lastIndexOf('.')) {
      const dotted = text.replace(/\./g, '').replace(',', '.')
      // Any tail length: a too-long tail rewrites to a plain figure the
      // scale branch then refuses honestly ("1.234,56789" -> "1234.56789"
      // -> at most 4 places), instead of guessing here.
      if (/^([+-]?\d+)\.(\d+)$/.test(dotted)) return { cause: 'decimal-comma', dotted }
    }
    // A comma is two readings, not one: seven installed packs are
    // decimal-comma locales, so "12,34" is twelve-thirty-four written
    // correctly, and "remove the comma" would store 1234 — a 100x error.
    // Read the comma before reaching for the grouping verb. Only a comma can
    // be a decimal point; every other separator is grouping by construction.
    if (!/[,_'\u2019\s\u00a0\u2009]/.test(text.replace(/,/g, ''))) {
      const decimalComma = /^([+-]?\d+),(\d{1,2})$/.exec(text)
      if (decimalComma) return { cause: 'decimal-comma', dotted: text.replace(',', '.') }
      // One comma with any other tail ("1,234", "12,") is genuinely
      // ambiguous: name both readings rather than picking one. A decimal
      // point or repeated three-digit groups would have settled it, and
      // neither is here.
      if (!text.includes('.') && (text.match(/,/g) ?? []).length === 1) {
        return { cause: 'ambiguous-comma', grouped: ungrouped, dotted: text.replace(',', '.') }
      }
    }
    // A decimal comma can arrive with its own grouping ("1 234,56",
    // "1'234,56"). Without this, the grouping message tells the operator to
    // remove the comma first, and the space message then banks a number with
    // the decimals folded into the whole — wrong money in two steps. Strip
    // every grouping char but the comma: if that reads as a decimal comma,
    // the comma was the decimal point.
    const commaKept = text.replace(/[_'\u2019\s\u00a0\u2009]/g, '')
    if (commaKept !== text && /^([+-]?\d+),(\d{1,2})$/.test(commaKept)) {
      return { cause: 'decimal-comma', dotted: commaKept.replace(',', '.') }
    }
    const separator = GROUPING_SEPARATORS.find((candidate) => text.includes(candidate)) ?? ','
    return { cause: 'separator', separator: GROUPING_DISPLAY[separator] ?? separator }
  }
  if (!/\d/.test(text)) return { cause: 'not-a-number' }
  const symbol = CURRENCY_SYMBOLS.find((candidate) => text.includes(candidate))
  if (symbol) return { cause: 'currency', symbol }
  if (/[0-9][eE][+-]?[0-9]/.test(text)) return { cause: 'scientific' }
  return { cause: 'not-a-number' }
}

/**
 * The refusal for a money or percent answer canonicalDecimal would not read.
 * Names which of the seven causes fired, the value received, and the remedy —
 * the same discipline the outer three-way split follows.
 */
export function decimalNullRefusal(field: string, noun: string, raw: unknown, maxScale: number): string {
  const shown = `"${suppliedValue(raw)}"`
  const cause = decimalNullCause(raw)
  switch (cause.cause) {
    case 'scale':
      return `${field} allows at most ${maxScale} decimal places — got ${cause.decimals} in ${shown}; round to fewer decimals and try again`
    case 'separator':
      return `${field} must not contain a thousands separator — remove ${cause.separator} from ${shown} and try again, using "." for decimals`
    case 'decimal-comma':
      return `${field} must use "." as the decimal point — write ${shown} as "${cause.dotted}" and try again`
    case 'ambiguous-comma':
      return `${field} is ambiguous — ${shown} could mean ${cause.grouped} (thousands separator) or ${cause.dotted} (decimal comma); retype it in plain digits with "." for decimals`
    case 'currency':
      return `${field} must not contain a currency symbol — remove ${cause.symbol} from ${shown} and try again`
    case 'scientific':
      return `${field} must be written out in full, not in scientific notation — expand ${shown} to plain digits and try again`
    case 'not-a-number':
      return `${field} must be ${noun} — ${shown} is not a number`
  }
}
