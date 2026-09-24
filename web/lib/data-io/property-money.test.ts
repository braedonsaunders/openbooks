import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPositiveLeaseCharge } from './property-money'

test('lease charge amounts stay exact through the ledger bound and four-place scale', () => {
  assert.equal(canonicalPositiveLeaseCharge('900719925474099.0123'), '900719925474099.0123')
  assert.equal(canonicalPositiveLeaseCharge('999999999999999.9999'), '999999999999999.9999')
})

test('lease charge amount validation refuses lossy or noncanonical input', () => {
  for (const value of ['1e3', '1,25', '0', '-0.0001', '1.00001', 1000]) {
    assert.equal(canonicalPositiveLeaseCharge(value), null, `expected ${String(value)} to be refused`)
  }
})
