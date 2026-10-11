import assert from 'node:assert/strict'
import test from 'node:test'
import { secondObservationNeedsReason } from './observation-reason'

test('an agreeing second count is recorded without a reason prompt', () => {
  assert.equal(secondObservationNeedsReason('7', '7.0000'), false)
  assert.equal(secondObservationNeedsReason('7.0000', '7'), false)
})

test('a differing second count needs its explanation before it is recorded', () => {
  assert.equal(secondObservationNeedsReason('8', '7.0000'), true)
  assert.equal(secondObservationNeedsReason('0', '0.5'), true)
})

test('a line without a first observation always asks for the reason', () => {
  assert.equal(secondObservationNeedsReason('7', null), true)
})

test('a value that cannot be compared exactly is treated as differing, never as agreeing', () => {
  assert.equal(secondObservationNeedsReason('7.00001', '7.0000'), true)
  assert.equal(secondObservationNeedsReason('seven', '7.0000'), true)
})
