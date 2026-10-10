import assert from 'node:assert/strict'
import test from 'node:test'
import { numberSequenceReadColumn, storedSequencePosition } from './number-sequence-position'

test('the configured next number is stored as the position just before it', () => {
  assert.deepEqual(storedSequencePosition(1, 0), { value: 0 })
  assert.deepEqual(storedSequencePosition(2089, 0), { value: 2088 })
})

test('a used sequence accepts only next numbers beyond what it already issued', () => {
  assert.deepEqual(storedSequencePosition(2090, 2089), { value: 2089 })
  const refused = storedSequencePosition(2089, 2089)
  assert.ok('error' in refused)
  assert.match(refused.error, /issued numbers through 2089/)
  assert.match(refused.error, /2090 or higher/)
})

test('next numbers that are not whole numbers of at least 1 are refused', () => {
  for (const bad of [0, -5, 1.5, Number.NaN, '12', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const result = storedSequencePosition(bad, 0)
    assert.ok('error' in result, `expected a refusal for ${String(bad)}`)
  }
})

test('setup reads present the next number to issue and leave other columns untouched', () => {
  assert.equal(numberSequenceReadColumn('next_number'), '(next_number + 1) as next_number')
  assert.equal(numberSequenceReadColumn('allocated_through'), 'allocated_through')
})
