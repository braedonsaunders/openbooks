// Financial-statement PDF renderer — a "serious", audit-grade statement, as
// opposed to the generic zebra-striped table renderer in document.ts. Applies
// professional conventions: a 3-line centred header (Company / Statement /
// period phrase), negatives in parentheses, currency symbol only on the first
// row and on total rows, a dash for zero, thousands separators, single rule
// above subtotals + double rule below grand totals, and account-hierarchy
// indentation. Two themes chosen by the tenant: `formal` (serif, greyscale,
// classic GAAP) and `modern` (sans + brand accent + logo).

import PDFDocument from 'pdfkit'
import { DEFAULT_PRIMARY_COLOR, type PdfBranding, type PdfPageSetup } from './types'
import { resolvePage } from './page'

export type StatementPdfColumnKind = 'amount' | 'variance_abs' | 'variance_pct'
export type StatementPdfColumn = { label: string; kind: StatementPdfColumnKind }
export type StatementPdfRow = {
  kind: 'section' | 'account' | 'subtotal' | 'total'
  label: string
  /** Account-tree depth for indentation (description column only). */
  indent?: number
  /** Column-aligned values; null/undefined renders blank. Percentages are raw
   *  (e.g. -83.4 → "(83.4%)"); amounts should already be scaled by the caller.
   *  Exact decimal strings preserve financial precision end-to-end. */
  values?: (string | null | undefined)[]
}

export type StatementPdfStyle = 'formal' | 'modern'

export type StatementPdfInput = {
  companyName: string
  title: string
  periodPhrase: string
  /** e.g. "In thousands" — printed under the header. */
  scaleNote?: string
  /** Decimal places for amount columns (0 when scaled; omitted uses the currency's ISO minor units). */
  decimals?: number
  /** BCP 47 display locale and ISO 4217 statement currency. */
  locale: string
  currency: string
  columns: StatementPdfColumn[]
  rows: StatementPdfRow[]
  style: StatementPdfStyle
  branding: PdfBranding
  page: PdfPageSetup
  generatedAt: Date
  /** Optional footnote line (e.g. rounding note). */
  footnote?: string
}

type Theme = {
  font: string
  fontBold: string
  fontItalic: string
  text: string
  muted: string
  rule: string
  accent: string
}

function themeFor(style: StatementPdfStyle, primary: string): Theme {
  if (style === 'formal') {
    return {
      font: 'Times-Roman',
      fontBold: 'Times-Bold',
      fontItalic: 'Times-Italic',
      text: '#1a1a1a',
      muted: '#555555',
      rule: '#1a1a1a',
      accent: '#1a1a1a',
    }
  }
  return {
    font: 'Helvetica',
    fontBold: 'Helvetica-Bold',
    fontItalic: 'Helvetica-Oblique',
    text: '#111827',
    muted: '#6b7280',
    rule: '#9ca3af',
    accent: primary,
  }
}

const DASH = '–'
const LOGO_H = 32

function decodeDataUrl(url: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(url)
  if (!m) return null
  try {
    return Buffer.from(m[1]!, 'base64')
  } catch {
    return null
  }
}

function numericValue(v: number | string): number | string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const exact = v.trim()
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(exact) ? exact : null
}

function isNegativeValue(v: number | string): boolean {
  return typeof v === 'number' ? v < 0 : v.trim().startsWith('-')
}

function absString(v: number | string): number | string {
  return typeof v === 'number' ? Math.abs(v) : v.trim().replace(/^[-+]/, '')
}

function belowEps(v: number | string, resolvedDigits: number): boolean {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && Math.abs(n) < 0.5 * 10 ** -resolvedDigits
}

function formatValue(
  v: number | string | null | undefined,
  kind: StatementPdfColumnKind,
  decimals: number | undefined,
  locale: string,
  currency: string,
  showCurrency: boolean,
): string {
  if (v === null || v === undefined) return ''
  const numeric = numericValue(v)
  if (numeric === null) return DASH
  if (kind === 'variance_pct') {
    const pct = typeof numeric === 'number' ? numeric : Number(numeric)
    if (!Number.isFinite(pct)) return DASH
    const s = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(pct) / 100)
    return pct < 0 ? `(${s})` : s
  }
  const currencyOptions: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    currencySign: 'accounting',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }
  const resolvedDigits = new Intl.NumberFormat(locale, currencyOptions).resolvedOptions().maximumFractionDigits ?? 2
  if (belowEps(numeric, resolvedDigits)) return DASH
  // Intl accepts string mathematical values, preserving precision beyond 2^53.
  if (showCurrency) return new Intl.NumberFormat(locale, currencyOptions).format(numeric as never)
  const abs = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals ?? resolvedDigits,
    maximumFractionDigits: decimals ?? resolvedDigits,
  }).format(absString(numeric) as never)
  return isNegativeValue(numeric) ? `(${abs})` : abs
}

/** Render a financial statement to a PDF Buffer. */
export async function renderStatementPdf(input: StatementPdfInput): Promise<Buffer> {
  const page = resolvePage(input.page)
  const primary = input.branding.primaryColor || DEFAULT_PRIMARY_COLOR
  const theme = themeFor(input.style, primary)
  const decimals = input.decimals
  const locale = input.locale
  const currency = input.currency
  const dense = input.page.density === 'compact'
  const sz = { title: dense ? 15 : 18, company: dense ? 11 : 13, meta: dense ? 8.5 : 9.5, body: dense ? 8.5 : 9.5 }
  const rowPadY = dense ? 3 : 4.5

  const doc = new PDFDocument({
    bufferPages: true,
    size: [page.width, page.height],
    margins: { top: page.margin, bottom: page.margin, left: page.margin, right: page.margin },
    info: { Title: input.title, Author: input.companyName, Subject: input.periodPhrase, Creator: 'openbooks' },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Uint8Array) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))

  // --- Column geometry --------------------------------------------------------
  // Value columns are measured, not split equally: each column gets the width
  // of its widest content (header label + every formatted cell) at the body
  // size, so a 12-column statement cannot overlap its neighbours the way an
  // equal split does. When the measured need exceeds the page, the
  // description column shrinks to its floor and the body size steps down to
  // its floor; past that the render is refused by name instead of printing
  // overlapping amounts that read as wrong numbers.
  const nCols = input.columns.length
  const cellPad = 5
  const DESC_FLOOR = 100
  const BODY_SIZE_FLOOR = 7

  // Pre-pass: per-row currency flags (the E25 amount-column rule) and the
  // formatted cell text the measurement below needs.
  type FittedRow = { row: StatementPdfRow; showCurrency: boolean; cells: string[] }
  const fittedRows: FittedRow[] = []
  {
    let firstAmountRowDone = false
    for (const row of input.rows) {
      if (row.kind === 'section') {
        fittedRows.push({ row, showCurrency: false, cells: [] })
        continue
      }
      const isTotalish = row.kind === 'subtotal' || row.kind === 'total'
      const showCurrency = isTotalish || !firstAmountRowDone
      const cells = input.columns.map((column, i) =>
        formatValue(row.values?.[i], column.kind, decimals, locale, currency, showCurrency),
      )
      fittedRows.push({ row, showCurrency, cells })
      if (
        row.values?.some(
          (v, i) =>
            input.columns[i]?.kind !== 'variance_pct' &&
            (typeof v === 'number' || typeof v === 'string'),
        )
      ) {
        firstAmountRowDone = true
      }
    }
  }

  const baseDescW = Math.max(160, Math.min(page.contentWidth * 0.4, page.contentWidth - nCols * 62))
  let bodySize = sz.body
  let descW = baseDescW
  let colW: number[] = []
  doc.font(theme.fontBold)
  for (let sizeTenths = Math.round(sz.body * 10); sizeTenths >= Math.round(BODY_SIZE_FLOOR * 10); sizeTenths -= 5) {
    const size = sizeTenths / 10
    doc.fontSize(size)
    const needs = input.columns.map((column, i) => {
      let need = doc.widthOfString(column.label) + cellPad
      for (const fitted of fittedRows) {
        const w = doc.widthOfString(fitted.cells[i] ?? '') + cellPad
        if (w > need) need = w
      }
      return need
    })
    const needTotal = needs.reduce((a, b) => a + b, 0)
    let d = baseDescW
    if (d + needTotal > page.contentWidth) d = Math.max(DESC_FLOOR, page.contentWidth - needTotal)
    if (d + needTotal <= page.contentWidth) {
      bodySize = size
      descW = d
      // Slack is distributed in proportion to need, so every column keeps at
      // least its measured width (never overlaps) while the common
      // equal-content case reproduces the old equal split exactly.
      const avail = page.contentWidth - d
      colW = needTotal === 0 ? needs.map(() => avail / Math.max(1, nCols)) : needs.map((n) => (n / needTotal) * avail)
      break
    }
  }
  if (nCols > 0 && colW.length === 0) {
    throw new Error(
      `Too many columns (${nCols}) to print legibly on ${input.page.paperSize} ${input.page.orientation} — use fewer columns, landscape, or a larger paper size.`,
    )
  }
  const colX: number[] = []
  {
    let x = page.contentLeft + descW
    for (const w of colW) {
      colX.push(x)
      x += w
    }
  }
  const valX = (i: number): number => colX[i] ?? page.contentLeft + descW

  // --- Header (3-line centred stack) -----------------------------------------
  let y = page.contentTop
  const logoBuf = input.branding.logoBuffer ?? (input.branding.logoUrl ? decodeDataUrl(input.branding.logoUrl) : null)
  if (input.style === 'modern' && logoBuf) {
    try {
      doc.image(logoBuf, page.contentLeft, y, { fit: [LOGO_H * 1.8, LOGO_H] })
    } catch {
      /* invalid image — ignore */
    }
  }
  doc.font(theme.fontBold).fontSize(sz.company).fillColor(theme.text)
  doc.text(input.companyName, page.contentLeft, y, { width: page.contentWidth, align: 'center' })
  doc.font(theme.fontBold).fontSize(sz.title).fillColor(theme.text)
  doc.text(input.title, page.contentLeft, doc.y + 1, { width: page.contentWidth, align: 'center' })
  doc.font(theme.font).fontSize(sz.meta).fillColor(theme.muted)
  doc.text(input.periodPhrase, page.contentLeft, doc.y + 1, { width: page.contentWidth, align: 'center' })
  if (input.scaleNote) {
    doc.font(theme.fontItalic).fontSize(sz.meta - 0.5).fillColor(theme.muted)
    doc.text(input.scaleNote, page.contentLeft, doc.y + 1, { width: page.contentWidth, align: 'center' })
  }
  y = doc.y + 6
  doc
    .moveTo(page.contentLeft, y)
    .lineTo(page.contentLeft + page.contentWidth, y)
    .lineWidth(input.style === 'modern' ? 2 : 1)
    .strokeColor(theme.accent)
    .stroke()
  y += 8

  // --- Column header ----------------------------------------------------------
  const drawColumnHeader = (): void => {
    doc.font(theme.fontBold).fontSize(bodySize).fillColor(theme.text)
    for (let i = 0; i < nCols; i++) {
      doc.text(input.columns[i]!.label, valX(i), y, {
        width: (colW[i] ?? 0) - cellPad,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      })
    }
    y = doc.y + 2
    doc.moveTo(page.contentLeft, y).lineTo(page.contentLeft + page.contentWidth, y).lineWidth(0.8).strokeColor(theme.rule).stroke()
    y += rowPadY
  }
  drawColumnHeader()

  const valuesRightEdge = page.contentLeft + page.contentWidth
  const valuesLeftEdge = page.contentLeft + descW + cellPad

  const ensureSpace = (rowH: number) => {
    if (y + rowH > page.contentBottom) {
      doc.addPage()
      y = page.contentTop
      drawColumnHeader()
    }
  }

  // --- Body rows --------------------------------------------------------------
  // Cells reuse the pre-pass formatting (and its currency flags), so the
  // measurement above and the printed bytes can never disagree.
  for (const fitted of fittedRows) {
    const row = fitted.row
    doc.fontSize(bodySize)
    const isTotalish = row.kind === 'subtotal' || row.kind === 'total'
    const bold = row.kind === 'section' || isTotalish
    doc.font(bold ? theme.fontBold : theme.font)
    const rowH = doc.currentLineHeight() + rowPadY

    if (row.kind === 'section') {
      ensureSpace(rowH + 2)
      y += 2
      doc.fillColor(theme.text).text(row.label.toUpperCase(), page.contentLeft, y, { width: descW })
      y = doc.y + rowPadY
      continue
    }

    ensureSpace(rowH + (isTotalish ? 6 : 0))
    // Single rule above subtotals/totals, across the value columns.
    if (isTotalish) {
      doc.moveTo(valuesLeftEdge - cellPad, y).lineTo(valuesRightEdge, y).lineWidth(0.7).strokeColor(theme.rule).stroke()
      y += 2
    }
    const indent = (row.indent ?? 0) * 12
    doc.font(bold ? theme.fontBold : theme.font).fillColor(theme.text)
    doc.text(row.label, page.contentLeft + indent, y, { width: descW - indent, lineBreak: false, ellipsis: true })

    for (let i = 0; i < nCols; i++) {
      const cell = fitted.cells[i] ?? ''
      const rawValue = row.values?.[i]
      const neg = typeof rawValue === 'number' ? rawValue < 0 : typeof rawValue === 'string' && rawValue.trim().startsWith('-')
      doc.fillColor(input.style === 'formal' ? theme.text : neg ? '#b91c1c' : theme.text)
      // Amounts never truncate or wrap: the geometry pre-pass sized every
      // column to its widest content, so an instrumented overflow here would
      // mean the measurement lied — surface it in tests, not in print.
      doc.text(cell, valX(i), y, { width: (colW[i] ?? 0) - cellPad, align: 'right', lineBreak: false })
    }
    y = doc.y + rowPadY

    // Double rule below a grand total.
    if (row.kind === 'total') {
      doc.moveTo(valuesLeftEdge - cellPad, y).lineTo(valuesRightEdge, y).lineWidth(0.7).strokeColor(theme.rule).stroke()
      doc.moveTo(valuesLeftEdge - cellPad, y + 2).lineTo(valuesRightEdge, y + 2).lineWidth(0.7).strokeColor(theme.rule).stroke()
      y += 5
    }
  }

  if (input.footnote) {
    y += 8
    doc.font(theme.fontItalic).fontSize(sz.meta - 1).fillColor(theme.muted)
    doc.text(input.footnote, page.contentLeft, y, { width: page.contentWidth })
  }

  stampFooters(doc, page, input, theme)

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.end()
  })
}

function stampFooters(
  doc: InstanceType<typeof PDFDocument>,
  page: ReturnType<typeof resolvePage>,
  input: StatementPdfInput,
  theme: Theme,
): void {
  const range = doc.bufferedPageRange()
  const footerY = Math.min(page.contentBottom + (page.margin - 10) / 2, page.height - 14)
  const stamp = input.generatedAt.toISOString().slice(0, 10)
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    // The footer sits in the bottom MARGIN band (below contentBottom). Drawing
    // text there makes pdfkit think the page overflowed and auto-insert a new
    // page (one per text call → runaway trailing blank pages). Zeroing the
    // page's bottom margin while stamping lets us write in the band safely.
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font(theme.font).fontSize(8).fillColor(theme.muted)
    doc.text(`${input.companyName} · ${input.title}`, page.contentLeft, footerY, {
      width: page.contentWidth * 0.5,
      align: 'left',
      lineBreak: false,
      ellipsis: true,
    })
    doc.text(`${stamp}    Page ${i - range.start + 1} of ${range.count}`, page.contentLeft + page.contentWidth * 0.5, footerY, {
      width: page.contentWidth * 0.5,
      align: 'right',
      lineBreak: false,
    })
    doc.page.margins.bottom = savedBottom
  }
}
