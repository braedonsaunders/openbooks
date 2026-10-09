import 'server-only'
import { EInvoiceConfigurationError, type EInvoice, type EInvoiceParty } from '@openbooks/engine/einvoice'
import { PAYMENT_MEANS_LABELS } from '@openbooks/engine/einvoice/codes'
import { htmlToPlainText } from '@openbooks/pdf'
import { createMoneyFormatter, formatDecimal } from '../money-format'
import { resolveLocale } from '../locale'
import type { PdfPrintDesign } from './store'

function postalAddress(party: EInvoiceParty): string {
  return [party.address.line1, party.address.line2,
    [party.address.postcode, party.address.city, party.address.subdivision].filter(Boolean).join(' '),
    party.address.countryCode].filter(Boolean).join(', ')
}

/** Every fiscal merge value comes from the same semantic invoice as the embedded XML. */
export async function eInvoicePdfValues(invoice: EInvoice, nativeValues: Record<string, unknown>): Promise<Record<string, unknown>> {
  const locale = await resolveLocale()
  const { money } = createMoneyFormatter(locale, invoice.currency)
  const total = (amount: string) => money(amount, { minimumFractionDigits: invoice.currencyDecimals, maximumFractionDigits: invoice.currencyDecimals })
  const nativeLines = Array.isArray(nativeValues.lines) ? nativeValues.lines as Record<string, unknown>[] : []
  const electronic = (party: EInvoiceParty) => party.electronicAddress ? `${party.electronicAddress.schemeId}:${party.electronicAddress.id}` : ''
  return {
    ...nativeValues,
    org_name: invoice.seller.name, seller_address: postalAddress(invoice.seller),
    seller_vat_id: invoice.seller.vatId ?? '', seller_tax_number: invoice.seller.taxRegistrationId ?? '',
    seller_legal_registration: invoice.seller.legalRegistration?.id ?? '',
    seller_electronic_address: electronic(invoice.seller),
    seller_contact: [invoice.seller.contact?.name, invoice.seller.contact?.phone, invoice.seller.contact?.email].filter(Boolean).join(' · '),
    party_name: invoice.buyer.name, party_address: postalAddress(invoice.buyer),
    buyer_vat_id: invoice.buyer.vatId ?? '', buyer_legal_registration: invoice.buyer.legalRegistration?.id ?? '',
    buyer_electronic_address: electronic(invoice.buyer),
    document_number: invoice.number, document_date: invoice.issueDate, due_date: invoice.dueDate ?? '',
    reference_number: invoice.buyerReference ?? '', currency: invoice.currency, memo: invoice.notes.join('\n'),
    subtotal: total(invoice.totals.taxExclusive), tax_total: total(invoice.totals.tax),
    total: total(invoice.totals.taxInclusive), balance_due: total(invoice.totals.payable),
    payment_means: `${invoice.payment.meansCode} · ${PAYMENT_MEANS_LABELS[invoice.payment.meansCode] ?? invoice.payment.meansText ?? ''}`,
    payee_account: invoice.payment.creditTransfer?.accountId ?? '', payee_name: invoice.payment.creditTransfer?.accountName ?? '',
    payee_bic: invoice.payment.creditTransfer?.providerId ?? '', payment_reference: invoice.payment.remittanceInformation ?? '',
    lines: invoice.lines.map(line => ({
      ...nativeLines.find(native => String(native.line_number) === line.id),
      line_number: line.id, item_name: line.name, description: line.description ?? '',
      quantity: formatDecimal(locale, line.quantity, { maximumFractionDigits: 8 }), unit: line.unitCode,
      unit_price: money(line.netPrice, { minimumFractionDigits: invoice.currencyDecimals, maximumFractionDigits: 8 }),
      amount: total(line.netAmount), vat_category: line.vatCategory, vat_rate: `${formatDecimal(locale, line.vatRate, { maximumFractionDigits: 4 })}%`,
    })),
    vat_breakdown: invoice.vatBreakdown.map(vat => ({ category: vat.category,
      rate: `${formatDecimal(locale, vat.rate, { maximumFractionDigits: 4 })}%`, taxable_amount: total(vat.taxableAmount),
      tax_amount: total(vat.taxAmount), exemption_reason: vat.exemptionReason ?? '', exemption_reason_code: vat.exemptionReasonCode ?? '' })),
  }
}

/** An authored hybrid design must expose the fiscal content of its embedded invoice. */
export function assertEInvoicePdfDesign(design: PdfPrintDesign, invoice: EInvoice): void {
  const text = htmlToPlainText([design.compiledHtml, design.headerHtml, design.footerHtml].filter(Boolean).join('\n'))
  const required = ['org_name', 'seller_address', 'party_name', 'party_address', 'document_number', 'document_date',
    'currency', 'subtotal', 'tax_total', 'total', 'item_name', 'quantity', 'unit', 'unit_price', 'amount', 'category', 'rate', 'taxable_amount', 'tax_amount']
  if (invoice.seller.vatId) required.push('seller_vat_id')
  if (invoice.seller.taxRegistrationId) required.push('seller_tax_number')
  if (invoice.seller.legalRegistration) required.push('seller_legal_registration')
  if (invoice.buyer.vatId) required.push('buyer_vat_id')
  if (invoice.buyer.legalRegistration) required.push('buyer_legal_registration')
  if (invoice.buyerReference) required.push('reference_number')
  if (invoice.dueDate) required.push('due_date')
  if (invoice.vatBreakdown.some(vat => vat.exemptionReason)) required.push('exemption_reason')
  if (invoice.vatBreakdown.some(vat => vat.exemptionReasonCode)) required.push('exemption_reason_code')
  required.push('payment_means')
  if (invoice.payment.creditTransfer) required.push('payee_account')
  if (invoice.payment.remittanceInformation) required.push('payment_reference')
  const missing = required.filter(key => !new RegExp(`{{\\s*(?:this\\.)?${key}\\s*}}`).test(text))
  for (const collection of ['lines', 'vat_breakdown']) {
    if (!new RegExp(`{{#each\\s+${collection}\\s*}}`).test(text)) missing.push(collection)
  }
  if (missing.length) throw new EInvoiceConfigurationError(`The invoice PDF design omits required fiscal fields: ${missing.join(', ')}. Add these merge fields in PDF Templates, or select a complete invoice design before issuing Factur-X / ZUGFeRD.`)
}
