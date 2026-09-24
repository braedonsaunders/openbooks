import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeLedgerDecimal } from '../app/api/analytics/drill/ledger-decimal.ts'

test('analytics drill keeps high-precision and unsafe-size decimals exact', () => {
  const highPrecision = '9007199254740993.1234'
  assert.equal(serializeLedgerDecimal(highPrecision), highPrecision)
  assert.equal(serializeLedgerDecimal(9007199254740993n), '9007199254740993')
  assert.equal(serializeLedgerDecimal('1.2345'), '1.2345')
  assert.throws(() => serializeLedgerDecimal(Number(9007199254740993n)), /must not be JavaScript numbers/)
})

test('analytics drill preserves signs and canonical zero', () => {
  assert.equal(serializeLedgerDecimal('-9007199254740993.1234'), '-9007199254740993.1234')
  assert.equal(serializeLedgerDecimal('-0.0000'), '0')
  assert.equal(serializeLedgerDecimal('0000.0000'), '0')
  assert.equal(serializeLedgerDecimal(null), '0')
})
