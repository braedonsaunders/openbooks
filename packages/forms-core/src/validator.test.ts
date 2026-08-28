// Run with: node --import tsx --test packages/forms-core/src/validator.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateResponse, type FormSchemaV1 } from './index'

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
