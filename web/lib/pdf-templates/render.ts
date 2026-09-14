import 'server-only'
import { renderHtmlDocumentPdf, renderTemplate, sanitizeRenderedHtml } from '@openbooks/pdf'
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
 *
 * The merged BODY is sanitized again after merging. Save-time sanitization
 * sees the template with `{{tokens}}` in place, and a token is URI-inert, so
 * an author-placed token inside an attribute (e.g. `<a href="{{website}}">`)
 * survives the save — then record data fills the scheme (`javascript:…`).
 * Escaping cannot stop that: `:` is not an HTML metacharacter. Sanitizing the
 * merged output strips the dangerous scheme while keeping safe links
 * (https/mailto), inline data: images, and all escaped text byte-identical.
 * Sized with the rendered-output policy: a valid merge repeats content past
 * the 1MB authored-template ceiling, and must not be refused for it.
 */
const UNTRUSTED_VALUES = { escapeHtml: true, allowRawValues: false } as const

export async function mergeAndPrintPdf(
  tpl: ResolvedPdfTemplate,
  values: Record<string, unknown>,
): Promise<Buffer> {
  const counters = { ...values, page: '{{page}}', pages: '{{pages}}' }
  return renderHtmlDocumentPdf({
    bodyHtml: sanitizeRenderedHtml(renderTemplate(tpl.compiledHtml, values, UNTRUSTED_VALUES)),
    paperSize: tpl.paperSize,
    orientation: tpl.orientation,
    marginMm: tpl.marginMm,
    headerHtml: tpl.headerHtml ? renderTemplate(tpl.headerHtml, counters, UNTRUSTED_VALUES) : null,
    footerHtml: tpl.footerHtml ? renderTemplate(tpl.footerHtml, counters, UNTRUSTED_VALUES) : null,
  })
}
