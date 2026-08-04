// The report-document renderer: takes a PdfDocumentInput and produces a PDF
// Buffer using pdfkit (pure JS, no Chromium). The visual vocabulary includes a
// cover header with organization branding,
// key-figures summary band, one section per group of rows, repeating table
// headers, zebra rows, and "Page X of Y" footers.
//
// Pagination is manual (cursor-driven) so table headers repeat and groups stay
// together with their first rows. Footers are stamped after all content via
// pdfkit's buffered-page range so the total page count is known.

import PDFDocument from 'pdfkit'
import {
  DEFAULT_PRIMARY_COLOR,
  type PdfDensity,
  type PdfDocumentInput,
  type PdfSummaryItem,
  type PdfTableGroup,
  type PdfTheme,
} from './types'
import { resolvePage } from './page'
import { drawTable } from './table'

const STANDARD = {
  body: 10,
  h1: 18,
  meta: 9,
  h2: 11.5,
  subtitle: 9,
  summaryLabel: 8.5,
  summaryValue: 14,
  table: 9.5,
  cellPadX: 6,
  cellPadY: 4,
  groupGap: 20,
  summaryGap: 16,
  coverRuleGap: 14,
}
const COMPACT = {
  body: 9,
  h1: 14,
  meta: 8,
  h2: 10.5,
  subtitle: 8,
  summaryLabel: 8,
  summaryValue: 11.5,
  table: 8.5,
  cellPadX: 5,
  cellPadY: 3,
  groupGap: 14,
  summaryGap: 12,
  coverRuleGap: 10,
}

function themeFor(density: PdfDensity, primary: string): PdfTheme {
  const s = density === 'compact' ? COMPACT : STANDARD
  return {
    primary,
    text: '#111827',
    muted: '#6b7280',
    headerFill: '#f3f4f6',
    headerText: '#374151',
    headerBorder: '#d1d5db',
    rowBorder: '#eef2f7',
    zebra: '#f9fafb',
    empty: '#9ca3af',
    font: 'Helvetica',
    fontBold: 'Helvetica-Bold',
    body: s.body,
    h1: s.h1,
    meta: s.meta,
    h2: s.h2,
    subtitle: s.subtitle,
    table: s.table,
    cellPadX: s.cellPadX,
    cellPadY: s.cellPadY,
    groupGap: s.groupGap,
  }
}

const SUMMARY_GAP = 6
const SUMMARY_MIN_CARD_W = 118
const LOGO_H = 36

function decodeDataUrl(url: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(url)
  if (!m) return null
  try {
    return Buffer.from(m[1], 'base64')
  } catch {
    return null
  }
}

/** Render a report document to a PDF Buffer. */
export async function renderPdfDocument(input: PdfDocumentInput): Promise<Buffer> {
  const layout = input.layout
  const page = resolvePage(layout)
  const primary = input.branding.primaryColor || DEFAULT_PRIMARY_COLOR
  const theme = themeFor(layout.density, primary)
  const s = layout.density === 'compact' ? COMPACT : STANDARD

  const doc = new PDFDocument({
    bufferPages: true,
    size: [page.width, page.height],
    margins: {
      top: page.margin,
      bottom: page.margin,
      left: page.margin,
      right: page.margin,
    },
    info: {
      Title: input.title,
      Author: input.branding.orgName,
      Subject: input.dateRangeLabel,
      Creator: 'openbooks',
    },
  })

  const chunks: Buffer[] = []
  doc.on('data', (c: Uint8Array) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))

  let y = page.contentTop
  y = drawCover(doc, page, input, theme, s)
  if (input.summary && input.summary.length > 0) {
    y = drawSummary(doc, page, input.summary, y, theme, s)
  }

  for (const group of input.groups) {
    y = drawGroup(doc, page, group, y, theme, s)
  }

  stampFooters(doc, page, input)

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.end()
  })
}

function drawCover(
  doc: InstanceType<typeof PDFDocument>,
  page: ReturnType<typeof resolvePage>,
  input: PdfDocumentInput,
  theme: PdfTheme,
  s: typeof STANDARD,
): number {
  const leftW = Math.floor(page.contentWidth * 0.6)
  const rightW = page.contentWidth - leftW
  const leftX = page.contentLeft
  const rightX = page.contentLeft + leftW
  let leftTop = page.contentTop

  const logoBuf = input.branding.logoBuffer ?? (input.branding.logoUrl ? decodeDataUrl(input.branding.logoUrl) : null)
  if (logoBuf) {
    try {
      doc.image(logoBuf, leftX, leftTop, { fit: [LOGO_H * 1.6, LOGO_H] })
      leftTop += LOGO_H + 6
    } catch {
      // Unsupported/invalid image — skip silently; text brand still renders.
    }
  }

  doc.font(theme.fontBold).fontSize(theme.h1).fillColor(theme.text)
  doc.text(input.title, leftX, leftTop, { width: leftW, lineBreak: true })
  const titleBottom = doc.y

  // Right column: org name (bold), date range, generated — right aligned.
  doc.font(theme.fontBold).fontSize(theme.body).fillColor(theme.text)
  doc.text(input.branding.orgName, rightX, page.contentTop, {
    width: rightW,
    align: 'right',
    lineBreak: true,
  })
  doc.font(theme.font).fontSize(theme.meta).fillColor(theme.muted)
  doc.text(input.dateRangeLabel, rightX, doc.y + 2, { width: rightW, align: 'right' })
  doc.text(formatStamp(input.generatedAt), rightX, doc.y + 1, { width: rightW, align: 'right' })
  const rightBottom = doc.y

  const headerBottom = Math.max(titleBottom, rightBottom) + s.coverRuleGap
  doc
    .moveTo(page.contentLeft, headerBottom)
    .lineTo(page.contentLeft + page.contentWidth, headerBottom)
    .lineWidth(3)
    .strokeColor(theme.primary)
    .stroke()
  return headerBottom + s.coverRuleGap
}

function drawSummary(
  doc: InstanceType<typeof PDFDocument>,
  page: ReturnType<typeof resolvePage>,
  summary: PdfSummaryItem[],
  startY: number,
  theme: PdfTheme,
  s: typeof STANDARD,
): number {
  const n = summary.length
  const perRow = Math.max(1, Math.min(n, Math.floor(page.contentWidth / SUMMARY_MIN_CARD_W)))
  const cardW = (page.contentWidth - SUMMARY_GAP * (perRow - 1)) / perRow
  const padX = 9
  const padY = 7
  const accentW = 3

  let y = startY
  let rowStart = 0
  while (rowStart < n) {
    const rowItems = summary.slice(rowStart, rowStart + perRow)
    let cardH = 0
    for (const item of rowItems) {
      doc.font(theme.font).fontSize(s.summaryLabel)
      const lh = doc.heightOfString(item.label, { width: cardW - padX * 2 - accentW })
      doc.font(theme.fontBold).fontSize(s.summaryValue)
      const vh = doc.heightOfString(String(item.value), { width: cardW - padX * 2 - accentW })
      cardH = Math.max(cardH, lh + 2 + vh + padY * 2)
    }
    if (y + cardH > page.contentBottom) {
      doc.addPage()
      y = page.contentTop
    }
    let x = page.contentLeft
    for (const item of rowItems) {
      doc.rect(x, y, cardW, cardH).fill('#fafafa')
      doc.rect(x, y, accentW, cardH).fill(theme.primary)
      doc.rect(x, y, cardW, cardH).lineWidth(0.5).strokeColor('#e5e7eb').stroke()
      doc.font(theme.font).fontSize(s.summaryLabel).fillColor(theme.muted)
      const labelW = cardW - padX * 2 - accentW
      // Measure the (possibly wrapped) label so the value never overlaps a
      // multi-line label; cardH above was sized from this same measurement.
      const labelH = doc.heightOfString(item.label, { width: labelW })
      doc.text(item.label, x + accentW + padX, y + padY, {
        width: labelW,
        lineBreak: true,
      })
      doc.font(theme.fontBold).fontSize(s.summaryValue).fillColor(theme.text)
      doc.text(String(item.value), x + accentW + padX, y + padY + labelH + 2, {
        width: labelW,
        lineBreak: true,
      })
      x += cardW + SUMMARY_GAP
    }
    y += cardH + SUMMARY_GAP
    rowStart += perRow
  }
  return y + s.summaryGap - SUMMARY_GAP
}

function drawGroup(
  doc: InstanceType<typeof PDFDocument>,
  page: ReturnType<typeof resolvePage>,
  group: PdfTableGroup,
  startY: number,
  theme: PdfTheme,
  s: typeof STANDARD,
): number {
  // Keep the title with its header row: if the title + subtitle + header don't
  // fit, push the whole group to a fresh page.
  doc.font(theme.fontBold).fontSize(theme.table)
  const headerH = group.columns.length > 0 ? estimateHeaderHeight(doc, group, page, theme) : 0
  const titleH = theme.h2 + 6
  const subH = group.subtitle ? theme.subtitle + 4 : 0
  if (startY + titleH + subH + headerH > page.contentBottom && startY > page.contentTop) {
    doc.addPage()
    startY = page.contentTop
  }

  let y = startY
  doc.font(theme.fontBold).fontSize(theme.h2).fillColor(theme.primary)
  doc.text(group.title, page.contentLeft, y, { width: page.contentWidth, lineBreak: true })
  y = doc.y + 2
  doc
    .moveTo(page.contentLeft, y)
    .lineTo(page.contentLeft + page.contentWidth, y)
    .lineWidth(1)
    .strokeColor('#d1d5db')
    .stroke()
  y += 3
  if (group.subtitle) {
    doc.font(theme.font).fontSize(theme.subtitle).fillColor(theme.muted)
    doc.text(group.subtitle, page.contentLeft, y, { width: page.contentWidth })
    y = doc.y + 2
  }
  y = drawTable(doc, page, group, y, theme)
  return y + s.groupGap
}

function estimateHeaderHeight(
  doc: InstanceType<typeof PDFDocument>,
  group: PdfTableGroup,
  page: ReturnType<typeof resolvePage>,
  theme: PdfTheme,
): number {
  // Cheap upper bound for the keep-with-next check: a single header line per
  // column at table size + padding.
  doc.font(theme.fontBold).fontSize(theme.table)
  let maxLine = 0
  for (const c of group.columns) {
    maxLine = Math.max(maxLine, doc.heightOfString(c, { width: page.contentWidth / group.columns.length }))
  }
  return maxLine + theme.cellPadY * 2
}

function stampFooters(
  doc: InstanceType<typeof PDFDocument>,
  page: ReturnType<typeof resolvePage>,
  input: PdfDocumentInput,
): void {
  const range = doc.bufferedPageRange()
  const total = range.count
  const footerY = Math.min(page.contentBottom + (page.margin - 10) / 2, page.height - 14)
  const leftW = Math.floor(page.contentWidth * 0.4)
  const centerW = Math.floor(page.contentWidth * 0.2)
  const rightW = page.contentWidth - leftW - centerW
  const leftText = input.footerLeft ?? `${input.branding.orgName} · ${input.title}`
  const rightText = input.footerRight ?? formatStamp(input.generatedAt)

  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i)
    // PDFKit normally treats the bottom margin as a hard text boundary. A
    // footer intentionally lives inside that margin, so temporarily release
    // it or `text()` silently appends a new blank page while stamping.
    const bottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    const n = i - range.start + 1
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
    doc.text(leftText, page.contentLeft, footerY, {
      width: leftW,
      align: 'left',
      lineBreak: false,
      ellipsis: true,
    })
    doc.text(`Page ${n} of ${total}`, page.contentLeft + leftW, footerY, {
      width: centerW,
      align: 'center',
      lineBreak: false,
    })
    doc.text(rightText, page.contentLeft + leftW + centerW, footerY, {
      width: rightW,
      align: 'right',
      lineBreak: false,
      ellipsis: true,
    })
    doc.page.margins.bottom = bottomMargin
  }
}

function formatStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}
