import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRow } from './coerce.ts'
import { SETUP_ENTITY_BY_KEY } from './registry.ts'

// The registration's form picker offers the org's own configured return
// forms (by code) instead of free text: the descriptor declares a ref to
// tax-return-forms, and tax-return-forms declares refValue 'code' so pickers
// and the coercer trade the stored code, never the row id. Import/export
// must keep storing the code verbatim — resolving it to a row id would
// write a uuid the return engine can never match, silently unlinking the
// registration from its form.

test('returnFormCode is a ref to the org return forms, stored by code', () => {
  const registrations = SETUP_ENTITY_BY_KEY.get('tax-registrations')
  const forms = SETUP_ENTITY_BY_KEY.get('tax-return-forms')
  assert.ok(registrations && forms)
  assert.equal(forms.refValue, 'code')
  const field = registrations.fields.find((f) => f.key === 'returnFormCode')
  assert.deepEqual(field, { key: 'returnFormCode', kind: 'ref', ref: 'tax-return-forms' })
})

test('the coercer stores the picked form code, not a row id', () => {
  const registrations = SETUP_ENTITY_BY_KEY.get('tax-registrations')!
  const built = buildRow(registrations, {
    jurisdictionId: '11111111-1111-4111-8111-111111111111',
    registrationNumber: 'NY-REG-1',
    filingFrequency: 'quarterly',
    returnFormCode: 'US_NY_ST100',
    isActive: true,
  }, { forCreate: true })
  assert.ok(!('error' in built), 'error' in built ? built.error : 'coercion failed')
  const stored = new Map(built.cols.map((c) => [c.column, c.value]))
  assert.equal(stored.get('return_form_code'), 'US_NY_ST100')
})

