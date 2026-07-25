import 'server-only'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import { esc, renderLienWaiverBody, type LienWaiverFormData } from './lien-waiver-form'

/**
 * Print a lien waiver to PDF through the shared Chromium printer. The wording
 * and layout live in the pure -form module so the operative release language is
 * unit-tested rather than eyeballed in a rendered file.
 */
export async function renderLienWaiverPdf(
  data: LienWaiverFormData,
  orgName?: string | null,
): Promise<Buffer> {
  return renderHtmlDocumentPdf({
    bodyHtml: renderLienWaiverBody(data, orgName),
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 16,
    footerHtml: `${esc(data.waiverNumber)} · ${esc(data.projectName)} · page {{page}} of {{pages}}`,
  })
}
