// Run with: node --import tsx --test packages/forms-core/src/validator.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintFormSchema, validateResponse, type FormSchemaV1 } from './index'

const schema: FormSchemaV1 = {
  schemaVersion: 1,
  title: 'Date validation',
  sections: [
    {
      id: 'details',
      fields: [
        { id: 'date', type: 'date', label: 'Date' },
        { id: 'datetime', type: 'datetime', label: 'Date and time' },
      ],
    },
  ],
}

test('rejects calendar dates that do not exist', () => {
  const errors = validateResponse(
    schema,
    { date: '2026-02-31', datetime: '2024-02-30T12:00' },
    {},
  )

  assert.deepEqual(
    errors.map(({ fieldId, message }) => ({ fieldId, message })),
    [
      { fieldId: 'date', message: 'Must be a valid date (yyyy-mm-dd)' },
      { fieldId: 'datetime', message: 'Must be a valid date and time' },
    ],
  )
})

test('accepts valid dates, including leap day', () => {
  assert.deepEqual(
    validateResponse(
      schema,
      { date: '2024-02-29', datetime: '2026-02-28T23:59' },
      {},
    ),
    [],
  )
})

const repeatingSchema: FormSchemaV1 = {
  schemaVersion: 1,
  title: 'Lines',
  sections: [
    {
      id: 'lines',
      repeating: true,
      fields: [
        { id: 'desc', type: 'text', label: 'Description' },
        { id: 'qty', type: 'number', label: 'Qty' },
      ],
    },
  ],
}

test('a null repeating row is a named row error, not a TypeError', () => {
  const errors = validateResponse(
    repeatingSchema,
    {},
    { lines: [{ desc: 'ok', qty: 1 }, null, ['not-an-object']] } as never,
    'submit',
  )
  assert.deepEqual(
    errors.map(({ fieldId, message }) => ({ fieldId, message })),
    [
      { fieldId: 'lines.1', message: 'Row must be an object of field values' },
      { fieldId: 'lines.2', message: 'Row must be an object of field values' },
    ],
  )
})

test('unknown keys inside repeating rows are refused like top-level keys', () => {
  const errors = validateResponse(
    repeatingSchema,
    {},
    { lines: [{ desc: 'ok', qty: 1, ghost: 9 }] },
    'draft',
  )
  assert.deepEqual(errors, [
    { fieldId: 'lines.0.ghost', sectionId: 'lines', message: 'Unknown field' },
  ])
})

const moneySchema: FormSchemaV1 = {
  schemaVersion: 1,
  title: 'Money',
  sections: [
    {
      id: 'main',
      fields: [
        { id: 'price', type: 'currency', label: 'Price' },
        { id: 'ledger', type: 'currency', label: 'Ledger', validation: { scale: 4 } },
        { id: 'qty', type: 'number', label: 'Qty', validation: { scale: 3 } },
        { id: 'rate', type: 'percentage', label: 'Rate' },
        { id: 'floored', type: 'currency', label: 'Floor', validation: { min: 10 } },
      ],
    },
  ],
}

function moneyErrors(values: Record<string, unknown>): string[] {
  return validateResponse(moneySchema, values, {}, 'submit').map((e) => `${e.fieldId}: ${e.message}`)
}

test('currency accepts exact decimals and normalizable numbers within scale', () => {
  assert.deepEqual(moneyErrors({ price: '19.99', ledger: '1', qty: 1, rate: 12.5, floored: '10' }), [])
  assert.deepEqual(moneyErrors({ price: 19.99, ledger: '1', qty: 1, rate: 12.5, floored: '10' }), [])
  assert.deepEqual(moneyErrors({ price: '5', ledger: '1', qty: 1, rate: 12.5, floored: '10' }), [])
})

test('currency refuses over-scale values instead of rounding them', () => {
  assert.deepEqual(moneyErrors({ price: '19.999', ledger: '1', qty: 1, rate: 1, floored: '10' }), [
    'price: Must be an exact decimal amount with at most 2 decimal places',
  ])
  // The classic binary artifact is sixteen places, not two.
  assert.deepEqual(moneyErrors({ price: 0.1 + 0.2, ledger: '1', qty: 1, rate: 1, floored: '10' }), [
    'price: Must have at most 2 decimal places',
  ])
  // A declared 4-place ledger scale still refuses five places.
  assert.deepEqual(moneyErrors({ price: '1', ledger: '19.99999', qty: 1, rate: 1, floored: '10' }), [
    'ledger: Must be an exact decimal amount with at most 4 decimal places',
  ])
  assert.deepEqual(moneyErrors({ price: '1', ledger: '19.9999', qty: 1, rate: 1, floored: '10' }), [])
})

test('currency refuses non-decimal text rather than guessing it', () => {
  for (const price of ['12,34', '1,234', '$5', 'abc', '1e2x']) {
    const errors = moneyErrors({ price, ledger: '1', qty: 1, rate: 1, floored: '10' })
    assert.deepEqual(errors, [`price: Must be an exact decimal amount with at most 2 decimal places`])
  }
})

test('numbers honor a declared scale and percentages stay legacy without one', () => {
  assert.deepEqual(moneyErrors({ price: '1', ledger: '1', qty: 1.234, rate: 1, floored: '10' }), [])
  assert.deepEqual(moneyErrors({ price: '1', ledger: '1', qty: 1.2345, rate: 1, floored: '10' }), [
    'qty: Must have at most 3 decimal places',
  ])
  // No declared scale: the legacy finite check applies.
  assert.deepEqual(moneyErrors({ price: '1', ledger: '1', qty: 1, rate: 12.345678, floored: '10' }), [])
  assert.deepEqual(moneyErrors({ price: '1', ledger: '1', qty: '1.5', rate: 1, floored: '10' }), [
    'qty: Must be a number',
  ])
})

test('exact min, max, and range checks work on decimal strings', () => {
  assert.deepEqual(moneyErrors({ price: '1', ledger: '1', qty: 1, rate: 1, floored: '9.99' }), [
    'floored: Must be at least 10',
  ])
  assert.deepEqual(moneyErrors({ price: '1000000001', ledger: '1', qty: 1, rate: 1, floored: '10' }), [
    'price: Number is out of range',
  ])
})

test('a decimal scale is lint-scoped to numeric field types', () => {
  const scaled = (type: string): FormSchemaV1 => ({
    schemaVersion: 1,
    title: 'Scale',
    sections: [
      { id: 'main', fields: [{ id: 'v', type: type as never, label: 'V', validation: { scale: 2 } }] },
    ],
  })
  assert.deepEqual(lintFormSchema(scaled('number')), [])
  assert.deepEqual(lintFormSchema(scaled('currency')), [])
  assert.deepEqual(lintFormSchema(scaled('percentage')), [])
  assert.ok(
    lintFormSchema(scaled('text')).some((issue) => issue.message.includes('cannot define a decimal scale')),
  )
})
