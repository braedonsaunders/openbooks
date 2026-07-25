import 'server-only'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import {
  esc,
  renderInformationReturnBody,
  type RecipientFormData,
} from './information-return-form'

/** Print one recipient copy. Layout lives in the pure -form module. */
export async function renderInformationReturnPdf(data: RecipientFormData): Promise<Buffer> {
  return renderHtmlDocumentPdf({
    bodyHtml: renderInformationReturnBody(data),
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    footerHtml: `${esc(data.formType)} ${data.taxYear} · ${esc(data.recipientName)} · recipient copy · page {{page}} of {{pages}}`,
  })
}

/**
 * Every recipient copy of a filing in one print job, page-broken per recipient.
 * A payer furnishing 80 subcontractor copies wants one file, not 80 downloads.
 */
export async function renderInformationReturnBatchPdf(
  recipients: readonly RecipientFormData[],
): Promise<Buffer> {
  if (recipients.length === 0) throw new Error('no recipients to print')
  const bodyHtml = recipients
    .map(
      (data, i) =>
        `<div${i > 0 ? ' style="break-before:page"' : ''}>${renderInformationReturnBody(data)}</div>`,
    )
    .join('')
  const first = recipients[0]!
  return renderHtmlDocumentPdf({
    bodyHtml,
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    footerHtml: `${esc(first.formType)} ${first.taxYear} · recipient copies · page {{page}} of {{pages}}`,
  })
}
