import assert from 'node:assert/strict'
import test from 'node:test'
import { decimalSum } from '../../../../lib/statement-format'

// The orders report aggregates open values through decimalSum (exact
// decimal strings, never JavaScript floats): the loader sums each kind's
// open_value legs with it so the pipeline totals conserve cents exactly.
// 0.1 + 0.2 is the classic float trap — binary floating point answers
// 0.30000000000000004, so an exact '0.3000' proves no Number coercion.
test('orders report aggregates exact open values without Number coercion', () => {
  assert.equal(decimalSum(['0.1', '0.2']), '0.3000')
  assert.equal(decimalSum(['100.25', '200.10', '-30.10']), '270.2500')
  assert.equal(decimalSum([]), '0.0000')
})
