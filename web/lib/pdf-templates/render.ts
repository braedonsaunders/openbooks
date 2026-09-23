import 'server-only'
import {
  renderHtmlDocumentPdf,
  renderTemplate,
  sanitizeRenderedHtml,
  sanitizeTokenizedFragment,
} from '@openbooks/pdf'
import type { PdfPrintDesign } from './store'

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
 *
 * The merged HEADER and FOOTER use `sanitizeTokenizedFragment` instead: they
 * become Chromium chrome documents that the print-page interceptor cannot
 * see, so static `https:` images, stylesheets and CSS `url()` values must be
 * stripped here (and again in `preparePdfChromeHtml`) rather than left for
 * `page.on('request')`. Navigation `<a href>` and escaped text mentioning a
 * URL are not fetches and stay.
 */
const UNTRUSTED_VALUES = { escapeHtml: true, allowRawValues: false } as const

export async function mergeAndPrintPdf(
  // The renderer takes only what it prints: issuance provenance rides on
  // ResolvedPdfTemplate for the download/email/backup/flow channels to
  // record, never through the print itself. The parameter IS PdfPrintDesign
  // (not a second list) so the hash and the bytes cannot disagree about
  // what "the design" is.
  tpl: PdfPrintDesign,
  values: Record<string, unknown>,
): Promise<Buffer> {
  const counters = { ...values, page: '{{page}}', pages: '{{pages}}' }
  return renderHtmlDocumentPdf({
    bodyHtml: sanitizeRenderedHtml(renderTemplate(tpl.compiledHtml, values, UNTRUSTED_VALUES)),
    paperSize: tpl.paperSize,
    orientation: tpl.orientation,
    marginMm: tpl.marginMm,
    headerHtml: tpl.headerHtml
      ? sanitizeTokenizedFragment(renderTemplate(tpl.headerHtml, counters, UNTRUSTED_VALUES))
      : null,
    footerHtml: tpl.footerHtml
      ? sanitizeTokenizedFragment(renderTemplate(tpl.footerHtml, counters, UNTRUSTED_VALUES))
      : null,
  })
}
