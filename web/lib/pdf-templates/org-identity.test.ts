import assert from 'node:assert/strict'
import test from 'node:test'
import { ORG_FIELDS } from './catalog'
import { orgIdentityMergeValues } from './org-identity'

test('the seller block prints the legal identity recorded on Company & Accounting', () => {
  const values = orgIdentityMergeValues({
    name: 'Northwind',
    legal_name: 'Northwind Industrial Ltd.',
    tax_ids: { ca_gst_hst: '123456782RT0001', ca_bn: '123456782', registration: 'ON-1234' },
    company_address: { line1: '400 King St W', line2: 'Suite 300', city: 'Toronto', region: 'ON', postalCode: 'M5V 1K2', country: 'CA' },
  })
  assert.deepEqual(values, {
    org_name: 'Northwind',
    org_legal_name: 'Northwind Industrial Ltd.',
    org_address: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA',
    org_tax_ids: 'BN 123456782 · GST/HST 123456782RT0001 · Reg. no. ON-1234',
    seller_address: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA',
    seller_vat_id: '',
    seller_tax_number: 'BN 123456782 · GST/HST 123456782RT0001',
    seller_legal_registration: 'ON-1234',
  })
})

test('a VAT number fills the fiscal VAT field rather than the tax-number line', () => {
  const values = orgIdentityMergeValues({ name: 'Example GmbH', tax_ids: { eu_vat: 'DE123456789' } })
  assert.equal(values.seller_vat_id, 'DE123456789')
  assert.equal(values.seller_tax_number, '')
})

test('an organization with no recorded identity prints its name and empty values, never raw tags', () => {
  const values = orgIdentityMergeValues({ name: 'Acme' })
  assert.deepEqual(values, {
    org_name: 'Acme', org_legal_name: 'Acme', org_address: '', org_tax_ids: '',
    seller_address: '', seller_vat_id: '', seller_tax_number: '', seller_legal_registration: '',
  })
})

test('invoice and non-invoice starters print the seller address and tax numbers', async () => {
  const { compileTemplateHtml, renderTemplate } = await import('@openbooks/pdf')
  const { PDF_RECORD_TYPE_BY_KEY } = await import('./catalog')
  const { starterTemplate } = await import('./starters')
  const identity = orgIdentityMergeValues({
    name: 'Northwind',
    tax_ids: { us_ein: '12-3456789' },
    company_address: { line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
  })
  for (const kind of ['customer_invoice', 'quote']) {
    const source = starterTemplate(PDF_RECORD_TYPE_BY_KEY[kind]!).sourceHtml
    const printed = renderTemplate(compileTemplateHtml(source).compiledHtml, identity)
    assert.match(printed, /1 Main St, Austin, TX 78701, US/, `${kind} prints the registered address`)
    assert.match(printed, /EIN 12-3456789/, `${kind} prints the tax number`)
  }
})

test('every catalogued organization field has a merge value', () => {
  const values = orgIdentityMergeValues({ name: 'Acme' })
  for (const field of ORG_FIELDS) {
    if (field.key === 'printed_date') continue
    assert.ok(field.key in values, `${field.key} must always be supplied`)
  }
})
