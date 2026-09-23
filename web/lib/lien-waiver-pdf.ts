import 'server-only'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import { esc, renderLienWaiverBody, type LienWaiverFormData, type LienWaiverPrintOptions } from './lien-waiver-form'

/**
 * Print a lien waiver to PDF through the shared Chromium printer. The wording
 * and layout live in the pure -form module so the operative release language is
 * unit-tested rather than eyeballed in a rendered file. A legacy executed
 * waiver passes its reading date so the print banners itself as current
 * records rather than as the document as signed.
 */
export async function renderLienWaiverPdf(
  data: LienWaiverFormData,
  orgName?: string | null,
  opts?: LienWaiverPrintOptions,
): Promise<Buffer> {
  return renderHtmlDocumentPdf({
    bodyHtml: renderLienWaiverBody(data, orgName, opts),
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 16,
    footerHtml: `${esc(data.waiverNumber)} · ${esc(data.projectName)} · page {{page}} of {{pages}}`,
  })
}
