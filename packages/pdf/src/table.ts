// The table renderer: draws a PdfTableGroup into a pdfkit document with
// auto-sized columns, multi-line cell wrapping, zebra rows, a repeated header
// on every continuation page, and manual page-break control. Pure drawing —
// no HTML, no Chromium.
//
// Pagination is fully manual: the renderer tracks the y cursor and, when a
// row would overflow the content area, calls doc.addPage() and re-draws the
// header row at the top. (With bufferPages:true the buffered-page footer
// stamping in document.ts still covers every page this appends.)

import type PDFKit from 'pdfkit'
import type { PdfColumnAlign, PdfTableGroup, PdfTheme } from './types'
import type { ResolvedPage } from './page'

const MIN_COL_W = 36
const MAX_COL_FRAC = 0.62

/** Compute column widths (pt) that fill `contentWidth`, with sensible caps. */
export function computeColumnWidths(
  doc: InstanceType<typeof PDFKit>,
  group: PdfTableGroup,
  contentWidth: number,
  theme: PdfTheme,
): number[] {
  const n = group.columns.length
  if (n === 0) return []
  const maxColW = contentWidth * MAX_COL_FRAC
  const natural: number[] = []
  doc.font(theme.fontBold).fontSize(theme.table)
  const sampleRows = group.rows.slice(0, 200)
  for (let i = 0; i < n; i++) {
    let w = doc.widthOfString(group.columns[i]!)
    for (const row of sampleRows) {
      const cell = row[i]
      if (cell === null || cell === undefined) continue
      w = Math.max(w, doc.widthOfString(String(cell)))
    }
    natural[i] = Math.min(Math.max(Math.ceil(w), MIN_COL_W), maxColW)
  }

  let total = natural.reduce((a, b) => a + b, 0)
  if (total <= contentWidth) {
    // Fill the page width by distributing slack evenly.
    const extra = contentWidth - total
    for (let i = 0; i < n; i++) natural[i] = natural[i]! + extra / n
    return natural.map((w) => Math.round(w))
  }

  // Overflow: scale down, then iteratively reclaim slack from columns still
  // above the floor until the total fits (or every column is at the floor).
  const scale = contentWidth / total
  const widths = natural.map((w) => Math.max(w * scale, MIN_COL_W))
  for (let guard = 0; guard < 64; guard++) {
    const sum = widths.reduce((a, b) => a + b, 0)
    if (sum <= contentWidth + 0.5) break
    const shrinkable = widths
      .map((w, i) => ({ i, slack: w - MIN_COL_W }))
      .filter((x) => x.slack > 0.5)
    if (shrinkable.length === 0) break
    const excess = sum - contentWidth
    const slackSum = shrinkable.reduce((a, b) => a + b.slack, 0)
    for (const s of shrinkable) {
      widths[s.i] = Math.max(widths[s.i]! - (excess * s.slack) / slackSum, MIN_COL_W)
    }
  }
  return widths.map((w) => Math.round(Math.max(w, MIN_COL_W)))
}

function cellText(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

/**
 * Render a table group's body (header + rows) starting at `startY`. Handles
 * its own page breaks and re-draws the header on continuation pages. Returns
 * the y cursor after the last row.
 */
export function drawTable(
  doc: InstanceType<typeof PDFKit>,
  page: ResolvedPage,
  group: PdfTableGroup,
  startY: number,
  theme: PdfTheme,
): number {
  if (group.columns.length === 0) return startY

  const widths = computeColumnWidths(doc, group, page.contentWidth, theme)
  const aligns: PdfColumnAlign[] = group.align ?? group.columns.map(() => 'left')
  const colX: number[] = []
  let x = page.contentLeft
  for (const w of widths) {
    colX.push(x)
    x += w
  }

  const headerHeight = measureRowHeight(doc, group.columns, widths, theme, theme.fontBold)
  let y = startY

  const drawHeader = (topY: number) => {
    doc.rect(page.contentLeft, topY, page.contentWidth, headerHeight).fill(theme.headerFill)
    doc.font(theme.fontBold).fontSize(theme.table).fillColor(theme.headerText)
    for (let i = 0; i < group.columns.length; i++) {
      const ax = colX[i]! + theme.cellPadX
      const aw = widths[i]! - theme.cellPadX * 2
      doc.text(group.columns[i]!, ax, topY + theme.cellPadY, {
        width: aw,
        align: 'left',
        lineBreak: true,
      })
    }
    doc
      .moveTo(page.contentLeft, topY + headerHeight)
      .lineTo(page.contentLeft + page.contentWidth, topY + headerHeight)
      .strokeColor(theme.headerBorder)
      .lineWidth(1)
      .stroke()
    return topY + headerHeight
  }

  // First header.
  y = drawHeader(y)

  if (group.isEmpty || group.rows.length === 0) {
    doc.font(theme.font).fontSize(theme.table).fillColor(theme.empty)
    doc.text('—', page.contentLeft + theme.cellPadX, y + theme.cellPadY, {
      width: page.contentWidth,
      align: 'left',
    })
    return y + headerHeight
  }

  // The tallest a row may render: a fresh page's content area minus the
  // repeated header. Anything taller (e.g. a huge JSON/memo cell) is clamped
  // and the cell text ellipsised — otherwise pdfkit would auto-paginate mid-
  // cell and every later cell of the row would land on the wrong page.
  const maxRowHeight = page.contentBottom - page.contentTop - headerHeight

  for (let r = 0; r < group.rows.length; r++) {
    const row = group.rows[r]!
    const rowHeight = Math.min(measureRowHeight(doc, row, widths, theme, theme.font), maxRowHeight)
    // Page break before a row that overflows.
    if (y + rowHeight > page.contentBottom) {
      doc.addPage()
      y = page.contentTop
      // Section tables can span several pages. Repeat the section identity
      // before the column header so a detached/printed continuation page is
      // still self-describing (particularly important for account-grouped
      // General Ledger exports).
      if (group.kind === 'section') {
        doc.font(theme.fontBold).fontSize(theme.h2).fillColor(theme.primary)
        doc.text(group.title, page.contentLeft, y, {
          width: page.contentWidth,
          lineBreak: true,
        })
        y = doc.y + 3
      }
      y = drawHeader(y)
    }
    const rowTop = y
    if (r % 2 === 1) {
      doc.rect(page.contentLeft, rowTop, page.contentWidth, rowHeight).fill(theme.zebra)
    }
    doc.font(theme.font).fontSize(theme.table).fillColor(theme.text)
    // +0.5pt epsilon so a cell whose measured height exactly equals the limit
    // never drops its last line to rounding.
    const cellMaxH = rowHeight - theme.cellPadY * 2 + 0.5
    for (let i = 0; i < row.length && i < widths.length; i++) {
      const ax = colX[i]! + theme.cellPadX
      const aw = widths[i]! - theme.cellPadX * 2
      const v = row[i]
      if (v === null || v === undefined) {
        doc.fillColor(theme.empty)
        doc.text('—', ax, rowTop + theme.cellPadY, { width: aw, align: aligns[i] ?? 'left' })
        doc.fillColor(theme.text)
      } else {
        doc.text(String(v), ax, rowTop + theme.cellPadY, {
          width: aw,
          align: aligns[i] ?? 'left',
          height: cellMaxH,
          ellipsis: true,
        })
      }
    }
    doc
      .moveTo(page.contentLeft, rowTop + rowHeight)
      .lineTo(page.contentLeft + page.contentWidth, rowTop + rowHeight)
      .strokeColor(theme.rowBorder)
      .lineWidth(0.5)
      .stroke()
    y = rowTop + rowHeight
  }
  return y
}

/** Max wrapped height of any cell in a row, plus vertical padding. */
function measureRowHeight(
  doc: InstanceType<typeof PDFKit>,
  cells: (string | number | null | undefined)[],
  widths: number[],
  theme: PdfTheme,
  font: string,
): number {
  doc.font(font).fontSize(theme.table)
  let max = 0
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    const text = v === null || v === undefined ? '' : String(v)
    const w = Math.max(widths[i]! - theme.cellPadX * 2, 1)
    const h = doc.heightOfString(text, { width: w, align: 'left' })
    if (h > max) max = h
  }
  return max + theme.cellPadY * 2
}
