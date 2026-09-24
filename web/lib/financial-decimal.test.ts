import assert from 'node:assert/strict'
import test from 'node:test'
import { marginPercentText } from './financial-decimal.ts'

test('financial ratios preserve exact percent text at values beyond Number precision', () => {
  assert.equal(marginPercentText('45035996273704.97', '90071992547409.93'), '50.00')
  assert.equal(marginPercentText('1.0000', '0.0000'), null)
})
