import 'server-only'
import { reportResultToCsv, reportResultToXlsx, type ReportRunResult } from '@openbooks/office'
import type { CellValue } from './types'

/**
 * Turn a resource read result into the reports' `ReportRunResult` shape so the
 * shared office serializers (formula-injection-guarded CSV, styled XLSX) can
 * render it. Column headers use the stable field KEY (not the display label)
 * so an exported file re-imports cleanly — the importer auto-maps by key.
 */
export function buildRunResult(
  title: string,
  columns: { key: string; label: string }[],
  rows: Record<string, CellValue>[],
): ReportRunResult {
  return {
    groups: [
      {
        kind: 'results',
        title,
        columns: columns.map((c) => c.key),
        rows: rows.map((r) => columns.map((c) => cellForSheet(r[c.key]))),
      },
    ],
    summary: [],
    rowCount: rows.length,
  }
}

/** Booleans render as text in spreadsheets; numbers/strings pass through. */
function cellForSheet(v: CellValue): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return v
}

export function toCsv(title: string, columns: { key: string; label: string }[], rows: Record<string, CellValue>[]): string {
  return reportResultToCsv(buildRunResult(title, columns, rows))
}

export function toXlsx(
  title: string,
  columns: { key: string; label: string }[],
  rows: Record<string, CellValue>[],
): Promise<Buffer> {
  return reportResultToXlsx(buildRunResult(title, columns, rows), { reportName: title })
}

/** Array-of-objects JSON keyed by column key — full-fidelity, human-diffable. */
export function toJson(columns: { key: string; label: string }[], rows: Record<string, CellValue>[]): string {
  const keys = columns.map((c) => c.key)
  const shaped = rows.map((r) => {
    const o: Record<string, CellValue> = {}
    for (const k of keys) o[k] = r[k] ?? null
    return o
  })
  return JSON.stringify(shaped, null, 2)
}
