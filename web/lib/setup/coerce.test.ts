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

test('setup string-array fields bind jsonb-safe JSON strings and keep empty-means-everyone', () => {
  const field: SetupField = { key: 'includedJobTitles', kind: 'stringArray', ref: 'job-titles' }
  // The drawer sends a real array; the bound value is a JSON STRING (a JS
  // array would be rendered as a Postgres array literal — invalid jsonb).
  assert.deepEqual(coerceField(field, ['Supervisor', 'Quality Coordinator']), {
    column: 'included_job_titles',
    value: '["Supervisor","Quality Coordinator"]',
  })
  // Case/whitespace duplicates collapse to the first spelling; blanks drop.
  assert.deepEqual(coerceField(field, [' Project  Manager ', 'project manager', '  ']), {
    column: 'included_job_titles',
    value: '["Project Manager"]',
  })
  // Imports may send the JSON-encoded form.
  assert.deepEqual(coerceField(field, '["Foreman"]'), {
    column: 'included_job_titles',
    value: '["Foreman"]',
  })
  // Empty stays [] — for the rule engine an empty list means everyone.
  assert.deepEqual(coerceField(field, []), { column: 'included_job_titles', value: '[]' })
  assert.deepEqual(coerceField(field, ''), { column: 'included_job_titles', value: '[]' })
  assert.deepEqual(coerceField(field, undefined), { column: 'included_job_titles', value: '[]' })
  // Non-string members and malformed JSON are rejected, not coerced.
  assert.deepEqual(coerceField(field, [1, 2]), {
    error: 'includedJobTitles must be a list of text values',
  })
  assert.deepEqual(coerceField(field, '{broken'), {
    error: 'includedJobTitles must be a list of text values',
  })
  assert.deepEqual(coerceField(field, '{"not":"a list"}'), {
    error: 'includedJobTitles must be a list of text values',
  })
})

test('setup decimal and percent fields canonicalize without crossing IEEE-754', () => {
  const rate: SetupField = { key: 'ratePercent', kind: 'percent', required: true }
  const money: SetupField = { key: 'acquisitionCost', kind: 'decimal', required: true }
  assert.deepEqual(coerceField(rate, '13.2500'), { column: 'rate_percent', value: '13.2500000000' })
  assert.deepEqual(coerceField(rate, 13.25), { column: 'rate_percent', value: '13.2500000000' })
  assert.deepEqual(coerceField(money, '00100.1000'), { column: 'acquisition_cost', value: '100.1000000000' })
  assert.deepEqual(coerceField({ key: 'acquisitionRate', kind: 'decimal', required: true }, '1.25'), {
    column: 'acquisition_rate',
    value: '1.2500000000',
  })
  assert.deepEqual(coerceField(rate, '1e-2'), { error: 'ratePercent must be a number' })
  assert.deepEqual(coerceField(rate, '0.30000000000000004'), { error: 'ratePercent must be a number' })
  assert.deepEqual(coerceField(money, 'not-a-number'), { error: 'acquisitionCost must be a number' })
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
