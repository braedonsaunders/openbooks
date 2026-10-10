import assert from 'node:assert/strict'
import test from 'node:test'
import { initialPayrollPack, packDescription, packTitle } from './payroll-pack-display'

// Display strings for a pack. The locale wins where a key exists for the
// pack's lowercase code; otherwise the PACK'S OWN NAME is used, and the bare
// code only if a caller has no pack to hand. Hand-computed against a stub
// translator, never through the wizard.
const stubT = (titles: Record<string, string>, descriptions: Record<string, string> = {}) => {
  const t = ((key: string) => titles[key] ?? descriptions[key] ?? key) as unknown as Parameters<
    typeof packTitle
  >[0]
  t.has = ((key: string) => key in titles || key in descriptions) as Parameters<typeof packTitle>[0]['has']
  return t
}

test('a translated pack reads under its locale title', () => {
  const t = stubT({ 'payroll.packs.ca.title': 'Canada (localisé)' })
  assert.equal(packTitle(t, 'CA', 'Canada Pack'), 'Canada (localisé)')
})

test('an untranslated pack reads under its served name, never the bare code', () => {
  const t = stubT({})
  assert.equal(packTitle(t, 'XX', 'Xenonia Payroll'), 'Xenonia Payroll')
  assert.equal(packTitle(t, 'xx', 'Xenonia Payroll'), 'Xenonia Payroll')
})

test('the bare code is the last resort, only with no pack to hand', () => {
  const t = stubT({})
  assert.equal(packTitle(t, 'XX'), 'XX')
})

test('descriptions fall back to empty, never the code', () => {
  const withCopy = stubT({}, { 'payroll.packs.ca.description': 'Canadian payroll taxes' })
  assert.equal(packDescription(withCopy, 'CA'), 'Canadian payroll taxes')
  const withoutCopy = stubT({})
  assert.equal(packDescription(withoutCopy, 'XX'), '')
})

// Preselect only what is derived: a sole installable pack, else nothing.
test('wizard preselects no pack unless exactly one is installable', () => {
  const pack = (country: string) => ({ country, name: `${country} name` })
  assert.equal(initialPayrollPack([]), null)
  assert.equal(initialPayrollPack([pack('CA'), pack('US')]), null)
  assert.equal(initialPayrollPack([pack('XX'), pack('YY'), pack('ZZ')]), null)
  assert.equal(initialPayrollPack([pack('CA')]), 'CA')
  assert.equal(initialPayrollPack([pack('XX')]), 'XX')
})

// Every pack in the chooser reads with a subtitle derived from its own
// declarations — not only the packs with hand-written locale copy.
const wizardCopy = (await import('../../../../../messages/en/admin.json', { with: { type: 'json' } }))
  .default.setup.wizard as { payroll: { packSummary: Record<string, string> } }
const summaryT = (() => {
  const templates = wizardCopy.payroll.packSummary
  const t = ((key: string, params: Record<string, unknown> = {}) => {
    const template = templates[key.replace('payroll.packSummary.', '')] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
  }) as unknown as Parameters<typeof packDescription>[0]
  t.has = (() => false) as Parameters<typeof packDescription>[0]['has']
  return t
})()

test('an undescribed pack reads with a subtitle derived from its declarations', () => {
  const regional = packDescription(summaryT, 'GB', {
    country: 'GB',
    name: 'United Kingdom',
    statutoryComponents: ['PAYE income tax', 'National Insurance (employee)', 'National Insurance (employer)', 'Student loan repayment'],
    regions: { known: 4, supported: 4 },
    publishedTaxYears: [2026, 2024, 2025],
  })
  assert.equal(
    regional,
    'PAYE income tax, National Insurance (employee), National Insurance (employer)… · Income tax in all 4 regions · Tax tables 2024–2026',
  )
  const partial = packDescription(summaryT, 'ES', {
    country: 'ES',
    name: 'Spain',
    statutoryComponents: ['IRPF withholding'],
    regions: { known: 19, supported: 17 },
    publishedTaxYears: [2026],
  })
  assert.equal(partial, 'IRPF withholding · Income tax in 17 of 19 regions · Tax tables 2026')
  const national = packDescription(summaryT, 'SG', {
    country: 'SG',
    name: 'Singapore',
    statutoryComponents: ['CPF — employee share', 'CPF — employer share'],
    regions: { known: 1, supported: 1 },
    publishedTaxYears: [2024, 2026],
  })
  assert.equal(national, 'CPF — employee share, CPF — employer share · Tax tables 2024, 2026')
})

test('a pack with no published tables or components gets no invented subtitle', () => {
  assert.equal(packDescription(summaryT, 'XX', { country: 'XX', name: 'X', statutoryComponents: [], publishedTaxYears: [2026] }), '')
  assert.equal(packDescription(summaryT, 'XX', { country: 'XX', name: 'X', statutoryComponents: ['Tax'], publishedTaxYears: [] }), '')
})
