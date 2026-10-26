import "server-only";
import { chequeBankDesign, chequeMicrEncoding } from "./cheque-stock";
import { assertMicrFont } from "@openbooks/pdf/micr-font";
import {
  PdfTemplateValidationError,
  renderHtmlDocumentPdf,
  renderTemplate,
  sanitizeRenderedHtml,
  sanitizeTokenizedFragment,
} from "@openbooks/pdf";
import type { PdfPrintDesign } from "./store";

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
const UNTRUSTED_VALUES = { escapeHtml: true, allowRawValues: false } as const;

export async function mergeAndPrintPdf(
  // The renderer takes only what it prints: issuance provenance rides on
  // ResolvedPdfTemplate for the download/email/backup/flow channels to
  // record, never through the print itself. The parameter IS PdfPrintDesign
  // (not a second list) so the hash and the bytes cannot disagree about
  // what "the design" is.
  tpl: PdfPrintDesign,
  values: Record<string, unknown>,
  options: { specimen?: boolean; calibration?: boolean } = {},
): Promise<Buffer> {
  let printMicr = false;
  let micrEncoding: "unicode" | "abcd" = "unicode";
  if (tpl.compiledHtml.includes("data-cheque-stock")) {
    let bankDesign;
    try {
      bankDesign = chequeBankDesign(tpl.compiledHtml);
      micrEncoding = chequeMicrEncoding(tpl.compiledHtml);
    } catch (error) {
      throw new PdfTemplateValidationError(
        error instanceof Error ? error.message : "Cheque bank configuration is invalid.",
      );
    }
    printMicr = bankDesign.printMicr;
    if (
      !options.specimen &&
      bankDesign.profileId &&
      bankDesign.profileId !== values.cheque_bank_profile
    )
      throw new PdfTemplateValidationError(
        "Select the bank profile used when this cheque was issued; its bank identity cannot be changed on a reprint.",
      );
    if (printMicr) {
      const encoded = tpl.compiledHtml.match(
        /id=["']ob-cheque-micr-font["'][^>]*>[\s\S]*?url\(["']?data:font\/ttf;base64,([A-Za-z0-9+/=]+)["']?\)/i,
      )?.[1];
      if (!encoded)
        throw new PdfTemplateValidationError(
          "Embed an E-13B TrueType font in the cheque designer before printing MICR.",
        );
      try {
        assertMicrFont(Buffer.from(encoded, "base64"), micrEncoding);
      } catch (error) {
        throw new PdfTemplateValidationError(
          error instanceof Error ? error.message : "MICR font is invalid.",
        );
      }
      if (!values.micr_serial || !values.micr_transit || !values.micr_account)
        throw new PdfTemplateValidationError(
          "Printed MICR needs the issued numeric cheque number and frozen bank details.",
        );
    }
  }
  const mappedMicr =
    micrEncoding === "abcd"
      ? Object.fromEntries(
          ["micr_serial", "micr_transit", "micr_account"].map((key) => [
            key,
            String(values[key] ?? "")
              .replaceAll("⑆", "A")
              .replaceAll("⑈", "C")
              .replaceAll("⑉", "D"),
          ]),
        )
      : {};
  const mergedValues = { ...values, ...mappedMicr, print_micr: printMicr };
  const counters = { ...mergedValues, page: "{{page}}", pages: "{{pages}}" };
  const specimen = options.specimen
    ? '<div style="position:fixed;left:20%;top:35%;transform:rotate(-25deg);font:bold 56px Arial;color:#9f1239;opacity:.65;z-index:9999;">VOID · SPECIMEN</div>'
    : "";
  const calibration = options.calibration
    ? '<div style="position:fixed;left:25mm;top:25mm;z-index:10000;color:#111;font:10px Arial;"><div style="width:100mm;height:1px;background:#111;">100 mm · print at actual size (100%)</div><div style="height:100mm;width:1px;background:#111;"></div><div>Measure both rules. Disable Fit to page.</div></div>'
    : "";
  return renderHtmlDocumentPdf({
    bodyHtml:
      sanitizeRenderedHtml(renderTemplate(tpl.compiledHtml, mergedValues, UNTRUSTED_VALUES)) +
      specimen +
      calibration,
    paperSize: tpl.paperSize,
    orientation: tpl.orientation,
    marginMm: tpl.marginMm,
    headerHtml: tpl.headerHtml
      ? sanitizeTokenizedFragment(renderTemplate(tpl.headerHtml, counters, UNTRUSTED_VALUES))
      : null,
    footerHtml: tpl.footerHtml
      ? sanitizeTokenizedFragment(renderTemplate(tpl.footerHtml, counters, UNTRUSTED_VALUES))
      : null,
  });
}
