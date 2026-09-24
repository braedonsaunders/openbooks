import assert from 'node:assert/strict'
import test from 'node:test'
import { marginPercentText, planTotalCost, ratePlacement } from './compensation-money.ts'

test('compensation plan totals and band placement stay exact for decimal strings', () => {
  assert.equal(planTotalCost([{ estAnnualCost: '90071992547409.93' }, { estAnnualCost: '0.08' }]), '90071992547410.01')
  assert.equal(ratePlacement('90071992547409.93', '90071992547409.92', '90071992547410.00'), 'in_range')
  assert.equal(ratePlacement('90071992547410.01', '90071992547409.92', '90071992547410.00'), 'above')
  assert.equal(marginPercentText('45035996273704.97', '90071992547409.93'), '50.00')
})
