import 'server-only'
import { renderHtmlDocumentPdf, type PdfBranding, type PdfPageSetup } from '@openbooks/pdf'
import type { ExportData } from './report-pdf'
import { resolveLocale } from './locale'
import { escapedPrintText, generalLedgerPaperHtml } from './general-ledger-paper'

export async function renderGeneralLedgerPaperPdf(
  data: ExportData,
  branding: PdfBranding & { baseCurrency: string },
  page: PdfPageSetup,
): Promise<Buffer> {
  const locale = await resolveLocale()
  const bodyHtml = generalLedgerPaperHtml(data, branding, locale)
  const orgName = escapedPrintText(branding.orgName)
  const title = escapedPrintText(data.title)
  const dateRangeLabel = escapedPrintText(data.dateRangeLabel)
  return renderHtmlDocumentPdf({
    bodyHtml,
    paperSize: page.paperSize,
    orientation: 'landscape',
    marginMm: page.marginMm,
    footerHtml: `<div style="display:grid;grid-template-columns:1fr auto 1fr;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
      <span style="text-align:left;">${orgName} - ${title}</span>
      <span>Page {{page}} of {{pages}}</span>
      <span style="text-align:right;">${dateRangeLabel}</span>
    </div>`,
  })
}
