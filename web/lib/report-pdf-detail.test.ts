import assert from 'node:assert/strict'
import test from 'node:test'
import { generalLedgerExportData } from './report-pdf-detail.ts'

const t = (key: string) => key

test('general-ledger export mirrors the paper view with one section per account', () => {
  const data = generalLedgerExportData({
    from: '2026-01-01',
    to: '2026-01-31',
    truncated: false,
    accounts: [{
      id: 'account-1',
      number: '5210',
      name: 'Overhead Allowance',
      type: 'cogs',
      opening: '0.0000',
      closing: '125.0000',
      lines: [{
        entryId: 'entry-1',
        entryNumber: 'JE-100',
        date: '2026-01-31',
        party: null,
        memo: 'Overhead applied',
        debit: '125.0000',
        credit: '0.0000',
        balance: '125.0000',
        docKind: null,
        docId: null,
      }],
    }],
  }, 'General Ledger', t)

  assert.equal(data.groups.length, 1)
  assert.equal(data.groups[0]?.kind, 'section')
  assert.equal(data.groups[0]?.title, '5210 Overhead Allowance')
  assert.deepEqual(data.groups[0]?.columns, [
    'generalLedger.columns.date',
    'generalLedger.columns.entry',
    'generalLedger.columns.detail',
    'trialBalance.columns.debits',
    'trialBalance.columns.credits',
    'export.columns.balance',
  ])
  assert.equal(data.groups[0]?.rows[1]?.[1], 'JE-100')
  assert.equal(data.groups[0]?.rows[1]?.[3], 125)
})
