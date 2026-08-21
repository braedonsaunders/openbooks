import assert from 'node:assert/strict'
import test from 'node:test'
import { formatJournalAmount, journalAmountUnits, journalLineUnits } from './journal-amounts.ts'

test('amount parsing stays exact at the ledger scale', () => {
  assert.equal(journalAmountUnits('10.5312'), 105312n)
  assert.equal(journalAmountUnits('0.0050'), 50n)
  assert.equal(journalAmountUnits('0.005'), 50n)
  assert.equal(journalAmountUnits(''), 0n)
  assert.equal(journalAmountUnits(null), 0n)
  assert.equal(journalAmountUnits(undefined), 0n)
  assert.equal(journalAmountUnits('-3.2500'), -32500n)
  assert.equal(journalAmountUnits('.5'), 5000n)
  assert.equal(journalAmountUnits('9007199254740993.1234'), 90071992547409931234n)
  assert.equal(journalAmountUnits('1.00001'), null)
  assert.equal(journalAmountUnits('abc'), null)
})

test('signed line amounts and formatting round-trip without float loss', () => {
  assert.equal(journalLineUnits('10.0000', ''), 100000n)
  assert.equal(journalLineUnits('', '0.0050'), -50n)
  assert.equal(journalLineUnits('10.5312', '0.0007'), 105305n)
  assert.equal(journalLineUnits('x', ''), null)
  assert.equal(journalLineUnits('', 'y'), null)
  assert.equal(formatJournalAmount(105312n), '10.5312')
  assert.equal(formatJournalAmount(-50n), '-0.0050')
  assert.equal(formatJournalAmount(0n), '0.0000')
})
