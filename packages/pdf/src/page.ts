// Page geometry: paper dimensions in PostScript points and mm→pt conversion.
// pdfkit itself accepts `size`/`layout` keywords, but the renderer needs the
// raw point dimensions for cursor math (column widths, row wrapping, footers).

import type { PdfPageSetup, PdfPaperSize } from './types'

/** 1 millimetre in PostScript points (72 pt/in ÷ 25.4 mm/in). */
export const PT_PER_MM = 72 / 25.4

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM
}

/** Paper dimensions in points, PORTRAIT (width × height). */
export const PAPER_PORTRAIT_PT: Record<PdfPaperSize, { width: number; height: number }> = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 },
  legal: { width: 612, height: 1008 },
}

export type ResolvedPage = {
  width: number
  height: number
  margin: number
  /** Content area (after margins). */
  contentWidth: number
  contentTop: number
  contentBottom: number
  contentLeft: number
}

/** Resolve a page setup into concrete point geometry. */
export function resolvePage(setup: PdfPageSetup): ResolvedPage {
  const portrait = PAPER_PORTRAIT_PT[setup.paperSize]
  const landscape = setup.orientation === 'landscape'
  const width = landscape ? portrait.height : portrait.width
  const height = landscape ? portrait.width : portrait.height
  const margin = mmToPt(setup.marginMm)
  return {
    width,
    height,
    margin,
    contentWidth: width - margin * 2,
    contentTop: margin,
    contentBottom: height - margin,
    contentLeft: margin,
  }
}
