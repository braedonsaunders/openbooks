// The vendor-neutral document model the PDF engine renders. Kept dependency-
// free and decoupled from @openbooks/reports so this package stays a pure
// renderer: callers (the web report adapters, the view export path)
// shape their own result types into this generic input.
//
// The visual vocabulary provides a cover header with organization branding, a
// key-figures summary band, and one section per group of rows, implemented on
// top of pdfkit (pure JS, no Chromium) instead of HTML + Puppeteer.

/** Paper sizes a document can print on. */
export const PDF_PAPER_SIZES = ['letter', 'a4', 'legal'] as const
export type PdfPaperSize = (typeof PDF_PAPER_SIZES)[number]

/** Compact shrinks type and cell padding so more rows fit per page. */
export const PDF_DENSITIES = ['standard', 'compact'] as const
export type PdfDensity = (typeof PDF_DENSITIES)[number]

/** Page setup for a printed/exported document. */
export type PdfPageSetup = {
  paperSize: PdfPaperSize
  orientation: 'portrait' | 'landscape'
  /** Uniform page margin in millimetres. */
  marginMm: number
  density: PdfDensity
}

export const DEFAULT_PDF_LAYOUT: PdfPageSetup = {
  paperSize: 'letter',
  orientation: 'landscape',
  marginMm: 15,
  density: 'standard',
}

export const PDF_MARGIN_MM_MIN = 5
export const PDF_MARGIN_MM_MAX = 30

/** Whitelist/clamp a partial setup into a complete, safe one. */
export function resolvePdfPageSetup(raw: Partial<PdfPageSetup> | null | undefined): PdfPageSetup {
  const paperSize = PDF_PAPER_SIZES.includes(raw?.paperSize as never)
    ? (raw!.paperSize as PdfPaperSize)
    : DEFAULT_PDF_LAYOUT.paperSize
  const orientation = raw?.orientation === 'portrait' ? 'portrait' : 'landscape'
  const m = Number(raw?.marginMm)
  const marginMm = Number.isFinite(m)
    ? Math.min(Math.max(Math.round(m), PDF_MARGIN_MM_MIN), PDF_MARGIN_MM_MAX)
    : DEFAULT_PDF_LAYOUT.marginMm
  const density: PdfDensity = raw?.density === 'compact' ? 'compact' : 'standard'
  return { paperSize, orientation, marginMm, density }
}

export const PDF_PAPER_SIZE_LABELS: Record<PdfPaperSize, string> = {
  letter: 'Letter',
  a4: 'A4',
  legal: 'Legal',
}

// --- Branding --------------------------------------------------------------

export type PdfBranding = {
  /** Organisation / company name printed in the cover header. */
  orgName: string
  /**
   * Optional logo URL (metadata only — the engine never does network I/O).
   * Callers that want a logo in the PDF should preload it and pass
   * `logoBuffer` (a decoded image Buffer); the engine decodes `data:` URLs in
   * `logoUrl` as a convenience, but never fetches remote URLs.
   */
  logoUrl?: string | null
  /** Preloaded logo image (PNG/JPEG Buffer). Wins over `logoUrl`. */
  logoBuffer?: Buffer | null
  /** Brand accent colour (hex). Defaults to the openbooks teal. */
  primaryColor?: string | null
}

export const DEFAULT_PRIMARY_COLOR = '#0f766e'

/** Renderer theme — density-derived sizes + colours. Built in document.ts. */
export type PdfTheme = {
  primary: string
  text: string
  muted: string
  headerFill: string
  headerText: string
  headerBorder: string
  rowBorder: string
  zebra: string
  empty: string
  font: string
  fontBold: string
  body: number
  h1: number
  meta: number
  h2: number
  subtitle: number
  table: number
  cellPadX: number
  cellPadY: number
  groupGap: number
}

// --- Document body --------------------------------------------------------

export type PdfSummaryItem = { label: string; value: string | number }

export type PdfColumnAlign = 'left' | 'right' | 'center'

export type PdfTableGroup = {
  /**
   * Structural role: 'results' = the single unsectioned result table, 'section'
   * = one groupBy bucket, 'summary' = the summarize-mode table. Drives whether
   * the title gets a section rule and whether an empty placeholder renders.
   */
  kind: 'results' | 'section' | 'summary'
  title: string
  subtitle?: string
  columns: string[]
  rows: (string | number | null | undefined)[][]
  /** Per-column alignment. Defaults to 'left'; callers set 'right' for money. */
  align?: PdfColumnAlign[]
  isEmpty?: boolean
}

export type PdfDocumentInput = {
  /** Report / document name — the cover title. */
  title: string
  /** Human label for the date range the document covers (e.g. "FY2025"). */
  dateRangeLabel: string
  generatedAt: Date
  branding: PdfBranding
  /** Key-figures band under the header. Omit to hide. */
  summary?: PdfSummaryItem[]
  groups: PdfTableGroup[]
  layout: PdfPageSetup
  /** Footer left text (defaults to "<orgName> · <title>"). */
  footerLeft?: string
  /** Footer right text (defaults to the generated-at timestamp). */
  footerRight?: string
}
