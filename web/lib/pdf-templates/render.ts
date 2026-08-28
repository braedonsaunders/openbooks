import 'server-only'
import { renderHtmlDocumentPdf, renderTemplate } from '@openbooks/pdf'
import type { ResolvedPdfTemplate } from './store'

/**
 * Merge a compiled template with record values and print it. `{{page}}` /
 * `{{pages}}` in the header/footer are preserved through the merge so
 * Chromium's live page counters fill them at print time.
 */
export async function mergeAndPrintPdf(
  tpl: ResolvedPdfTemplate,
  values: Record<string, unknown>,
): Promise<Buffer> {
  const counters = { ...values, page: '{{page}}', pages: '{{pages}}' }
  return renderHtmlDocumentPdf({
    bodyHtml: renderTemplate(tpl.compiledHtml, values, {
      escapeHtml: true,
      // Record data is never trusted HTML. Triple-brace body tokens must not
      // bypass render-time escaping, even if an authored template contains
      // them.
      allowRawValues: false,
    }),
    paperSize: tpl.paperSize,
    orientation: tpl.orientation,
    marginMm: tpl.marginMm,
    headerHtml: tpl.headerHtml ? renderTemplate(tpl.headerHtml, counters, { escapeHtml: false }) : null,
    footerHtml: tpl.footerHtml ? renderTemplate(tpl.footerHtml, counters, { escapeHtml: false }) : null,
  })
}
