// Excel/Sheets execute cells beginning with = + - @ (and tab/CR can smuggle a
// prefix past naive parsers). Report data contains user-authored strings
// (party names, memos, …), so every string cell is neutralised with a leading
// apostrophe before serialization. Purely-numeric strings (e.g. "-12.5") are
// exempt — spreadsheets parse them as numbers, never as formulas.

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/

/** Neutralise one export string cell against formula injection. Shared by
 *  the page-streaming CSV writer, both XLSX writers and the engine's own
 *  CSV registers, so every surface guards exactly like the report export: a memo such as
 *  `=HYPERLINK(…)` must never reach a spreadsheet as a live formula. */
export function guardCsvCell<T extends string | number | null | undefined>(v: T): T | string {
  if (typeof v === 'string' && CSV_FORMULA_PREFIX.test(v) && !PLAIN_NUMBER.test(v)) {
    return `'${v}`
  }
  return v
}
