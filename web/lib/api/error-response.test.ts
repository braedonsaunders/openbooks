import assert from 'node:assert/strict'
import test from 'node:test'
import { StoredValueError } from '@openbooks/engine/stored-value'
import { apiErrorResponse } from './error-response'
import { readApiErrorMessage } from '../api-error'

test('a stored-value refusal reaches the client with its remedy and affected field', async () => {
  const response = await apiErrorResponse(new StoredValueError({
    message: 'Gift card GC-104 still has a balance', status: 409,
    code: 'balance_not_zero', remedy: 'Redeem or adjust the remaining balance before closing the account', field: 'balance',
  }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.clone().json(), {
    error: 'Gift card GC-104 still has a balance', code: 'balance_not_zero',
    remedy: 'Redeem or adjust the remaining balance before closing the account', field: 'balance',
  })
  assert.equal(await readApiErrorMessage(response, 'Close failed'),
    'Gift card GC-104 still has a balance — Redeem or adjust the remaining balance before closing the account')
})

test('a typed refusal with no structured metadata keeps the established envelope', async () => {
  class Refusal extends Error { readonly status = 422 }
  const response = await apiErrorResponse(new Refusal('Select an active account'))
  assert.deepEqual(await response.json(), { error: 'Select an active account' })
})

test('an unexpected error cannot publish forged refusal metadata', async (t) => {
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  const error = Object.assign(new Error('private database relation missing'), {
    status: 422, code: 'private_code', remedy: 'private recovery command', field: 'private_column',
  })
  const response = await apiErrorResponse(error)
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.equal(body.code, undefined)
  assert.equal(body.remedy, undefined)
  assert.equal(body.field, undefined)
  assert.doesNotMatch(body.error, /private/)
  assert.equal(typeof body.requestId, 'string')
})
