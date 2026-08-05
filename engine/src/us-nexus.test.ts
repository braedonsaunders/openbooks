import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateUsNexus, thresholdForState } from './us-nexus.ts'

test('default states use $100k OR 200 transactions', () => {
  const t = thresholdForState('FL')
  assert.equal(t.salesUsd, 100_000)
  assert.equal(t.txnCount, 200)
  assert.equal(t.measure, 'sales_or_txn')
})

test('overrides win (CA sales-only $500k, NY sales AND 100 txns)', () => {
  assert.deepEqual(thresholdForState('CA'), { state: 'CA', salesUsd: 500_000, txnCount: null, measure: 'sales_only' })
  assert.deepEqual(thresholdForState('NY'), { state: 'NY', salesUsd: 500_000, txnCount: 100, measure: 'sales_and_txn' })
})

test('OR states are met by hitting either the dollar or the transaction trigger', () => {
  const [byTxn] = evaluateUsNexus([{ state: 'FL', salesUsd: 40_000, txnCount: 250 }])
  assert.equal(byTxn.status, 'met') // 250 > 200 transactions
  const [bySales] = evaluateUsNexus([{ state: 'FL', salesUsd: 120_000, txnCount: 5 }])
  assert.equal(bySales.status, 'met') // $120k > $100k
})

test('sales-only states ignore transaction count', () => {
  const [ca] = evaluateUsNexus([{ state: 'CA', salesUsd: 200_000, txnCount: 100_000 }])
  assert.equal(ca.status, 'none') // huge txn count irrelevant; $200k < $500k
})

test('AND states require both triggers', () => {
  // Sales blown past but only 40% of the transaction count → not close on the
  // binding (min) leg, so not yet approaching.
  const [far] = evaluateUsNexus([{ state: 'NY', salesUsd: 600_000, txnCount: 40 }])
  assert.equal(far.status, 'none')
  // Both legs near (sales met, 85 of 100 txns) → approaching.
  const [near] = evaluateUsNexus([{ state: 'NY', salesUsd: 600_000, txnCount: 85 }])
  assert.equal(near.status, 'approaching')
  const [both] = evaluateUsNexus([{ state: 'NY', salesUsd: 600_000, txnCount: 150 }])
  assert.equal(both.status, 'met')
})

test('approaching fires at 80% of the binding trigger', () => {
  const [near] = evaluateUsNexus([{ state: 'FL', salesUsd: 85_000, txnCount: 10 }])
  assert.equal(near.status, 'approaching') // 85% of $100k
  const [far] = evaluateUsNexus([{ state: 'FL', salesUsd: 50_000, txnCount: 10 }])
  assert.equal(far.status, 'none')
})

test('results sort most-urgent first: met, then approaching, then none', () => {
  const rows = evaluateUsNexus([
    { state: 'FL', salesUsd: 50_000, txnCount: 5 }, // none
    { state: 'TX', salesUsd: 600_000, txnCount: 5 }, // met (sales-only $500k)
    { state: 'GA', salesUsd: 90_000, txnCount: 5 }, // approaching
  ])
  assert.deepEqual(rows.map((r) => r.state), ['TX', 'GA', 'FL'])
})
