import 'server-only'
import { parseCsvRows } from '@openbooks/engine/src/banking/banking.ts'
import { isSheetFormulaCellValue, readSheet, type SheetCellValue } from '@openbooks/office'
import { CELL_PROVENANCE_KEY, type CellProvenance, type ImportFormat } from './types'

export interface ParsedFile {
  /** Column headers found in the file (in order). */
  headers: string[]
  /**
   * Every data row, keyed by header. XLSX numbers remain numbers, text remains
   * text, and formula provenance is carried under `CELL_PROVENANCE_KEY` so a
   * formula's cached string cannot masquerade as literal input.
   */
  rows: Record<string, unknown>[]
  /**
   * True when the file held more rows than the import cap: only the first
   * MAX_IMPORT_ROWS were kept. Callers must surface this — silently importing
   * a prefix of a file drops money without a trace.
   */
  truncated: boolean
}

export const MAX_IMPORT_ROWS = 20_000

/** A file that cannot be imported as-is (duplicate headers, ...). */
export class ImportParseError extends Error {
  readonly name = 'ImportParseError'
}

/**
 * Repeated columns collapse to one key downstream, so the losing column's
 * data would vanish silently. Fail closed naming the header; blank headers
 * are dropped later and never collide.
 */
function assertUniqueHeaders(headers: string[]): void {
  const seen = new Set<string>()
  for (const header of headers) {
    if (!header) continue
    if (seen.has(header)) {
      throw new ImportParseError(
        `duplicate column "${header}" — rename one of the columns before importing`,
      )
    }
    seen.add(header)
  }
}

/**
 * Normalize an uploaded file (CSV text, XLSX base64, or JSON text) into a
 * header list + row objects keyed by header. The importer maps those headers
 * onto resource fields; nothing here touches the database.
 */
export async function parseImportFile(
  format: ImportFormat,
  payload: { text?: string; base64?: string },
): Promise<ParsedFile> {
  if (format === 'json') return parseJson(payload.text ?? '')
  if (format === 'xlsx') {
    if (!payload.base64) return { headers: [], rows: [], truncated: false }
    const buf = Buffer.from(payload.base64, 'base64')
    const { headers, rows } = await readSheet(buf)
    assertUniqueHeaders(headers)
    return {
      ...matrixToObjects(headers, rows.slice(0, MAX_IMPORT_ROWS)),
      truncated: rows.length > MAX_IMPORT_ROWS,
    }
  }
  // csv
  const matrix = parseCsvRows(payload.text ?? '')
  const headers = (matrix.shift() ?? []).map((h) => String(h).trim())
  assertUniqueHeaders(headers)
  return {
    ...matrixToObjects(headers, matrix.slice(0, MAX_IMPORT_ROWS)),
    truncated: matrix.length > MAX_IMPORT_ROWS,
  }
}

function matrixToObjects(
  headers: string[],
  rows: (SheetCellValue | null)[][],
): Pick<ParsedFile, 'headers' | 'rows'> {
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    if (
      row.every((c) => {
        const value = c !== null && c !== undefined && isSheetFormulaCellValue(c) ? c.value : c
        return value === null || value === undefined || String(value).trim() === ''
      })
    ) {
      continue
    }
    const obj: Record<string, unknown> = {}
    const provenance: Record<string, CellProvenance> = {}
    headers.forEach((h, i) => {
      if (!h) return
      const cell = row[i]
      if (cell !== null && cell !== undefined && isSheetFormulaCellValue(cell)) {
        obj[h] = cell.value
        provenance[h] = 'formula'
      } else {
        obj[h] = cell ?? ''
      }
    })
    if (Object.keys(provenance).length > 0) obj[CELL_PROVENANCE_KEY] = provenance
    out.push(obj)
  }
  return { headers, rows: out }
}

function parseJson(text: string): ParsedFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ImportParseError(
      'the file is not valid JSON — check for trailing commas or a truncated upload before importing',
    )
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  // A filtered-out row is a dropped row: nulls, nested arrays and scalars
  // have no columns to map, so importing them as "zero rows" would report
  // success while silently losing data. Refuse naming the first bad entry.
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ImportParseError(
        `entry ${i + 1} is not an object — a JSON import must be an object or an array of objects, one object per row`,
      )
    }
    rows.push(entry as Record<string, unknown>)
  }
  const headers: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k)
        headers.push(k)
      }
    }
  }
  return { headers, rows: rows.slice(0, MAX_IMPORT_ROWS), truncated: rows.length > MAX_IMPORT_ROWS }
}

/** Auto-guess a target field for a source header (exact, case-insensitive, fuzzy). */
export function guessMapping(headers: string[], fieldKeys: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byNorm = new Map(fieldKeys.map((k) => [norm(k), k]))
  const mapping: Record<string, string> = {}
  for (const h of headers) {
    const n = norm(h)
    if (byNorm.has(n)) mapping[h] = byNorm.get(n)!
  }
  return mapping
}
