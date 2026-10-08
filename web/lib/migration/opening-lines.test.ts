import assert from 'node:assert/strict'
import test from 'node:test'
import { accountResolver, openingLinesFromRows, type AccountRef } from './opening-lines.ts'

const ACCOUNTS: AccountRef[] = [
  { id: 'cash', number: '1000', name: 'Operating Cash', isActive: true, isSummary: false },
  { id: 'ar', number: '1200', name: 'Accounts Receivable', isActive: true, isSummary: false },
  { id: 'assets', number: '1999', name: 'Total Assets', isActive: true, isSummary: true },
  { id: 'ap', number: '2000', name: 'Accounts Payable', isActive: true, isSummary: false },
  { id: 'old', number: '2500', name: 'Old Loan', isActive: false, isSummary: false },
  { id: 'eq1', number: '3000', name: 'Equity', isActive: true, isSummary: false },
  { id: 'eq2', number: '3100', name: 'Equity', isActive: true, isSummary: false },
  { id: 're', number: '3900', name: 'Retained Earnings', isActive: true, isSummary: false },
  { id: 'clearing', number: '1900', name: 'Opening Balance Clearing', isActive: true, isSummary: false },
]
const resolve = accountResolver(ACCOUNTS)
const rows = (...data: Record<string, unknown>[]) => data.map((row, index) => ({ rowNo: index + 1, data: row }))
const DC = { account: 'Account', debit: 'Debit', credit: 'Credit' }

test('a balanced trial balance becomes exact debit-positive lines; zero rows are skipped', () => {
  const result = openingLinesFromRows({
    rows: rows(
      { Account: '1000', Debit: '15000.25', Credit: '' },
      { Account: '1200 Accounts Receivable', Debit: '4999.75', Credit: '' },
      { Account: 'Accounts Payable', Debit: '', Credit: '7000' },
      { Account: '3900', Debit: '0', Credit: '0' },
      { Account: 'Retained Earnings', Debit: '', Credit: '13000.00' },
    ),
    columns: DC,
    resolveAccount: resolve,
  })
  assert.ok(result.ok)
  assert.deepEqual(result.lines.map((line) => [line.accountId, line.amount]), [
    ['cash', '15000.2500'], ['ar', '4999.7500'], ['ap', '-7000.0000'], ['re', '-13000.0000'],
  ])
  assert.equal(result.totalDebits, '20000.0000')
  assert.equal(result.totalCredits, '20000.0000')
  assert.equal(result.net, '0.0000')
  assert.equal(result.skippedZeroRows, 1)
})

test('an out-of-balance file reports the exact difference instead of plugging it', () => {
  const result = openingLinesFromRows({
    rows: rows({ Account: '1000', Amount: '100.01' }, { Account: '3900', Amount: '-100' }),
    columns: { account: 'Account', amount: 'Amount' },
    resolveAccount: resolve,
  })
  assert.ok(result.ok)
  assert.equal(result.net, '0.0100')
})

test('a missing signed balance refuses while an explicit zero remains valid', () => {
  for (const amount of [undefined, null, '', '   ']) {
    const result = openingLinesFromRows({
      rows: rows({ Account: '1000', Amount: '50' }, { Account: '3900', Amount: '-50' }, { Account: '1200', Amount: amount }),
      columns: { account: 'Account', amount: 'Amount' }, resolveAccount: resolve,
    })
    assert.ok(!result.ok)
    assert.equal(result.issues[0]?.rowNo, 3)
  }
  const result = openingLinesFromRows({
    rows: rows({ Account: '1000', Amount: '50' }, { Account: '3900', Amount: '-50' }, { Account: '1200', Amount: '0' }),
    columns: { account: 'Account', amount: 'Amount' }, resolveAccount: resolve,
  })
  assert.ok(result.ok && result.skippedZeroRows === 1)
})

test('formatted amounts, unknown, ambiguous, summary and inactive accounts refuse with the row', () => {
  const result = openingLinesFromRows({
    rows: rows(
      { Account: '1000', Debit: '1,500.00' },
      { Account: 'Equity', Debit: '10' },
      { Account: '1999', Debit: '10' },
      { Account: '2500', Credit: '10' },
      { Account: '9999 Suspense', Debit: '5' },
      { Account: '1000', Debit: '$40' },
    ),
    columns: DC,
    resolveAccount: resolve,
  })
  assert.equal(result.ok, false)
  const byRow = new Map(result.ok ? [] : result.issues.map((issue) => [issue.rowNo, issue.message]))
  assert.equal(byRow.size, 6)
  assert.match(byRow.get(2)!, /names 2 accounts/)
  assert.match(byRow.get(3)!, /summary account/)
  assert.match(byRow.get(4)!, /inactive/)
  assert.match(byRow.get(5)!, /no account numbered or named/)
})

test('a totals row needs an account or an explicit exclusion', () => {
  const data = rows({ Account: '1000', Debit: '50' }, { Account: '3900', Credit: '50' }, { Account: '', Debit: '50' })
  const refused = openingLinesFromRows({ rows: data, columns: DC, resolveAccount: resolve })
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && refused.issues[0]!.rowNo === 3)
  const excluded = openingLinesFromRows({ rows: data, columns: DC, resolveAccount: resolve, excludeRows: new Set([3]) })
  assert.ok(excluded.ok && excluded.net === '0.0000')
})

test('control lines re-point to the clearing account so imported open items rebuild AR and AP', () => {
  const result = openingLinesFromRows({
    rows: rows({ Account: '1200', Debit: '800' }, { Account: '2000', Credit: '300' }, { Account: '3900', Credit: '500' }),
    columns: DC,
    resolveAccount: resolve,
    remap: new Map([['1200', { id: 'clearing', label: '1900' }], ['2000', { id: 'clearing', label: '1900' }]]),
  })
  assert.ok(result.ok)
  assert.deepEqual(result.lines.map((line) => line.accountId), ['clearing', 'clearing', 're'])
  assert.equal(result.net, '0.0000')
})

test('column choices must be one signed amount or debit/credit', () => {
  const both = openingLinesFromRows({ rows: rows({ Account: '1000' }), columns: { account: 'Account', amount: 'A', debit: 'D' }, resolveAccount: resolve })
  const neither = openingLinesFromRows({ rows: rows({ Account: '1000' }), columns: { account: 'Account' }, resolveAccount: resolve })
  assert.equal(both.ok, false)
  assert.equal(neither.ok, false)
})
