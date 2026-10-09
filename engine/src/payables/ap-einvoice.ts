/** Structured supplier invoices enter the same AP review, matching and materialization path as captured documents. */
import { EInvoiceParseError, extractEmbeddedInvoiceXml, parseEInvoiceXml } from '../einvoice/parse.ts';
import { add, cmp, fromUnits, mulPercent, sum, toUnits } from '../money/money.ts';
import { divideDecimal } from '../money/exact-decimal.ts';
import type { CaptureEvidence, NormalizedCapture } from './ap-capture.ts';

export async function extractNativeInvoice(bytes: Uint8Array, contentType: string): Promise<{
  normalized: NormalizedCapture; evidence: CaptureEvidence[]; overallConfidence: string; raw: unknown;
  documentKind: 'vendor_bill' | 'vendor_credit';
} | null> {
  let xml: string;
  if (contentType === 'application/xml' || contentType === 'text/xml') xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  else if (contentType === 'application/pdf') {
    const embedded = await extractEmbeddedInvoiceXml(bytes);
    if (!embedded) return null;
    xml = embedded.xml;
  } else return null;
  const invoice = parseEInvoiceXml(xml);
  const fail = (message: string): never => { throw new EInvoiceParseError(message); };
  if (invoice.allowanceCharges.length) fail('Document allowances and charges need manual AP review before recognizing the supplier liability.');
  if (cmp(sum(invoice.lines.map(l => l.netAmount)), invoice.totals.lineNet) !== 0
      || cmp(invoice.totals.lineNet, invoice.totals.taxExclusive) !== 0) fail('Document allowances or charges must be resolved in the source invoice before native AP capture. Line totals must equal the tax-exclusive total.');
  if (cmp(add(invoice.totals.taxExclusive, invoice.totals.tax), invoice.totals.taxInclusive) !== 0
      || cmp(sum(invoice.vatBreakdown.map(g => g.taxAmount)), invoice.totals.tax) !== 0) fail('The supplier invoice VAT and gross totals do not reconcile. Request a corrected e-invoice.');
  if (cmp(invoice.totals.prepaid, '0') !== 0 || cmp(invoice.totals.payable, invoice.totals.taxInclusive) !== 0) fail('This invoice includes prepayments or payment rounding. Review it manually so AP does not recognize an incorrect liability.');
  const lines = invoice.lines.map(line => ({ description: line.description ?? line.name, productCode: line.sellerItemId, quantity: line.quantity, unit: line.unitCode, unitPrice: divideDecimal(line.netPrice, line.baseQuantity ?? '1', 8), amount: line.netAmount, taxAmount: '0.0000', confidence: '1.0000' }));
  for (const group of invoice.vatBreakdown) {
    const indexes = invoice.lines.flatMap((line, i) => line.vatCategory === group.category && cmp(line.vatRate ?? '0', group.rate ?? '0') === 0 ? [i] : []);
    if (!indexes.length) fail('A supplier VAT group has no matching invoice lines. Request a corrected e-invoice.');
    if (cmp(sum(indexes.map(i => lines[i]!.amount)), group.taxableAmount) !== 0) fail('The supplier VAT base differs from its invoice lines. Request a corrected e-invoice.');
    for (const i of indexes) lines[i]!.taxAmount = mulPercent(lines[i]!.amount, group.rate ?? '0', 2);
    const residual = fromUnits(toUnits(group.taxAmount) - toUnits(sum(indexes.map(i => lines[i]!.taxAmount))));
    lines[indexes[indexes.length - 1]!]!.taxAmount = add(lines[indexes[indexes.length - 1]!]!.taxAmount, residual);
  }
  if (cmp(sum(lines.map(line => line.taxAmount)), invoice.totals.tax) !== 0) fail('Supplier VAT categories do not cover every invoice line.');
  const normalized: NormalizedCapture = { vendorName: invoice.seller.name, vendorTaxId: invoice.seller.vatId ?? invoice.seller.taxRegistrationId, invoiceNumber: invoice.number, invoiceDate: invoice.issueDate, dueDate: invoice.dueDate, purchaseOrderNumber: invoice.orderReference, currency: invoice.currency, subtotal: invoice.totals.taxExclusive, taxTotal: invoice.totals.tax, total: invoice.totals.taxInclusive, memo: invoice.paymentTerms, lines };
  const evidence: CaptureEvidence[] = Object.entries(normalized).filter(([key]) => key !== 'lines').map(([fieldKey, normalizedValue]) => ({ fieldKey, lineIndex: null, rawValue: normalizedValue == null ? null : String(normalizedValue), normalizedValue, confidence: '1.0000', pageNumber: null, polygon: null }));
  return { normalized, evidence, overallConfidence: '1.0000', raw: { syntax: invoice.syntax, profile: invoice.customizationId, invoice }, documentKind: invoice.isCreditNote ? 'vendor_credit' : 'vendor_bill' };
}
