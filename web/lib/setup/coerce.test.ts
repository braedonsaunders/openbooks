import test from 'node:test'
import assert from 'node:assert/strict'
import { coerceField } from './coerce.ts'
import type { SetupField } from './registry.ts'

const countryField: SetupField = { key: 'country', kind: 'country' }

test('setup country fields normalize and validate against the ISO country list', () => {
  assert.deepEqual(coerceField(countryField, ' ca '), { column: 'country', value: 'CA' })
  assert.deepEqual(coerceField(countryField, ''), { column: 'country', value: null })
  assert.deepEqual(coerceField(countryField, 'AA'), { error: 'country must be a valid ISO country code' })
})

test('setup JSON fields parse objects without accepting malformed input', () => {
  const field: SetupField = { key: 'taxAttributes', kind: 'json' }
  assert.deepEqual(coerceField(field, '{"us_macrs_class":"gds_5"}'), {
    column: 'tax_attributes',
    value: { us_macrs_class: 'gds_5' },
  })
  assert.deepEqual(coerceField(field, '{broken'), { error: 'taxAttributes must be valid JSON' })
  assert.deepEqual(coerceField(field, 'hello'), { error: 'taxAttributes must be valid JSON' })
})

test('number-sequence record choices store stable kind tokens without requiring UUIDs', () => {
  const field: SetupField = {
    key: 'documentKind',
    kind: 'ref',
    ref: 'number-sequence-kinds',
    required: true,
  }
  assert.deepEqual(coerceField(field, 'customer_invoice'), {
    column: 'document_kind',
    value: 'customer_invoice',
  })
  assert.deepEqual(coerceField(field, 'custrec:sales-order-test'), {
    column: 'document_kind',
    value: 'custrec:sales-order-test',
  })
})
