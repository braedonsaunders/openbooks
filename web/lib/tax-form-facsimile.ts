import 'server-only'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import type { PdfBranding } from '@openbooks/pdf'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { escFacsimile, renderTaxFormFacsimileBody, type TaxFormLayout } from './tax-form-facsimile-html'

/** Render a form-faithful facsimile straight to a PDF Buffer via the shared
 *  Chromium printer. The layout logic lives in the pure -html module.
 *  `layout` overrides the registry lookup (per-record header fields — the
 *  payroll slips). */
export async function renderTaxFormFacsimilePdf(
  result: TaxReturnResult,
  branding?: Pick<PdfBranding, 'orgName' | 'primaryColor'> | null,
  layout?: TaxFormLayout | null,
): Promise<Buffer> {
  const bodyHtml = renderTaxFormFacsimileBody(result, branding, layout)
  return renderHtmlDocumentPdf({
    bodyHtml,
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    footerHtml: `${escFacsimile(result.formName)} · working copy · page {{page}} of {{pages}}`,
  })
}
