import 'server-only'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import type { PdfBranding } from '@openbooks/pdf'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { escFacsimile, renderTaxFormFacsimileBody } from './tax-form-facsimile-html'

/** Render a form-faithful facsimile straight to a PDF Buffer via the shared
 *  Chromium printer. The layout logic lives in the pure -html module. */
export async function renderTaxFormFacsimilePdf(
  result: TaxReturnResult,
  branding?: Pick<PdfBranding, 'orgName' | 'primaryColor'> | null,
): Promise<Buffer> {
  const bodyHtml = renderTaxFormFacsimileBody(result, branding)
  return renderHtmlDocumentPdf({
    bodyHtml,
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    footerHtml: `${escFacsimile(result.formName)} · working copy · page {{page}} of {{pages}}`,
  })
}
