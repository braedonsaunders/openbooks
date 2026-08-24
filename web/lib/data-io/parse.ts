import 'server-only'
import { parseCsvRows } from '@openbooks/engine/src/banking.ts'
import { readSheet } from '@openbooks/office'
import type { ImportFormat } from './types'

export interface ParsedFile {
  /** Column headers found in the file (in order). */
  headers: string[]
  /**
   * Every data row, keyed by header. XLSX numeric cells and numeric formula
   * results remain numbers so exact-decimal write boundaries can reject values
   * that have already crossed IEEE-754; text cells remain strings.
   */
  rows: Record<string, unknown>[]
}

const MAX_IMPORT_ROWS = 20_000

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
    if (!payload.base64) return { headers: [], rows: [] }
    const buf = Buffer.from(payload.base64, 'base64')
    const { headers, rows } = await readSheet(buf)
    return matrixToObjects(headers, rows)
  }
  // csv
  const matrix = parseCsvRows(payload.text ?? '')
  const headers = (matrix.shift() ?? []).map((h) => String(h).trim())
  return matrixToObjects(headers, matrix)
}

function matrixToObjects(headers: string[], rows: (string | number | null)[][]): ParsedFile {
  const out: Record<string, unknown>[] = []
  for (const row of rows.slice(0, MAX_IMPORT_ROWS)) {
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue
    const obj: Record<string, unknown> = {}
    headers.forEach((h, i) => {
      if (h) obj[h] = row[i] ?? ''
    })
    out.push(obj)
  }
  return { headers, rows: out }
}

function parseJson(text: string): ParsedFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { headers: [], rows: [] }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const rows = arr.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[]
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
  return { headers, rows: rows.slice(0, MAX_IMPORT_ROWS) }
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
