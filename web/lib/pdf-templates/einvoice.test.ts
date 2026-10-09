import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { germanInvoice } from '@openbooks/engine/src/einvoice/test-fixtures.ts'
import { computeEInvoiceAmounts, type EInvoice } from '@openbooks/engine/einvoice'
import { compileTemplateHtml, renderTemplate } from '@openbooks/pdf'
import { PDF_RECORD_TYPE_BY_KEY } from './catalog.ts'
import { starterTemplate } from './starters.ts'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../locale' && context.parentURL?.includes('/pdf-templates/einvoice.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function resolveLocale(){return "en"}' }
    }
    return next(specifier, context)
  },
})
const { assertEInvoicePdfDesign, eInvoicePdfValues } = await import('./einvoice.ts')

function design() {
  const starter = starterTemplate(PDF_RECORD_TYPE_BY_KEY.customer_invoice!, '#123456')
  return { compiledHtml: compileTemplateHtml(starter.sourceHtml).compiledHtml, headerHtml: starter.headerHtml,
    footerHtml: starter.footerHtml, paperSize: 'letter' as const, orientation: 'portrait' as const, marginMm: 14 }
}

test('the native invoice design exposes the fiscal identity and VAT breakdown of a hybrid invoice', async () => {
  const invoice = germanInvoice({ profile: 'facturx' }, { allowanceCharges: [] })
  const template = design()
  assert.doesNotThrow(() => assertEInvoicePdfDesign(template, invoice))
  const values = await eInvoicePdfValues(invoice, { org_name: 'Other entity', party_name: 'Old customer', total: '0', lines: [] })
  assert.equal(values.org_name, invoice.seller.name)
  assert.equal(values.party_name, invoice.buyer.name)
  assert.equal(values.reference_number, invoice.buyerReference)
  const html = renderTemplate(template.compiledHtml, values, { escapeHtml: true, allowRawValues: false })
  assert.ok(html.includes(invoice.seller.vatId!))
  assert.ok(html.includes(invoice.seller.address.postcode!))
  assert.ok(html.includes(invoice.buyerReference!))
  assert.ok(html.includes(invoice.payment.creditTransfer!.accountId))
  assert.ok(!html.includes('Other entity'))
})

test('hybrid amounts preserve decimals above the JavaScript integer precision limit', async () => {
  const base = germanInvoice({ profile: 'facturx' }, { allowanceCharges: [] })
  const lines = [{ ...base.lines[0]!, quantity: '1', netPrice: '9007199254740993.12345678', netAmount: '9007199254740993.12', vatRate: '0', vatCategory: 'E' as const }]
  const invoice: EInvoice = { ...base, lines, allowanceCharges: [], ...computeEInvoiceAmounts({ lines, allowanceCharges: [], currencyDecimals: 2, exemptions: [{ category: 'E', reason: 'Exempt supply' }] }) }
  const values = await eInvoicePdfValues(invoice, { total: '0', lines: [] })
  assert.equal(values.total, '€9,007,199,254,740,993.12')
  assert.equal((values.lines as Record<string, unknown>[])[0]!.unit_price, '€9,007,199,254,740,993.12345678')
  assert.equal((values.vat_breakdown as Record<string, unknown>[])[0]!.taxable_amount, values.total)
})

test('a custom hybrid template cannot omit seller identity or hide the field only in an attribute', () => {
  const invoice = germanInvoice({ profile: 'facturx' }, { allowanceCharges: [] })
  const template = design()
  const incomplete = { ...template, compiledHtml: template.compiledHtml.replace(/{{seller_address}}/g, '') + '<p title="{{seller_address}}">Invoice</p>' }
  assert.throws(() => assertEInvoicePdfDesign(incomplete, invoice), /seller_address.*PDF Templates/)
})

test('a reverse-charge hybrid design must print the statutory exemption wording', () => {
  const base = germanInvoice({ profile: 'facturx' }, { allowanceCharges: [] })
  const lines = base.lines.map(line => ({ ...line, vatRate: '0', vatCategory: 'AE' as const }))
  const invoice: EInvoice = { ...base, lines, ...computeEInvoiceAmounts({ lines, allowanceCharges: [], currencyDecimals: 2, exemptions: [{ category: 'AE', reason: 'Reverse charge' }] }) }
  assert.doesNotThrow(() => assertEInvoicePdfDesign(design(), invoice))
  assert.throws(() => assertEInvoicePdfDesign({ ...design(), compiledHtml: design().compiledHtml.replace(/{{exemption_reason}}/g, '') }, invoice), /exemption_reason/)
})
