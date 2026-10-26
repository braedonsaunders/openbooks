// The table renderer: draws a PdfTableGroup into a pdfkit document with
// auto-sized columns, multi-line cell wrapping, zebra rows, a repeated header
// on every continuation page, and manual page-break control. Pure drawing —
// no HTML, no Chromium.
//
// Pagination is fully manual: the renderer tracks the y cursor and, when a
// row would overflow the content area, calls doc.addPage() and re-draws the
// header row at the top. (With bufferPages:true the buffered-page footer
// stamping in document.ts still covers every page this appends.)

import type PDFKit from "pdfkit";
import { createRequire } from "node:module";
import type {
  PdfCellStyle,
  PdfTableCell,
  PdfColumnAlign,
  PdfColumnStyle,
  PdfTableGroup,
  PdfTheme,
} from "./types";
import type { ResolvedPage } from "./page";
import { pdfColor, pdfContrastText, pdfColorTint } from "./color";

const MIN_COL_W = 36;
const MAX_COL_FRAC = 0.62;

export function pdfCellText(cell: PdfTableCell): string {
  return cell == null ? "" : typeof cell === "object" ? cell.text : String(cell);
}

function styledCell(
  cell: PdfTableCell,
): cell is Exclude<PdfTableCell, string | number | null | undefined> {
  return cell !== null && typeof cell === "object";
}

// Use the same Unicode line-break opportunities as PDFKit. The dependency is
// JavaScript-only; keep its boundary typed without replacing its algorithm.
const LineBreaker = createRequire(import.meta.url)("linebreak") as new (text: string) => {
  nextBreak(): { position: number; required: boolean } | null;
};

export class PdfLayoutError extends RangeError {
  readonly status = 422;
  readonly code = "pdf_layout_too_narrow";
  readonly remedy = "Choose a wider page, smaller print density or fewer report columns.";

  constructor() {
    super("The report columns cannot fit legibly on this page.");
    this.name = "PdfLayoutError";
  }
}

function textWidths(
  doc: InstanceType<typeof PDFKit>,
  text: string,
): { preferred: number; minimum: number } {
  let minimum = 0;
  const breaker = new LineBreaker(text);
  let start = 0;
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) {
    minimum = Math.max(minimum, doc.widthOfString(text.slice(start, next.position).trim()));
    start = next.position;
  }
  // Compact identifiers are read and reconciled as a unit, even when Unicode
  // would permit a line break at their hyphen.
  for (const match of text.matchAll(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu)) {
    minimum = Math.max(minimum, doc.widthOfString(match[0]));
  }
  const preferred = Math.max(0, ...text.split(/\r?\n/).map((line) => doc.widthOfString(line)));
  return { preferred, minimum };
}

/** Fill the page while preserving padding and unbroken words in every row. */
export function computeColumnWidths(
  doc: InstanceType<typeof PDFKit>,
  group: PdfTableGroup,
  contentWidth: number,
  theme: PdfTheme,
): number[] {
  const n = group.columns.length;
  if (n === 0) return [];
  const minima: number[] = [];
  const natural: number[] = [];
  for (let i = 0; i < n; i++) {
    let minimum = MIN_COL_W;
    let preferred = MIN_COL_W;
    const measure = (text: string, bold: boolean) => {
      doc.font(bold ? theme.fontBold : theme.font).fontSize(theme.table);
      const measured = textWidths(doc, text);
      // Leave a small tolerance for PDFKit's wrapping arithmetic.
      minimum = Math.max(minimum, measured.minimum + theme.cellPadX * 2 + 0.5);
      preferred = Math.max(preferred, measured.preferred + theme.cellPadX * 2 + 0.5);
    };
    measure(group.columns[i]!, group.columnStyles?.[i]?.header?.bold ?? theme.design !== "modern");
    for (const row of group.rows) {
      const cell = row[i];
      if (styledCell(cell) && cell.segments?.length) {
        for (const segment of cell.segments) measure(segment.text, segment.bold === true);
      } else {
        measure(
          cell == null ? "—" : pdfCellText(cell),
          (styledCell(cell) ? cell.bold : undefined) ??
            group.columnStyles?.[i]?.body?.bold ??
            false,
        );
      }
    }
    minima.push(minimum);
    natural.push(Math.max(minimum, Math.min(preferred, contentWidth * MAX_COL_FRAC)));
  }

  if (group.columnWeights) {
    const weights = group.columnWeights;
    if (weights.length !== n || weights.some((weight) => !Number.isFinite(weight) || weight <= 0))
      throw new RangeError("Report column weights must be positive and match the column count.");
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => (contentWidth * weight) / totalWeight);
    if (widths.some((width, i) => width < minima[i]!)) throw new PdfLayoutError();
    return widths;
  }

  const floor = minima.reduce((sum, width) => sum + width, 0);
  if (floor > contentWidth) throw new PdfLayoutError();
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= contentWidth) {
    return natural.map((width) => width + (contentWidth - total) / n);
  }
  const available = contentWidth - floor;
  const flexible = total - floor;
  return minima.map((minimum, i) => minimum + (available * (natural[i]! - minimum)) / flexible);
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
  if (group.columns.length === 0) return startY;

  const widths = computeColumnWidths(doc, group, page.contentWidth, theme);
  const aligns: PdfColumnAlign[] = group.align ?? group.columns.map(() => "left");
  const colX: number[] = [];
  let x = page.contentLeft;
  for (const w of widths) {
    colX.push(x);
    x += w;
  }

  const headerStyles = group.columns.map((_, i) => ({
    body: { bold: group.columnStyles?.[i]?.header?.bold ?? theme.design !== "modern" },
  }));
  const headerHeight = measureRowHeight(
    doc,
    group.columns,
    widths,
    theme,
    theme.font,
    headerStyles,
  );
  let y = startY;

  const drawHeader = (topY: number) => {
    doc.rect(page.contentLeft, topY, page.contentWidth, headerHeight).fill(theme.headerFill);
    doc.font(theme.fontBold).fontSize(theme.table).fillColor(theme.headerText);
    for (let i = 0; i < group.columns.length; i++) {
      const style = group.columnStyles?.[i]?.header;
      if (style?.backgroundColor)
        doc
          .rect(colX[i]!, topY, widths[i]!, headerHeight)
          .fill(pdfColor(style.backgroundColor, theme.headerFill));
      doc
        .font(
          style?.bold === true || (style?.bold === undefined && theme.design !== "modern")
            ? theme.fontBold
            : theme.font,
        )
        .fontSize(theme.table)
        .fillColor(
          style?.textColor
            ? pdfColor(style.textColor, theme.headerText)
            : style?.backgroundColor
              ? pdfContrastText(style.backgroundColor)
              : theme.headerText,
        );
      const ax = colX[i]! + theme.cellPadX;
      const aw = widths[i]! - theme.cellPadX * 2;
      doc.text(group.columns[i]!, ax, topY + theme.cellPadY, {
        width: aw,
        align: aligns[i] ?? "left",
        lineBreak: true,
      });
    }
    doc
      .moveTo(page.contentLeft, topY + headerHeight)
      .lineTo(page.contentLeft + page.contentWidth, topY + headerHeight)
      .strokeColor(theme.headerBorder)
      .lineWidth(1)
      .stroke();
    return topY + headerHeight;
  };

  // First header.
  y = drawHeader(y);

  if (group.isEmpty || group.rows.length === 0) {
    doc.font(theme.font).fontSize(theme.table).fillColor(theme.empty);
    doc.text("—", page.contentLeft + theme.cellPadX, y + theme.cellPadY, {
      width: page.contentWidth,
      align: "left",
    });
    return y + headerHeight;
  }

  // The tallest a row may render: a fresh page's content area minus the
  // repeated header. Anything taller (e.g. a huge JSON/memo cell) is clamped
  // and the cell text ellipsised — otherwise pdfkit would auto-paginate mid-
  // cell and every later cell of the row would land on the wrong page.
  const sectionHeight =
    group.kind === "section"
      ? doc
          .font(theme.fontBold)
          .fontSize(theme.h2)
          .heightOfString(group.title, { width: page.contentWidth }) + 3
      : 0;
  const maxRowHeight = page.contentBottom - page.contentTop - headerHeight - sectionHeight;

  for (let r = 0; r < group.rows.length; r++) {
    const row = group.rows[r]!;
    const measuredHeight = measureRowHeight(
      doc,
      row,
      widths,
      theme,
      theme.font,
      group.columnStyles,
    );
    // Independently styled observations are indivisible evidence; PDFKit must
    // never auto-paginate one segment while the rest of its row stays behind.
    const exactSegments = row.some((cell) => styledCell(cell) && Boolean(cell.segments?.length));
    if ((group.overflow === "refuse" || exactSegments) && measuredHeight > maxRowHeight)
      throw new RangeError(
        "A report row exceeds the printable page. Choose a wider page, fewer date columns or less detail; no report evidence was truncated.",
      );
    const rowHeight = Math.min(measuredHeight, maxRowHeight);
    // Page break before a row that overflows.
    if (y + rowHeight > page.contentBottom) {
      doc.addPage();
      y = page.contentTop;
      // Section tables can span several pages. Repeat the section identity
      // before the column header so a detached/printed continuation page is
      // still self-describing (particularly important for account-grouped
      // General Ledger exports).
      if (group.kind === "section") {
        doc
          .font(theme.design === "modern" ? theme.font : theme.fontBold)
          .fontSize(theme.h2)
          .fillColor(theme.design === "modern" ? theme.text : theme.primary);
        doc.text(group.title, page.contentLeft, y, {
          width: page.contentWidth,
          lineBreak: true,
        });
        y = doc.y + 3;
      }
      y = drawHeader(y);
    }
    const rowTop = y;
    if (r % 2 === 1) {
      doc.rect(page.contentLeft, rowTop, page.contentWidth, rowHeight).fill(theme.zebra);
    }
    doc.font(theme.font).fontSize(theme.table).fillColor(theme.text);
    // +0.5pt epsilon so a cell whose measured height exactly equals the limit
    // never drops its last line to rounding.
    const cellMaxH = rowHeight - theme.cellPadY * 2 + 0.5;
    for (let i = 0; i < row.length && i < widths.length; i++) {
      const ax = colX[i]! + theme.cellPadX;
      const aw = widths[i]! - theme.cellPadX * 2;
      const v = row[i];
      const base = group.columnStyles?.[i]?.body;
      const style: PdfCellStyle = { ...base, ...(styledCell(v) ? v : {}) };
      const dataColor = styledCell(v) ? v.backgroundColor : undefined;
      const fill = style.backgroundColor
        ? theme.colorTreatment === "subtle" && dataColor
          ? pdfColorTint(style.backgroundColor, theme.colorIntensity)
          : pdfColor(style.backgroundColor, "#ffffff")
        : undefined;
      if (fill) doc.rect(colX[i]!, rowTop, widths[i]!, rowHeight).fill(fill);
      if (dataColor && theme.colorTreatment === "subtle")
        doc
          .rect(colX[i]! + 1, rowTop + 2, 2, Math.max(1, rowHeight - 4))
          .fill(pdfColor(dataColor, "#ffffff"));
      doc
        .font(style.bold ? theme.fontBold : theme.font)
        .fontSize(theme.table)
        .fillColor(
          style.textColor
            ? pdfColor(style.textColor, theme.text)
            : fill
              ? pdfContrastText(fill)
              : theme.text,
        );
      if (styledCell(v) && v.segments?.length) {
        let segmentY = rowTop + theme.cellPadY;
        for (const segment of v.segments) {
          doc.font(segment.bold ? theme.fontBold : theme.font).fontSize(theme.table);
          const textHeight = doc.heightOfString(segment.text, {
            width: aw,
            align: aligns[i] ?? "left",
          });
          const segmentFill = segment.backgroundColor
            ? theme.colorTreatment === "subtle"
              ? pdfColorTint(segment.backgroundColor, theme.colorIntensity)
              : pdfColor(segment.backgroundColor, "#ffffff")
            : fill;
          if (segmentFill)
            doc.rect(colX[i]! + 1, segmentY - 1, widths[i]! - 2, textHeight + 2).fill(segmentFill);
          if (segment.backgroundColor && theme.colorTreatment === "subtle")
            doc
              .rect(colX[i]! + 1, segmentY - 1, 2, textHeight + 2)
              .fill(pdfColor(segment.backgroundColor, "#ffffff"));
          doc.fillColor(
            segment.textColor
              ? pdfColor(segment.textColor, theme.text)
              : segmentFill
                ? pdfContrastText(segmentFill)
                : theme.text,
          );
          doc.text(segment.text, ax, segmentY, {
            width: aw,
            align: aligns[i] ?? "left",
            height: textHeight + 0.5,
            ellipsis: false,
          });
          segmentY += textHeight + theme.cellPadY;
        }
        continue;
      }
      if (v === null || v === undefined) {
        doc.fillColor(theme.empty);
        doc.text("—", ax, rowTop + theme.cellPadY, { width: aw, align: aligns[i] ?? "left" });
        doc.fillColor(theme.text);
      } else {
        doc.text(pdfCellText(v), ax, rowTop + theme.cellPadY, {
          width: aw,
          align: aligns[i] ?? "left",
          height: cellMaxH,
          ellipsis: group.overflow !== "refuse",
        });
      }
    }
    doc
      .moveTo(page.contentLeft, rowTop + rowHeight)
      .lineTo(page.contentLeft + page.contentWidth, rowTop + rowHeight)
      .strokeColor(theme.rowBorder)
      .lineWidth(0.5)
      .stroke();
    y = rowTop + rowHeight;
  }
  return y;
}

/** Max wrapped height of any cell in a row, plus vertical padding. */
function measureRowHeight(
  doc: InstanceType<typeof PDFKit>,
  cells: PdfTableCell[],
  widths: number[],
  theme: PdfTheme,
  font: string,
  columnStyles?: PdfColumnStyle[],
): number {
  doc.font(font).fontSize(theme.table);
  let max = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    const text = pdfCellText(v);
    const w = Math.max(widths[i]! - theme.cellPadX * 2, 1);
    doc
      .font(
        ((styledCell(v) ? v.bold : undefined) ?? columnStyles?.[i]?.body?.bold)
          ? theme.fontBold
          : font,
      )
      .fontSize(theme.table);
    const h =
      styledCell(v) && v.segments?.length
        ? v.segments.reduce((sum, segment, index) => {
            doc.font(segment.bold ? theme.fontBold : font).fontSize(theme.table);
            return (
              sum + doc.heightOfString(segment.text, { width: w }) + (index ? theme.cellPadY : 0)
            );
          }, 0)
        : doc.heightOfString(text, { width: w, align: "left" });
    if (h > max) max = h;
  }
  return max + theme.cellPadY * 2;
}
