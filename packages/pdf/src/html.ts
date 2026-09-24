// HTML → PDF printing via headless Chromium (puppeteer-core). Used by the
// org-authored PDF document templates; the pdfkit renderers in document.ts /
// statement.ts stay the engine for programmatic reports.
//
// Safety model: authored HTML is sanitized at save time (template.ts), merge
// values are escaped at render time, and the merged body is sanitized again
// (`sanitizeRenderedHtml`) so record data can never supply an attribute
// scheme. Belt-and-braces here anyway: JavaScript is disabled in the print
// page and subresource loading is restricted to inline data URLs for images,
// fonts and stylesheets.
//
// The page request interceptor sees only the document created by
// `page.setContent`. Chromium prints `headerTemplate` / `footerTemplate` as
// their own documents, and Puppeteer interception does not observe those
// subresources. Header and footer HTML therefore go through
// `preparePdfChromeHtml` (the same inline-only resource policy) before they
// are handed to `page.pdf`. Template-authored network URLs are never fetched
// by the renderer.

import { type Page } from 'puppeteer-core'
import { sharedPdfPool } from './browser-pool'
import { isAllowedPdfRequest, sanitizeTokenizedFragment } from './template'
import { PDF_MARGIN_MM_MAX, PDF_MARGIN_MM_MIN, PDF_PAPER_SIZES, type PdfPaperSize } from './types'

export { isAllowedPdfRequest }

export type PdfOrientation = 'portrait' | 'landscape'

const HTML_BYTE_LIMIT = 16 * 1024 * 1024

export type HtmlDocumentPdfInput = {
  /** Already-merged body HTML (sanitized at save, values escaped at merge). */
  bodyHtml: string
  paperSize: PdfPaperSize
  orientation: PdfOrientation
  marginMm: number
  /** Running header/footer; `{{page}}` / `{{pages}}` become live counters. */
  headerHtml?: string | null
  footerHtml?: string | null
}

function applyPageCounters(html: string): string {
  return html
    .replace(/\{\{\s*page\s*\}\}/g, '<span class="pageNumber"></span>')
    .replace(/\{\{\s*pages\s*\}\}/g, '<span class="totalPages"></span>')
}

/**
 * Prepare header/footer HTML for `page.pdf`. Chromium renders those strings
 * as separate documents that the print-page interceptor cannot see, so this
 * is the load-bearing inline-only rewrite — not the interceptor.
 */
export function preparePdfChromeHtml(html: string): string {
  return applyPageCounters(sanitizeTokenizedFragment(html))
}

/**
 * Refuse an unsupported paper size or an out-of-range margin by name instead
 * of silently printing the wrong paper (an unknown size used to fall back to
 * Letter, and a 500 mm margin printed a blank page). The template save routes
 * enforce the same set and range, so a refusal here means a stored row went
 * stale — never a silent misprint.
 */
export function assertPrintablePage(paperSize: unknown, marginMm: unknown): asserts paperSize is PdfPaperSize {
  if (!PDF_PAPER_SIZES.includes(paperSize as never)) {
    throw new Error(
      `Unknown paper size "${String(paperSize)}" — use one of ${PDF_PAPER_SIZES.join(', ')}.`,
    )
  }
  if (typeof marginMm !== 'number' || !Number.isFinite(marginMm)) {
    throw new Error(
      `Margin must be a number of millimetres from ${PDF_MARGIN_MM_MIN} to ${PDF_MARGIN_MM_MAX} — got ${String(marginMm)}.`,
    )
  }
  if (marginMm < PDF_MARGIN_MM_MIN || marginMm > PDF_MARGIN_MM_MAX) {
    throw new Error(
      `Margin ${String(marginMm)} mm is outside the printable ${PDF_MARGIN_MM_MIN}–${PDF_MARGIN_MM_MAX} mm range.`,
    )
  }
}

/**
 * Print merged template HTML on the chosen paper at the chosen orientation and
 * margins, with the org's own running header/footer. `{{page}}`/`{{pages}}` in
 * the header/footer become Chromium's live page counters.
 */
export async function renderHtmlDocumentPdf(input: HtmlDocumentPdfInput): Promise<Buffer> {
  assertPrintablePage(input.paperSize, input.marginMm)
  const formatMap = { letter: 'Letter', a4: 'A4', legal: 'Legal' } as const
  const m = `${input.marginMm}mm`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;}
    table{page-break-inside:auto;} tr{page-break-inside:avoid;}
  </style></head><body>${input.bodyHtml}</body></html>`
  if (Buffer.byteLength(html, 'utf8') > HTML_BYTE_LIMIT) {
    throw new Error('Rendered document HTML exceeds the 16 MiB print limit.')
  }
  const headerTemplate = input.headerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#64748b;">${preparePdfChromeHtml(input.headerHtml)}</div>`
    : `<div></div>`
  const footerTemplate = input.footerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#94a3b8;text-align:center;">${preparePdfChromeHtml(input.footerHtml)}</div>`
    : `<div></div>`
  return sharedPdfPool().withPage(async (page: Page) => {
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    const pdf = await page.pdf({
      format: formatMap[input.paperSize],
      landscape: input.orientation === 'landscape',
      printBackground: true,
      margin: { top: m, bottom: m, left: m, right: m },
      displayHeaderFooter: Boolean(input.headerHtml || input.footerHtml),
      headerTemplate,
      footerTemplate,
    })
    return Buffer.from(pdf)
  })
}
