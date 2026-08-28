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

test('states without a statewide sales tax never create nexus obligations', () => {
  const rows = evaluateUsNexus([
    { state: 'OR', salesUsd: '1000000', txnCount: 1_000 },
    { state: 'DE', salesUsd: '1000000', txnCount: 1_000 },
  ])
  assert.deepEqual(rows.map((row) => row.status), ['none', 'none'])
  assert.deepEqual(rows.map((row) => row.threshold.measure), ['none', 'none'])
  assert.deepEqual(rows.map((row) => row.progress), [0, 0])
  assert.equal(evaluateUsNexus([{ state: 'OR', salesUsd: '1000000', txnCount: 1_000 }], { approachingAt: 0 })[0]!.status, 'none')
})

test('OR states are met by hitting either the dollar or the transaction trigger', () => {
  const byTxn = evaluateUsNexus([{ state: 'FL', salesUsd: '40000', txnCount: 250 }])[0]!
  assert.equal(byTxn.status, 'met') // 250 > 200 transactions
  const bySales = evaluateUsNexus([{ state: 'FL', salesUsd: '120000', txnCount: 5 }])[0]!
  assert.equal(bySales.status, 'met') // $120k > $100k
})

test('sales-only states ignore transaction count', () => {
  const ca = evaluateUsNexus([{ state: 'CA', salesUsd: '200000', txnCount: 100_000 }])[0]!
  assert.equal(ca.status, 'none') // huge txn count irrelevant; $200k < $500k
})

test('AND states require both triggers', () => {
  // Sales blown past but only 40% of the transaction count → not close on the
  // binding (min) leg, so not yet approaching.
  const far = evaluateUsNexus([{ state: 'NY', salesUsd: '600000', txnCount: 40 }])[0]!
  assert.equal(far.status, 'none')
  // Both legs near (sales met, 85 of 100 txns) → approaching.
  const near = evaluateUsNexus([{ state: 'NY', salesUsd: '600000', txnCount: 85 }])[0]!
  assert.equal(near.status, 'approaching')
  const both = evaluateUsNexus([{ state: 'NY', salesUsd: '600000', txnCount: 150 }])[0]!
  assert.equal(both.status, 'met')
})

test('approaching fires at 80% of the binding trigger', () => {
  const near = evaluateUsNexus([{ state: 'FL', salesUsd: '85000', txnCount: 10 }])[0]!
  assert.equal(near.status, 'approaching') // 85% of $100k
  const far = evaluateUsNexus([{ state: 'FL', salesUsd: '50000', txnCount: 10 }])[0]!
  assert.equal(far.status, 'none')
})

test('results sort most-urgent first: met, then approaching, then none', () => {
  const rows = evaluateUsNexus([
    { state: 'FL', salesUsd: '50000', txnCount: 5 }, // none
    { state: 'TX', salesUsd: '600000', txnCount: 5 }, // met (sales-only $500k)
    { state: 'GA', salesUsd: '90000', txnCount: 5 }, // approaching
  ])
  assert.deepEqual(rows.map((r) => r.state), ['TX', 'GA', 'FL'])
})

test('a penny under the dollar threshold is not met', () => {
  const justUnder = evaluateUsNexus([{ state: 'FL', salesUsd: '99999.9999', txnCount: 0 }])[0]!
  assert.equal(justUnder.status, 'approaching')
  const exact = evaluateUsNexus([{ state: 'FL', salesUsd: '100000', txnCount: 0 }])[0]!
  assert.equal(exact.status, 'met')
})
