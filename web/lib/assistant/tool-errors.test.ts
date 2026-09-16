import assert from 'node:assert/strict'
import test from 'node:test'
import { ApplicationError, forbidden, invalidInput, notFound } from '../application/errors'
import { safeApplicationToolError } from './tool-errors'

test('controlled discovery and package errors retain actionable feedback', () => {
  assert.equal(safeApplicationToolError(notFound('record type')), 'not_found: record type not found')
  assert.equal(safeApplicationToolError(invalidInput('Native record screens require records.read')),
    'invalid_input: Native record screens require records.read')
})

test('unexpected errors, internals and permission details stay private', () => {
  assert.equal(safeApplicationToolError(new Error('postgres://private-credential')), 'tool_failed')
  assert.equal(safeApplicationToolError(new ApplicationError('internal_error', 'private detail', 500)), 'tool_failed')
  assert.equal(safeApplicationToolError(forbidden('private.permission')), 'forbidden')
  assert.equal(safeApplicationToolError({ code: 'invalid_input', status: 422, message: 'untrusted' }), 'tool_failed')
})

test('engine domain errors surface their operator-facing message', () => {
  class PayrollError extends Error {}
  class PayrollLimitError extends PayrollError {}
  assert.equal(
    safeApplicationToolError(new PayrollError('Committed payroll has an unknown historical filing account.')),
    'payroll: Committed payroll has an unknown historical filing account.',
  )
  assert.equal(safeApplicationToolError(new PayrollLimitError('over limit')), 'payroll: over limit')
  class TaxReturnError extends Error {}
  assert.equal(safeApplicationToolError(new TaxReturnError('form "X" is not configured')), 'tax_return: form "X" is not configured')
  class RandomError extends Error {}
  assert.equal(safeApplicationToolError(new RandomError('postgres://secret')), 'tool_failed')
})
