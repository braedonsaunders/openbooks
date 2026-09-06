import 'server-only'
import { renderHtmlDocumentPdf, renderTemplate } from '@openbooks/pdf'
import type { ResolvedPdfTemplate } from './store'

/**
 * Merge a compiled template with record values and print it. `{{page}}` /
 * `{{pages}}` in the header/footer are preserved through the merge so
 * Chromium's live page counters fill them at print time.
 *
 * Record data is never trusted HTML on any surface: the body, header and
 * footer all merge with escaping on and raw (triple-brace) values disabled.
 * The counter placeholders survive escaping untouched (braces are not HTML
 * metacharacters), so renderHtmlDocumentPdf still swaps them for Chromium's
 * page-number spans.
 */
const UNTRUSTED_VALUES = { escapeHtml: true, allowRawValues: false } as const

export async function mergeAndPrintPdf(
  tpl: ResolvedPdfTemplate,
  values: Record<string, unknown>,
): Promise<Buffer> {
  const counters = { ...values, page: '{{page}}', pages: '{{pages}}' }
  return renderHtmlDocumentPdf({
    bodyHtml: renderTemplate(tpl.compiledHtml, values, UNTRUSTED_VALUES),
    paperSize: tpl.paperSize,
    orientation: tpl.orientation,
    marginMm: tpl.marginMm,
    headerHtml: tpl.headerHtml ? renderTemplate(tpl.headerHtml, counters, UNTRUSTED_VALUES) : null,
    footerHtml: tpl.footerHtml ? renderTemplate(tpl.footerHtml, counters, UNTRUSTED_VALUES) : null,
  })
}
