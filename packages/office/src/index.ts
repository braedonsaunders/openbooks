// @openbooks/office — tabular export utilities. Server-only (ExcelJS is a
// Node library). The web layer imports export helpers from here so the
// client-importable @openbooks/reports barrel never pulls ExcelJS into the
// browser bundle.
//
// CSV stays implemented in @openbooks/reports (pure string building) and is
// re-exported here so callers have a single import surface for tabular export.

import ExcelJS from 'exceljs'
import {
  reportResultToCsv as _reportResultToCsv,
  type ReportRunResult,
} from '@openbooks/reports'

export type { ReportRunResult } from '@openbooks/reports'

// --- CSV formula-injection guard ---------------------------------------------
// Excel/Sheets execute cells beginning with = + - @ (and tab/CR can smuggle a
// prefix past naive parsers). Report data contains user-authored strings
// (party names, memos, …), so every string cell is neutralised with a leading
// apostrophe before serialization. Purely-numeric strings (e.g. "-12.5") are
// exempt — spreadsheets parse them as numbers, never as formulas.

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/

function guardCsvCell<T extends string | number | null | undefined>(v: T): T | string {
  if (typeof v === 'string' && CSV_FORMULA_PREFIX.test(v) && !PLAIN_NUMBER.test(v)) {
    return `'${v}`
  }
  return v
}

/**
 * Serialize a run result to CSV with formula-injection guarding applied to
 * every string cell (data cells, column headings, and group titles — titles
 * become the leading section column in multi-group files).
 */
export function reportResultToCsv(
  result: ReportRunResult,
  opts: { sectionHeader?: string } = {},
): string {
  const guarded: ReportRunResult = {
    ...result,
    groups: result.groups.map((g) => ({
      ...g,
      title: guardCsvCell(g.title) as string,
      columns: g.columns.map((c) => guardCsvCell(c) as string),
      rows: g.rows.map((row) => row.map(guardCsvCell)),
    })),
  }
  return _reportResultToCsv(guarded, {
    ...opts,
    ...(opts.sectionHeader ? { sectionHeader: guardCsvCell(opts.sectionHeader) as string } : {}),
  })
}

export type ReportExportOptions = {
  reportName: string
  dateRangeLabel?: string
  generatedAt?: Date
}

const MAX_COL_WIDTH = 56
const MIN_COL_WIDTH = 10
const MAX_SHEET_NAME = 31

/**
 * Build an .xlsx workbook from a run result: one sheet per section group,
 * each with a title block (rows 1–3) + a frozen bold header (row 4) + data.
 * Number cells are right-aligned with an accounting format.
 */
export async function reportResultToXlsx(
  result: ReportRunResult,
  opts: ReportExportOptions,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'openbooks'
  const now = opts.generatedAt ?? new Date()
  wb.created = now
  wb.modified = now

  const usedNames = new Set<string>()
  const groups =
    result.groups.length > 0
      ? result.groups
      : [{ kind: 'results' as const, title: opts.reportName, columns: [] as string[], rows: [] as (string | number | null | undefined)[][], isEmpty: true }]

  for (const group of groups) {
    const desired = result.groups.length > 1 ? group.title : opts.reportName
    const sheetName = uniqueSheetName(truncate(sanitizeSheetName(desired), MAX_SHEET_NAME), usedNames)
    const ws = wb.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 4 }],
    })

    // Title block (rows 1–3), single cell in column A.
    setCell(ws, 1, 1, opts.reportName, { bold: true, size: 13 })
    if (opts.dateRangeLabel) setCell(ws, 2, 1, opts.dateRangeLabel, { muted: true })
    if (group.subtitle) setCell(ws, 3, 1, group.subtitle, { muted: true, italic: true })

    // Header row (row 4).
    const headerRowNum = 4
    group.columns.forEach((c, i) => {
      const cell = ws.getCell(headerRowNum, i + 1)
      cell.value = c
      cell.font = { bold: true, color: { argb: 'ff374151' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'fff1f5f9' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'ffd1d5db' } } }
      cell.alignment = { horizontal: 'left' }
    })

    // Data rows.
    let dataRow = headerRowNum + 1
    for (const row of group.rows) {
      for (let i = 0; i < group.columns.length; i++) {
        const v = row[i]
        const cell = ws.getCell(dataRow, i + 1)
        cell.value = v === null || v === undefined ? '' : (v as string | number)
        if (typeof cell.value === 'number') {
          cell.alignment = { horizontal: 'right' }
          cell.numFmt = '#,##0.00;(#,##0.00)'
        }
      }
      dataRow++
    }

    // Auto-width per column: measure header + sampled data cells, clamp [10,56].
    const lastData = dataRow - 1
    const sampleEnd = Math.min(lastData, headerRowNum + 400)
    for (let i = 1; i <= group.columns.length; i++) {
      const headerLen = String(ws.getCell(headerRowNum, i).value ?? '').length
      let maxLen = headerLen
      for (let r = headerRowNum + 1; r <= sampleEnd; r++) {
        const v = ws.getCell(r, i).value
        const s = v === null || v === undefined || typeof v === 'object' ? '' : String(v)
        if (s.length > maxLen) maxLen = s.length
      }
      ws.getColumn(i).width = Math.min(
        Math.max(Math.ceil(maxLen * 1.1) + 2, MIN_COL_WIDTH),
        MAX_COL_WIDTH,
      )
    }
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer)
}

// --- reading (bulk import) ---------------------------------------------------

/**
 * Read the first worksheet of an .xlsx workbook into a header row + typed
 * cells. Row 1 is treated as the header. Literal numbers remain numbers, while
 * formulas carry their cached scalar plus an explicit tag. Flattening either
 * kind to an unmarked string would let downstream exact-decimal validators
 * mistake rounded or formula-derived values for user-supplied text. ExcelJS
 * stays isolated in this package (never reaches the client bundle).
 */
export interface SheetFormulaCellValue {
  kind: 'formula'
  value: string | number
}

export type SheetCellValue = string | number | SheetFormulaCellValue

export function isSheetFormulaCellValue(value: SheetCellValue): value is SheetFormulaCellValue {
  return typeof value === 'object' && value.kind === 'formula'
}

interface SheetCellRange {
  top: number
  bottom: number
  left: number
  right: number
}

function columnNumber(label: string): number {
  let number = 0
  for (const char of label.toUpperCase()) number = number * 26 + char.charCodeAt(0) - 64
  return number
}

function sheetCellRange(ref: string): SheetCellRange | null {
  const match = ref.match(/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i)
  if (!match) return null
  const firstColumn = columnNumber(match[1]!)
  const firstRow = Number(match[2])
  const lastColumn = columnNumber(match[3] ?? match[1]!)
  const lastRow = Number(match[4] ?? match[2])
  return {
    top: Math.min(firstRow, lastRow),
    bottom: Math.max(firstRow, lastRow),
    left: Math.min(firstColumn, lastColumn),
    right: Math.max(firstColumn, lastColumn),
  }
}

export async function readSheet(buffer: Buffer): Promise<{ headers: string[]; rows: SheetCellValue[][] }> {
  const wb = new ExcelJS.Workbook()
  // ExcelJS otherwise decorates hyperlinked formula cells as hyperlink values
  // and drops their formula/result shape. Imports do not expose link targets,
  // so ignore that decoration and retain the underlying formula provenance.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer, { ignoreNodes: ['hyperlinks'] })
  const ws = wb.worksheets[0]
  if (!ws) return { headers: [], rows: [] }
  const arrayFormulaRanges: SheetCellRange[] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (worksheetCell) => {
      const value = worksheetCell.value
      if (value === null || typeof value !== 'object' || value instanceof Date) return
      const formula = value as { shareType?: string; ref?: string }
      if (formula.shareType !== 'array' || typeof formula.ref !== 'string') return
      const range = sheetCellRange(formula.ref)
      if (range) arrayFormulaRanges.push(range)
    })
  })
  const scalar = (v: unknown): string | number => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return v
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return typeof v === 'string' ? v : String(v)
  }
  const cell = (v: ExcelJS.CellValue, inArrayFormula: boolean): SheetCellValue => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') {
      const o = v as {
        text?: string
        result?: unknown
        hyperlink?: string
        formula?: string
        sharedFormula?: string
      }
      if (typeof o.formula === 'string' || typeof o.sharedFormula === 'string') {
        return { kind: 'formula', value: scalar(o.result) }
      }
      if (inArrayFormula) return { kind: 'formula', value: scalar(v) }
      if (typeof o.text === 'string') return o.text
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      return ''
    }
    if (inArrayFormula) return { kind: 'formula', value: scalar(v) }
    return scalar(v)
  }
  const matrix: SheetCellValue[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[] // 1-based; index 0 is null
    matrix.push(values.slice(1).map((value, index) => {
      const column = index + 1
      const inArrayFormula = arrayFormulaRanges.some(
        (range) =>
          row.number >= range.top &&
          row.number <= range.bottom &&
          column >= range.left &&
          column <= range.right,
      )
      return cell(value, inArrayFormula)
    }))
  })
  const headers = (matrix.shift() ?? []).map((h) =>
    String(isSheetFormulaCellValue(h) ? h.value : h).trim(),
  )
  return { headers, rows: matrix }
}

// --- financial-statement workbook (proper indentation + styled totals) ------

export type StatementSheetColumn = { label: string; kind: 'amount' | 'variance_abs' | 'variance_pct' }
export type StatementSheetRow = {
  kind: 'section' | 'account' | 'subtotal' | 'total'
  label: string
  /** Account-tree depth (real Excel indentation is applied from this). */
  indent?: number
  /** Column-aligned values; null renders blank. Exact decimal strings preserve
   *  financial precision through aggregation; they are written as numeric cells. */
  values?: (number | string | null)[]
}
export type StatementSheet = {
  company: string
  title: string
  periodPhrase: string
  note?: string
  accountLabel: string
  columns: StatementSheetColumn[]
  rows: StatementSheetRow[]
}

const AMOUNT_FMT = '#,##0.00;(#,##0.00)'
const PCT_FMT = '0.0"%";(0.0"%")'
const RULE = 'ffb0b6be'

/**
 * A financial statement as a properly-formatted .xlsx: a centred 3-line title
 * block, a frozen bold header, section headers, account rows indented by their
 * tree depth (real Excel indent, not leading spaces), and subtotal/total rows
 * that are bold with a rule above (and a double rule below the grand total).
 * Numbers use an accounting format (negatives in parentheses).
 */
export async function statementSheetToXlsx(
  sheet: StatementSheet,
  opts: { generatedAt?: Date } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'openbooks'
  const now = opts.generatedAt ?? new Date()
  wb.created = now
  wb.modified = now

  const nCols = sheet.columns.length
  const lastCol = nCols + 1 // col 1 is the account/description column
  const ws = wb.addWorksheet(truncate(sanitizeSheetName(sheet.title), MAX_SHEET_NAME), {
    views: [{ state: 'frozen', ySplit: 5 }],
  })

  // Title block (rows 1-3, centred across the used columns).
  const centre = (row: number, text: string, fmt: { bold?: boolean; size?: number; muted?: boolean }) => {
    ws.mergeCells(row, 1, row, lastCol)
    const cell = ws.getCell(row, 1)
    cell.value = text
    cell.alignment = { horizontal: 'center' }
    cell.font = { bold: fmt.bold, size: fmt.size, color: fmt.muted ? { argb: 'ff6b7280' } : undefined }
  }
  centre(1, sheet.company, { bold: true, size: 12 })
  centre(2, sheet.title, { bold: true, size: 14 })
  centre(3, sheet.periodPhrase, { muted: true })
  if (sheet.note) centre(4, sheet.note, { muted: true })

  // Header row (row 5): blank account column + right-aligned column labels.
  const headerRow = 5
  ws.getCell(headerRow, 1).value = sheet.accountLabel
  ws.getCell(headerRow, 1).font = { bold: true, color: { argb: 'ff374151' } }
  sheet.columns.forEach((c, i) => {
    const cell = ws.getCell(headerRow, i + 2)
    cell.value = c.label
    cell.font = { bold: true, color: { argb: 'ff374151' } }
    cell.alignment = { horizontal: 'right' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'ffd1d5db' } } }
  })

  let r = headerRow + 1
  for (const row of sheet.rows) {
    const isTotal = row.kind === 'total'
    const isSub = row.kind === 'subtotal'
    const bold = row.kind === 'section' || isSub || isTotal

    const labelCell = ws.getCell(r, 1)
    labelCell.value = row.kind === 'section' ? row.label.toUpperCase() : row.label
    labelCell.font = { bold }
    labelCell.alignment = { indent: row.kind === 'account' ? Math.min(1 + (row.indent ?? 0), 8) : 0 }

    if (row.values) {
      for (let i = 0; i < nCols; i++) {
        const cell = ws.getCell(r, i + 2)
        const v = row.values[i]
        const numeric = v === null || v === undefined ? null : typeof v === 'number' ? (Number.isFinite(v) ? v : null) : (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))
        cell.value = numeric
        cell.numFmt = sheet.columns[i]!.kind === 'variance_pct' ? PCT_FMT : AMOUNT_FMT
        cell.alignment = { horizontal: 'right' }
        cell.font = { bold }
      }
    }

    // Rules on total/subtotal rows, across the value columns.
    if (isSub || isTotal) {
      for (let c = 2; c <= lastCol; c++) {
        const cell = ws.getCell(r, c)
        cell.border = {
          ...(cell.border ?? {}),
          top: { style: 'thin', color: { argb: RULE } },
          ...(isTotal ? { bottom: { style: 'double', color: { argb: RULE } } } : {}),
        }
      }
    }
    r++
  }

  ws.getColumn(1).width = 46
  for (let i = 2; i <= lastCol; i++) ws.getColumn(i).width = 16

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer)
}

function setCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: string,
  fmt: { bold?: boolean; italic?: boolean; muted?: boolean; size?: number },
): void {
  const cell = ws.getCell(row, col)
  cell.value = value
  cell.font = {
    bold: fmt.bold,
    italic: fmt.italic,
    size: fmt.size,
    color: fmt.muted ? { argb: 'ff6b7280' } : undefined,
  }
}

/**
 * Make a group title legal as an Excel sheet name: Excel forbids * ? : \ / [ ]
 * (ExcelJS throws on them — and the executor's default section title is
 * "<column>: <value>", so every sectioned export hits the colon), plus leading/
 * trailing apostrophes and empty names.
 */
function sanitizeSheetName(desired: string): string {
  const cleaned = desired
    .replace(/[*?:\\/[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
  return cleaned || 'Sheet'
}

function uniqueSheetName(desired: string, used: Set<string>): string {
  let name = desired || 'Sheet'
  let n = 2
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${n}`
    name = truncate(desired, MAX_SHEET_NAME - suffix.length) + suffix
    n++
  }
  used.add(name.toLowerCase())
  return name
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}
