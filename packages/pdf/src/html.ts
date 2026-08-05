// HTML → PDF printing via headless Chromium (puppeteer-core). Used by the
// org-authored PDF document templates; the pdfkit renderers in document.ts /
// statement.ts stay the engine for programmatic reports.
//
// Safety model: authored HTML is sanitized at save time (template.ts) and merge
// values are escaped at render time. Belt-and-braces here anyway: JavaScript is
// disabled in the print page and subresource loading is restricted to images,
// fonts and stylesheets.

import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { PdfPaperSize } from './types'

export type PdfOrientation = 'portrait' | 'landscape'

const HTML_BYTE_LIMIT = 16 * 1024 * 1024

function resolveExecutable(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH
  if (fromEnv) return fromEnv

  // Production images install Chromium at this fixed path (see Dockerfile).
  // Keep local development deterministic too, without probing arbitrary
  // filesystem paths that would make Next output tracing crawl the host.
  if (process.platform === 'linux') {
    return '/usr/bin/chromium'
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  throw new Error(
    'Set PUPPETEER_EXECUTABLE_PATH to the approved Chrome/Chromium executable.',
  )
}

let browserPromise: Promise<Browser> | null = null

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null)
    if (existing?.connected) return existing
    browserPromise = null
  }
  browserPromise = puppeteer.launch({
    executablePath: resolveExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  return browserPromise
}

/** New page hardened for printing: no JS, subresources limited to visuals. */
async function newPdfPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage()
  await page.setJavaScriptEnabled(false)
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const type = request.resourceType()
    const url = request.url()
    if (type === 'document' || url.startsWith('data:')) {
      void request.continue()
    } else if (type === 'image' || type === 'font' || type === 'stylesheet') {
      // Visual subresources (logos, fonts) may load over http(s).
      void request.continue()
    } else {
      void request.abort()
    }
  })
  return page
}

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

/**
 * Print merged template HTML on the chosen paper at the chosen orientation and
 * margins, with the org's own running header/footer. `{{page}}`/`{{pages}}` in
 * the header/footer become Chromium's live page counters.
 */
export async function renderHtmlDocumentPdf(input: HtmlDocumentPdfInput): Promise<Buffer> {
  const formatMap = { letter: 'Letter', a4: 'A4', legal: 'Legal' } as const
  const m = `${Math.max(0, input.marginMm)}mm`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;}
    table{page-break-inside:auto;} tr{page-break-inside:avoid;}
  </style></head><body>${input.bodyHtml}</body></html>`
  if (Buffer.byteLength(html, 'utf8') > HTML_BYTE_LIMIT) {
    throw new Error('Rendered document HTML exceeds the 16 MiB print limit.')
  }
  const pageCounters = (s?: string | null): string =>
    s
      ? s
          .replace(/\{\{\s*page\s*\}\}/g, '<span class="pageNumber"></span>')
          .replace(/\{\{\s*pages\s*\}\}/g, '<span class="totalPages"></span>')
      : ''
  const headerTemplate = input.headerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#64748b;">${pageCounters(input.headerHtml)}</div>`
    : `<div></div>`
  const footerTemplate = input.footerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#94a3b8;text-align:center;">${pageCounters(input.footerHtml)}</div>`
    : `<div></div>`
  const browser = await getBrowser()
  const page = await newPdfPage(browser)
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    const pdf = await page.pdf({
      format: formatMap[input.paperSize] ?? 'Letter',
      landscape: input.orientation === 'landscape',
      printBackground: true,
      margin: { top: m, bottom: m, left: m, right: m },
      displayHeaderFooter: Boolean(input.headerHtml || input.footerHtml),
      headerTemplate,
      footerTemplate,
    })
    return Buffer.from(pdf)
  } finally {
    await page.close()
  }
}
