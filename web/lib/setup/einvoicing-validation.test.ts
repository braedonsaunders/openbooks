import assert from 'node:assert/strict'
import test from 'node:test'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState } from './registry.ts'
import { validateEInvoiceSetupWrite } from './einvoicing-validation.ts'
import { resolveDynamicSetupOptions } from './dynamic-options.ts'
import { CONTRACTOR_REVERSE_CHARGE_RULES } from '@openbooks/engine/country-tax-packs'

const orgId = 'a0000000-0000-4000-8000-000000000001'
const id = 'a0000000-0000-4000-8000-000000000002'
const seller = SETUP_ENTITY_BY_KEY.get('einvoice-settings')!
const recipient = SETUP_ENTITY_BY_KEY.get('einvoice-recipients')!
const taxCode = SETUP_ENTITY_BY_KEY.get('tax-codes')!
const executor = (...rows: Record<string, unknown>[][]): SqlExecutor => ({ execute: async () => ({ rows: rows.shift() ?? [] }) }) as unknown as SqlExecutor

test('seller configuration refuses an unsupported profile and an unpaired electronic address', async () => {
  assert.match(String(await validateEInvoiceSetupWrite({ entity: seller, orgId, body: { defaultProfile: 'unknown' }, executor: executor() })), /supported.*profile/)
  assert.match(String(await validateEInvoiceSetupWrite({ entity: seller, orgId, body: { defaultProfile: 'xrechnung-cii', electronicAddress: 'seller@example.org' }, executor: executor() })), /both.*address/)
})

test('seller settings require an active legal entity and a unique native settings row', async () => {
  const body = { subsidiaryId: id, defaultProfile: 'en16931-cii', paymentMeansCode: '30' }
  assert.match(String(await validateEInvoiceSetupWrite({ entity: seller, orgId, body, executor: executor([]) })), /active invoicing legal entity/)
  assert.match(String(await validateEInvoiceSetupWrite({ entity: seller, orgId, body, executor: executor([{ id }], [{ id: 'duplicate' }]) })), /already has/)
  assert.equal(await validateEInvoiceSetupWrite({ entity: seller, orgId, body, executor: executor([{ id }], []) }), null)
})

test('recipient metadata keeps the existing customer identity immutable', async () => {
  const body = { partyId: 'a0000000-0000-4000-8000-000000000003' }
  const result = await validateEInvoiceSetupWrite({ entity: recipient, orgId, body, rowId: id, executor: executor([{ party_id: id }]) })
  assert.match(String(result), /identity cannot change/)
})

test('e-invoice VAT metadata requires a valid effective date and native reverse-charge calculation', async () => {
  const base = { einvoiceCategory: 'AE', einvoiceExemptionReason: 'Reverse charge', calculationType: 'reverse_charge' }
  assert.match(String(await validateEInvoiceSetupWrite({ entity: taxCode, orgId, body: base, executor: executor() })), /effective date/)
  assert.match(String(await validateEInvoiceSetupWrite({ entity: taxCode, orgId, body: { ...base, einvoiceEffectiveFrom: '2026-10-08', calculationType: 'standard' }, executor: executor() })), /native reverse-charge/)
  assert.equal(await validateEInvoiceSetupWrite({ entity: taxCode, orgId, body: { ...base, einvoiceEffectiveFrom: '2026-10-08' }, executor: executor() }), null)
})

test('standard VAT cannot carry an exemption reason', async () => {
  const result = await validateEInvoiceSetupWrite({ entity: taxCode, orgId, body: { einvoiceCategory: 'S', einvoiceExemptionReason: 'Exempt' }, executor: executor() })
  assert.match(String(result), /Exemption reasons apply only/)
})

test('VAT metadata used by posted documents is corrected through a new effective-dated tax code', async () => {
  const current = { einvoice_category: 'S', einvoice_effective_from: '2026-10-08', calculation_type: 'standard' }
  const result = await validateEInvoiceSetupWrite({ entity: taxCode, orgId, rowId: id,
    body: { einvoiceCategory: 'Z' }, executor: executor([current], [{ id: 'posted-invoice' }]) })
  assert.match(String(result), /used by posted documents.*new tax code/)
})

test('construction templates come from the country registry and retain existing tax rate history', () => {
  const enabled = setupEntityForFeatureState(taxCode, { multiSubsidiary: true, equipment: true, fieldTickets: true, einvoicing: true })
  const options = resolveDynamicSetupOptions(enabled).presets!.options
  assert.equal(options.length, CONTRACTOR_REVERSE_CHARGE_RULES.length)
  for (const rule of CONTRACTOR_REVERSE_CHARGE_RULES) {
    const option = options.find(value => value.key === rule.code)!
    assert.equal(option.values.einvoiceEffectiveFrom, rule.effectiveFrom)
    assert.equal(option.values.einvoiceExemptionReason, rule.invoiceWording)
    assert.equal(option.values.einvoiceCategory, 'AE')
    assert.equal(Object.hasOwn(option.values, 'ratePercent'), false)
  }
  const disabled = setupEntityForFeatureState(taxCode, { multiSubsidiary: true, equipment: true, fieldTickets: true, einvoicing: false })
  assert.equal(disabled.fields.some(field => field.featureKey === 'einvoicing'), false)
  assert.equal(resolveDynamicSetupOptions(disabled).presets, undefined)
})
