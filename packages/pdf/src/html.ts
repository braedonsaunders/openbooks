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

import { type Page } from "puppeteer-core";
import { sharedPdfPool } from "./browser-pool";
import {
  PdfTemplateValidationError,
  isAllowedPdfRequest,
  sanitizeTokenizedFragment,
} from "./template";
import { PDF_MARGIN_MM_MAX, PDF_MARGIN_MM_MIN, PDF_PAPER_SIZES, type PdfPaperSize } from "./types";

export { isAllowedPdfRequest };

export type PdfOrientation = "portrait" | "landscape";

const HTML_BYTE_LIMIT = 16 * 1024 * 1024;

export type HtmlDocumentPdfInput = {
  /** Already-merged body HTML (sanitized at save, values escaped at merge). */
  bodyHtml: string;
  paperSize: PdfPaperSize;
  orientation: PdfOrientation;
  marginMm: number;
  /** Running header/footer; `{{page}}` / `{{pages}}` become live counters. */
  headerHtml?: string | null;
  footerHtml?: string | null;
};

function applyPageCounters(html: string): string {
  return html
    .replace(/\{\{\s*page\s*\}\}/g, '<span class="pageNumber"></span>')
    .replace(/\{\{\s*pages\s*\}\}/g, '<span class="totalPages"></span>');
}

/**
 * Prepare header/footer HTML for `page.pdf`. Chromium renders those strings
 * as separate documents that the print-page interceptor cannot see, so this
 * is the load-bearing inline-only rewrite — not the interceptor.
 */
export function preparePdfChromeHtml(html: string): string {
  return applyPageCounters(sanitizeTokenizedFragment(html));
}

/**
 * Refuse an unsupported paper size or an out-of-range margin by name instead
 * of silently printing the wrong paper (an unknown size used to fall back to
 * Letter, and a 500 mm margin printed a blank page). The template save routes
 * enforce the same set and range, so a refusal here means a stored row went
 * stale — never a silent misprint.
 */
export function assertPrintablePage(
  paperSize: unknown,
  marginMm: unknown,
  options: { allowZeroMargin?: boolean } = {},
): asserts paperSize is PdfPaperSize {
  if (!PDF_PAPER_SIZES.includes(paperSize as never)) {
    throw new PdfTemplateValidationError(
      `Unknown paper size "${String(paperSize)}" — use one of ${PDF_PAPER_SIZES.join(", ")}.`,
    );
  }
  if (typeof marginMm !== "number" || !Number.isFinite(marginMm)) {
    throw new PdfTemplateValidationError(
      `Margin must be a number of millimetres from ${PDF_MARGIN_MM_MIN} to ${PDF_MARGIN_MM_MAX} — got ${String(marginMm)}.`,
    );
  }
  if (
    !(options.allowZeroMargin && marginMm === 0) &&
    (marginMm < PDF_MARGIN_MM_MIN || marginMm > PDF_MARGIN_MM_MAX)
  ) {
    throw new PdfTemplateValidationError(
      `Margin ${String(marginMm)} mm is outside the printable ${PDF_MARGIN_MM_MIN}–${PDF_MARGIN_MM_MAX} mm range.`,
    );
  }
}

/**
 * Print merged template HTML on the chosen paper at the chosen orientation and
 * margins, with the org's own running header/footer. `{{page}}`/`{{pages}}` in
 * the header/footer become Chromium's live page counters.
 */
export function htmlPdfPageDimensions(paperSize: PdfPaperSize, orientation: PdfOrientation) {
  const formats: Record<Exclude<PdfPaperSize, "4x6">, "Letter" | "A4" | "Legal" | "Tabloid"> = {
    letter: "Letter",
    a4: "A4",
    legal: "Legal",
    tabloid: "Tabloid",
  };
  return paperSize === "4x6"
    ? orientation === "landscape"
      ? { width: "6in", height: "4in" }
      : { width: "4in", height: "6in" }
    : { format: formats[paperSize] };
}

export async function renderHtmlDocumentPdf(input: HtmlDocumentPdfInput): Promise<Buffer> {
  // Physical stock carries its own content insets rather than page margins.
  assertPrintablePage(input.paperSize, input.marginMm, { allowZeroMargin: input.marginMm === 0 });
  if (
    /data-cheque-stock\s*=/i.test(input.bodyHtml) &&
    (input.paperSize !== "letter" ||
      input.orientation !== "portrait" ||
      input.marginMm !== 0 ||
      input.headerHtml ||
      input.footerHtml)
  )
    throw new PdfTemplateValidationError(
      "Cheque stock presets require Letter portrait, zero page margins and no running header/footer. Use alignment controls to position the stock content.",
    );
  const pageDimensions = htmlPdfPageDimensions(input.paperSize, input.orientation);
  // Explicit label dimensions already carry their orientation.
  const customSize = input.paperSize === "4x6";
  const m = `${input.marginMm}mm`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;}
    table{page-break-inside:auto;} tr{page-break-inside:avoid;}
  </style></head><body>${input.bodyHtml}</body></html>`;
  if (Buffer.byteLength(html, "utf8") > HTML_BYTE_LIMIT) {
    throw new Error("Rendered document HTML exceeds the 16 MiB print limit.");
  }
  const headerTemplate = input.headerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#64748b;">${preparePdfChromeHtml(input.headerHtml)}</div>`
    : `<div></div>`;
  const footerTemplate = input.footerHtml
    ? `<div style="font-size:8px;width:100%;padding:0 ${m};color:#94a3b8;text-align:center;">${preparePdfChromeHtml(input.footerHtml)}</div>`
    : `<div></div>`;
  return sharedPdfPool().withPage(async (page: Page) => {
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const chequeLayoutRefusal = await page.evaluate(() => {
      const regions = [...document.querySelectorAll<HTMLElement>("[data-cheque-region]")];
      if (!regions.length) return null;
      const sheet = document.getElementById("ob-cheque-sheet")?.getBoundingClientRect();
      if (!sheet)
        return "Cheque stock needs its complete sheet layout. Start from a stock preset in the PDF designer.";
      const micr = document.getElementById("ob-cheque-micr");
      if (micr) {
        if (
          !document.getElementById("ob-cheque-micr-font") ||
          !document.fonts.check("12pt OpenBooksE13B", micr.textContent ?? "")
        )
          return "MICR font did not load. Embed a valid E-13B font in the cheque designer.";
        const computed = getComputedStyle(micr);
        if (
          !computed.fontFamily.includes("OpenBooksE13B") ||
          Math.abs(parseFloat(computed.fontSize) - 16) > 0.01
        )
          return "MICR must use the embedded E-13B font at 12 points without scaling.";
        const instrument = document.getElementById("ob-cheque-instrument")?.getBoundingClientRect();
        if (!instrument) return "MICR requires the cheque stock instrument area.";
        if (micr.children.length !== 3)
          return "Use the native serial, transit and account fields for the MICR line.";
        const maxWidths = [
          sheet.width - (146.1 * 96) / 25.4 - (3.2 * 96) / 25.4,
          (38.1 * 96) / 25.4,
          (60.4 * 96) / 25.4,
        ];
        const rightAnchors = [146.1, 108, 47.6];
        const offsetX = Number(
          document.getElementById("ob-cheque-sheet")?.getAttribute("data-cheque-offset-x") ?? "0",
        );
        for (const [index, field] of [...micr.children].entries()) {
          const style = getComputedStyle(field),
            bounds = field.getBoundingClientRect();
          if (
            !style.fontFamily.includes("OpenBooksE13B") ||
            Math.abs(parseFloat(style.fontSize) - 16) > 0.01 ||
            (style.letterSpacing !== "normal" && parseFloat(style.letterSpacing) !== 0) ||
            style.transform !== "none"
          )
            return "Each MICR field must retain the embedded E-13B font, 12-point size and standard spacing without scaling.";
          if (bounds.width > (maxWidths[index] ?? 0) + 1)
            return "The MICR field exceeds its bank-specified area. Check numeric cheque length and the bank account encoding.";
          if (
            !Number.isFinite(offsetX) ||
            Math.abs(
              bounds.right - (sheet.right + ((offsetX - rightAnchors[index]!) * 96) / 25.4),
            ) > 1
          )
            return "The MICR fields must use the physical cheque edge. Restore the stock preset and use alignment controls for printer calibration.";
        }
      }
      const instrument = document.getElementById("ob-cheque-instrument");
      if (instrument) {
        const box = instrument.getBoundingClientRect(),
          clearBandTop = box.bottom + ((4.1333 - 15.9) * 96) / 25.4;
        const walker = document.createTreeWalker(instrument, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim() || node.parentElement?.closest("#ob-cheque-micr")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if ([...range.getClientRects()].some((rect) => rect.bottom > clearBandTop + 1))
            return "Cheque text enters the 15.9 mm MICR clear band. Move the ordinary fields above that band in the designer.";
        }
      }
      const bounds = regions.map((region) => ({ box: region.getBoundingClientRect(), region }));
      for (const { box, region } of bounds) {
        if (
          region.scrollHeight > region.clientHeight + 1 ||
          region.scrollWidth > region.clientWidth + 1
        )
          return "Cheque content exceeds its stock area. Adjust the layout or select stock with a larger voucher area.";
        if (
          box.left < sheet.left ||
          box.top < sheet.top ||
          box.right > sheet.right + 1 ||
          box.bottom > sheet.bottom + 1
        )
          return "Cheque alignment moves content outside the sheet. Correct the offsets in the PDF designer.";
      }
      for (let a = 0; a < bounds.length; a++)
        for (let b = a + 1; b < bounds.length; b++) {
          const x = bounds[a]!.box,
            y = bounds[b]!.box;
          if (x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top)
            return "Cheque and voucher areas overlap. Adjust the stock layout in the PDF designer.";
        }
      return null;
    });
    if (chequeLayoutRefusal) throw new PdfTemplateValidationError(chequeLayoutRefusal);
    const pdf = await page.pdf({
      ...pageDimensions,
      landscape: customSize ? false : input.orientation === "landscape",
      printBackground: true,
      margin: { top: m, bottom: m, left: m, right: m },
      displayHeaderFooter: Boolean(input.headerHtml || input.footerHtml),
      headerTemplate,
      footerTemplate,
    });
    return Buffer.from(pdf);
  });
}
