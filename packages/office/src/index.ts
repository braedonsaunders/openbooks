// @openbooks/office — tabular export utilities. Server-only (ExcelJS is a
// Node library). The web layer imports export helpers from here so the
// client-importable @openbooks/reports barrel never pulls ExcelJS into the
// browser bundle.
//
// CSV stays implemented in @openbooks/reports (pure string building) and is
// re-exported here so callers have a single import surface for tabular export.

import ExcelJS from 'exceljs'
import { Writable } from 'node:stream'
import {
  reportResultToCsv as _reportResultToCsv,
  type ReportRunResult,
} from '@openbooks/reports'

/**
 * Escape one CSV cell — intentionally the same five lines as csvEscape in
 * @openbooks/reports/run.ts (which stays private there). The page-streaming
 * writer must compose guard+escape per field to stay byte-identical to
 * reportResultToCsv, and cross-package test topology resolves @openbooks/*
 * from the pick target, so the writer cannot import a new export until it is
 * picked. streaming-export.test.ts pins byte-identity against the buffered
 * builder, so any drift fails loudly.
 */
function csvEscape(v: string | number | null | undefined): string {
  if (v === null || typeof v === 'undefined') return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export type { ReportRunResult } from '@openbooks/reports'

// --- CSV formula-injection guard ---------------------------------------------
// Excel/Sheets execute cells beginning with = + - @ (and tab/CR can smuggle a
// prefix past naive parsers). Report data contains user-authored strings
// (party names, memos, …), so every string cell is neutralised with a leading
// apostrophe before serialization. Purely-numeric strings (e.g. "-12.5") are
// exempt — spreadsheets parse them as numbers, never as formulas.

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/

/** Neutralise one CSV cell against formula injection. Exported for the
 *  page-streaming CSV writer so chunked output guards exactly like
 *  {@link reportResultToCsv}. */
export function guardCsvCell<T extends string | number | null | undefined>(v: T): T | string {
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

/** Display length of one export cell for column-width measurement: nulls and
 *  objects contribute nothing, everything else its string form. Shared by the
 *  buffered builder (which measures assigned cells) and the streaming writer
 *  (whose pre-pass measures raw page cells it immediately releases). */
export function xlsxExportCellLength(v: unknown): number {
  const s = v === null || v === undefined || typeof v === 'object' ? '' : String(v)
  return s.length
}

/** Column width for a measured max length — the one house formula. */
export function xlsxColumnWidth(maxLen: number): number {
  return Math.min(Math.max(Math.ceil(maxLen * 1.1) + 2, MIN_COL_WIDTH), MAX_COL_WIDTH)
}

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
      let maxLen = xlsxExportCellLength(ws.getCell(headerRowNum, i).value)
      for (let r = headerRowNum + 1; r <= sampleEnd; r++) {
        const len = xlsxExportCellLength(ws.getCell(r, i).value)
        if (len > maxLen) maxLen = len
      }
      ws.getColumn(i).width = xlsxColumnWidth(maxLen)
    }
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer)
}

// --- paged (streaming) export --------------------------------------------------
// The definitions export route streams paged-entity results page by page so a
// large export never materialises every row: each page is serialised and then
// released, and only output bytes accumulate (bounded by the export row cap).
// Cell handling mirrors the buffered builders exactly — guardCsvCell/csvEscape
// per CSV field, the same title block/header/number styles, sheet names, and
// width formula per XLSX sheet — so a small-fixture streamed file matches the
// old path (byte-identical CSV, content-identical XLSX), proven in
// index.test.ts. A caller feeds pages in offset order; for CSV the writer
// files each page group under its caller-assigned merged-order slot and
// assembles merged order at finish, exactly like mergeReportPages.

export type PagedExportCell = string | number | null | undefined

export type PagedCsvPageGroup = {
  /** Merged-order slot assigned by the caller (0-based, dense). */
  slot: number
  title: string
  columns: string[]
  rows: PagedExportCell[][]
}

export type PagedCsvStream = {
  /** Serialise one page (offset order); the rows are copied to output lines
   *  and may be released by the caller afterwards. */
  pushPage(groups: PagedCsvPageGroup[]): void
  /** Assemble the file: header, per-slot lines in merged order, footers.
   *  Footer rows ride in the last slot with its section prefix, exactly like
   *  exportDataToRunResult appends them to the last group. */
  finish(footers?: PagedExportCell[][]): string
}

/** Incremental CSV serialisation with the exact field composition of
 *  reportResultToCsv (formula guard, then escape). The header's section
 *  column is decided at finish from the final slot count, so grouped and
 *  ungrouped exports both stream in a single page pass. */
export function createPagedCsvStream(opts: { sectionHeader?: string } = {}): PagedCsvStream {
  const sectionHeader = opts.sectionHeader ?? 'Section'
  const slots: { title: string; columns: string[]; lines: string[] }[] = []
  const cell = (v: PagedExportCell): string => csvEscape(guardCsvCell(v))
  return {
    pushPage(groups) {
      for (const group of groups) {
        let slot = slots[group.slot]
        if (!slot) {
          slot = { title: group.title, columns: group.columns, lines: [] }
          slots[group.slot] = slot
        }
        for (const row of group.rows) {
          slot.lines.push(row.map(cell).join(','))
        }
      }
    },
    finish(footers = []) {
      const ordered = slots.filter((slot) => slot !== undefined)
      const multi = ordered.length > 1
      const header = [...(multi ? [cell(sectionHeader)] : []), ...(ordered[0]?.columns.map(cell) ?? [])].join(',')
      const lines = [header]
      for (const slot of ordered) {
        const prefix = multi ? `${cell(slot.title)},` : ''
        for (const line of slot.lines) lines.push(`${prefix}${line}`)
      }
      if (footers.length > 0) {
        const prefix = multi ? `${cell(ordered[ordered.length - 1]!.title)},` : ''
        for (const footer of footers) lines.push(`${prefix}${footer.map(cell).join(',')}`)
      }
      return `${lines.join('\r\n')}\r\n`
    },
  }
}

export type StreamingXlsxGroup = {
  title: string
  subtitle?: string
  columns: string[]
  /** Pre-measured widths from xlsxColumnWidth (header + first 400 data cells). */
  widths: number[]
}

export type StreamingXlsxWriter = {
  /** Append page rows to one pre-declared sheet (merged-order slot); the rows
   *  are written to the workbook stream and may be released afterwards. */
  appendRows(groupIndex: number, rows: PagedExportCell[][]): void
  finish(): Promise<Buffer>
}

const XLSX_NUMBER_FORMAT = '#,##0.00;(#,##0.00)'
const XLSX_HEADER_ROW = 4

/**
 * Incremental .xlsx twin of reportResultToXlsx over ExcelJS's streaming
 * writer: one sheet per merged-order group with the same title block, frozen
 * header, number formats, and pre-measured widths. Groups (with total-count
 * subtitles and widths) come from the caller's metadata pre-pass; data rows
 * stream in afterwards page by page.
 */
export function createStreamingXlsxExport(opts: {
  reportName: string
  dateRangeLabel?: string
  generatedAt?: Date
  groups: StreamingXlsxGroup[]
}): StreamingXlsxWriter {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true })
  wb.creator = 'openbooks'
  const now = opts.generatedAt ?? new Date()
  wb.created = now
  wb.modified = now

  const declared = opts.groups.length > 0
    ? opts.groups
    : [{ title: opts.reportName, columns: [] as string[], widths: [] as number[] }]
  const usedNames = new Set<string>()
  const sheets = declared.map((group, index) => {
    const desired = opts.groups.length > 1 ? group.title : opts.reportName
    const sheetName = uniqueSheetName(truncate(sanitizeSheetName(desired), MAX_SHEET_NAME), usedNames)
    const ws = wb.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: XLSX_HEADER_ROW }],
    })
    setStreamingCell(ws, 1, 1, opts.reportName, { bold: true, size: 13 })
    if (opts.dateRangeLabel) setStreamingCell(ws, 2, 1, opts.dateRangeLabel, { muted: true })
    if (group.subtitle) setStreamingCell(ws, 3, 1, group.subtitle, { muted: true, italic: true })
    group.columns.forEach((c, i) => {
      const cell = ws.getCell(XLSX_HEADER_ROW, i + 1)
      cell.value = c
      cell.font = { bold: true, color: { argb: 'ff374151' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'fff1f5f9' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'ffd1d5db' } } }
      cell.alignment = { horizontal: 'left' }
    })
    group.widths.forEach((width, i) => {
      ws.getColumn(i + 1).width = width
    })
    return { ws, columns: group.columns.length, nextRow: XLSX_HEADER_ROW + 1, index }
  })

  return {
    appendRows(groupIndex, rows) {
      const sheet = sheets[groupIndex]
      if (!sheet) throw new Error(`Streaming XLSX export has no group ${groupIndex}`)
      for (const row of rows) {
        for (let i = 0; i < sheet.columns; i++) {
          const v = row[i]
          const cell = sheet.ws.getCell(sheet.nextRow, i + 1)
          cell.value = v === null || v === undefined ? '' : (v as string | number)
          if (typeof cell.value === 'number') {
            cell.alignment = { horizontal: 'right' }
            cell.numFmt = XLSX_NUMBER_FORMAT
          }
        }
        sheet.nextRow++
      }
    },
    async finish(): Promise<Buffer> {
      await wb.commit()
      return Buffer.concat(chunks)
    },
  }
}

/** Title-block cell for the streaming writer — same literals as setCell. */
function setStreamingCell(
  ws: { getCell(row: number, col: number): { value: unknown; font: unknown } },
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

/**
 * An import cell whose shape the reader does not understand (an Excel error
 * value like #DIV/0!, or a future ExcelJS shape). Carries the cell address
 * so the caller can refuse naming it — importing it as '' would report
 * success while silently dropping a value the user supplied.
 */
export class SheetReadError extends Error {
  readonly address: string
  constructor(address: string, detail: string) {
    super(`cell ${address} ${detail}`)
    this.name = 'SheetReadError'
    this.address = address
  }
}

/** Zero-based column index → Excel letters (0 → A, 27 → AB). */
function columnLabel(index: number): string {
  let label = ''
  let n = index + 1
  while (n > 0) {
    const rest = (n - 1) % 26
    label = String.fromCharCode(65 + rest) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
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
  const cell = (v: ExcelJS.CellValue, inArrayFormula: boolean, address: string): SheetCellValue => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') {
      const o = v as {
        text?: string
        result?: unknown
        hyperlink?: string
        formula?: string
        sharedFormula?: string
        richText?: Array<{ text?: unknown }>
        error?: unknown
      }
      if (typeof o.formula === 'string' || typeof o.sharedFormula === 'string') {
        return { kind: 'formula', value: scalar(o.result) }
      }
      if (inArrayFormula) return { kind: 'formula', value: scalar(v) }
      // Formatted text runs ({ richText: [{ text, font }, …] }) carry no
      // top-level .text — reading only .text imported them as empty.
      if (Array.isArray(o.richText)) {
        return o.richText.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('')
      }
      if (typeof o.text === 'string') return o.text
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      if (typeof o.error === 'string') {
        throw new SheetReadError(address, `holds the spreadsheet error ${o.error} — fix it before importing`)
      }
      throw new SheetReadError(address, 'has a value this import does not understand — remove it before importing')
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
      return cell(value, inArrayFormula, `${columnLabel(index)}${row.number}`)
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
   *  financial precision through aggregation; values that do not fit Excel's
   *  IEEE-754 precision remain text cells in the workbook. */
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
const STATEMENT_SCALE = 10_000n
const MAX_SAFE_STATEMENT_UNITS = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Keep ordinary statement amounts as numeric cells for spreadsheet formulas,
 * but never coerce an exact decimal beyond JavaScript's safe integer range.
 * Excel stores numeric cells as IEEE-754 doubles, so a scaled numeric(19,4)
 * value outside that range would be rounded on export. Such values stay as
 * their original text and therefore remain exact when the workbook is read
 * back or displayed.
 */
function statementCellValue(value: number | string | null | undefined): number | string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  const text = value.trim()
  if (text === '') return null

  // Statement values are canonical numeric(19,4) strings. Preserve any
  // non-canonical text rather than attempting a lossy coercion.
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/)
  if (!match) return value

  const fraction = match[3] ?? ''
  // More than four non-zero fractional places cannot be represented by the
  // ledger domain; retaining the text is the only lossless export.
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) return value

  const units =
    BigInt(match[2]!) * STATEMENT_SCALE + BigInt(fraction.slice(0, 4).padEnd(4, '0') || '0')
  const signedUnits = match[1] === '-' ? -units : units
  if (signedUnits < -MAX_SAFE_STATEMENT_UNITS || signedUnits > MAX_SAFE_STATEMENT_UNITS) return value

  // The scaled integer is safe, so this conversion cannot round the ledger
  // value at its four-decimal precision. Keep the numeric cell behaviour for
  // values that fit within that bound.
  return Number(signedUnits) / Number(STATEMENT_SCALE)
}

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
        // Values produced by the statement engine are exact decimal strings
        // (numeric(19,4)). Keep values whose scaled integer exceeds the exact
        // IEEE-754 range as text; converting those through JavaScript Number
        // can silently round ledger values before Excel sees them. Values that
        // fit in a safe scaled integer retain numeric cells and their existing
        // accounting formatting. Callers that already have a number retain
        // the existing numeric cell behaviour, provided it is finite.
        const value = statementCellValue(v)
        cell.value = value
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
