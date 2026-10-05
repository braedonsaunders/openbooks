import assert from 'node:assert/strict'
import test from 'node:test'
import { boundChartNumber } from './chart-number'

// NaN compared its way to +MAX_SAFE_INTEGER — a fabricated extreme for a
// point with no coordinate. The boundary refuses it by name so the caller
// skips the point instead of plotting a lie.
test('boundChartNumber refuses NaN by name', () => {
  assert.throws(() => boundChartNumber(NaN), /got NaN/)
  assert.equal(boundChartNumber(Infinity), Number.MAX_SAFE_INTEGER)
  assert.equal(boundChartNumber(-Infinity), -Number.MAX_SAFE_INTEGER)
  assert.equal(boundChartNumber(1.5), 1.5)
})
