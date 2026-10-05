import assert from 'node:assert/strict'
import test from 'node:test'

const { budgetLineStatus, exactBudgetVariance } = await import('./health-data.ts')

/**
 * Budget variance flags kept the direction. A revenue shortfall
 * is a miss, not overspend — it must read "under", never "over"/OVER
 * BUDGET — while a genuine cost overrun keeps "over".
 */
test('a revenue shortfall beyond tolerance reads under, not over', () => {
  // Billed 1,171,788 against 1,210,982: -3.2%... within tolerance is
  // on-track; push the miss beyond 25% and the status must stay on the
  // revenue side of the vocabulary.
  assert.equal(budgetLineStatus('income', '-390000', -0.3221, '1210982'), 'under')
  assert.equal(exactBudgetVariance('900719925474099.00', '900719925474099.01').variance, '0.0100')
  assert.equal(budgetLineStatus('income_other', '-500', -0.5, '1000'), 'under')
})

test('a cost overrun beyond tolerance still reads over', () => {
  assert.equal(budgetLineStatus('expense', '40000', 0.4, '100000'), 'over')
  assert.equal(budgetLineStatus('cogs', '30000', 0.3, '100000'), 'over')
})

test('favorable and near lines stay on-track, the middle band stays watch', () => {
  assert.equal(budgetLineStatus('income', '5000', 0.05, '100000'), 'on-track')
  assert.equal(budgetLineStatus('expense', '-5000', -0.05, '100000'), 'on-track')
  assert.equal(budgetLineStatus('expense', '4600', 0.046, '100000'), 'on-track')
  assert.equal(budgetLineStatus('income', '-20000', -0.2, '100000'), 'watch')
  assert.equal(budgetLineStatus('expense', '20000', 0.2, '100000'), 'watch')
  assert.equal(budgetLineStatus('income', '0', 0, '0'), 'no-budget')
})

test('the tolerance bands come from configuration, not fixed percentages', () => {
  // An 8% cost overrun is on-track under the starting 10%/25% bands but
  // watch under a stricter 5%/15% organization policy — the same variance
  // must grade differently when the organization says so.
  assert.equal(budgetLineStatus('expense', '8000', 0.08, '100000'), 'on-track')
  assert.equal(budgetLineStatus('expense', '8000', 0.08, '100000', { onTrack: 5, watch: 15 }), 'watch')
  assert.equal(budgetLineStatus('expense', '20000', 0.2, '100000', { onTrack: 5, watch: 15 }), 'over')
  assert.equal(budgetLineStatus('income', '-20000', -0.2, '100000', { onTrack: 5, watch: 15 }), 'under')
})
