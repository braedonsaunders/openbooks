import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountRegisterDocTypeLabel,
  accountRegisterExportData,
  accountRegisterExportHref,
} from './account-register-export.ts'

test('account register export href carries scope but never the visible page', () => {
  assert.equal(
    accountRegisterExportHref('account/id', 'xlsx', {
      from: '2026-01-01',
      to: '2026-07-31',
      search: 'vendor 50%',
    }),
    '/api/accounts/account%2Fid/register?format=xlsx&from=2026-01-01&to=2026-07-31&q=vendor+50%25',
  )
})

test('account register export includes every supplied line with debit and credit columns', () => {
  const data = accountRegisterExportData({
    account: { number: '1000', name: 'Bank' },
    total: 2,
    balance: '-5.25',
    lines: [
      {
        posting_date: '2026-07-01',
        doc_kind: 'customer_payment',
        doc_number: 'PAY-1',
        entry_number: 'JE-1',
        party: 'Customer',
        memo: 'Receipt',
        entry_memo: null,
        amount: '10.2500',
      },
      {
        posting_date: '2026-07-02',
        doc_kind: 'vendor_payment',
        doc_number: null,
        entry_number: 'JE-2',
        party: 'Vendor',
        memo: null,
        entry_memo: 'Disbursement',
        amount: '-15.5000',
      },
    ],
  }, {
    register: 'Register',
    date: 'Date',
    type: 'Type',
    number: 'Number',
    party: 'Party',
    memo: 'Memo',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    lines: 'Lines',
    dateRange: 'All',
    docType: (kind) => kind ?? '',
  })

  assert.equal(data.title, '1000 Bank — Register')
  assert.deepEqual(data.summary, [
    { label: 'Balance', value: '-5.25', money: true },
    { label: 'Lines', value: 2 },
  ])
  assert.deepEqual(data.groups[0]?.money, [false, false, false, false, false, true, true])
  assert.deepEqual(data.groups[0]?.rows, [
    ['2026-07-01', 'customer_payment', 'PAY-1', 'Customer', 'Receipt', '10.2500', null],
    ['2026-07-02', 'vendor_payment', 'JE-2', 'Vendor', 'Disbursement', null, '15.5000'],
  ])
})

test('account register export preserves exact money beyond the Number safe integer range', () => {
  const exact = '9007199254740993.0001'
  const data = accountRegisterExportData({
    account: { number: '1000', name: 'Bank' },
    total: 2,
    balance: exact,
    lines: [
      {
        posting_date: '2026-07-04',
        doc_kind: 'journal',
        doc_number: null,
        entry_number: 'JE-4',
        party: null,
        memo: 'Large debit',
        entry_memo: null,
        amount: exact,
      },
      {
        posting_date: '2026-07-05',
        doc_kind: 'journal',
        doc_number: null,
        entry_number: 'JE-5',
        party: null,
        memo: 'Large credit',
        entry_memo: null,
        amount: `-${exact}`,
      },
    ],
  }, {
    register: 'Register',
    date: 'Date',
    type: 'Type',
    number: 'Number',
    party: 'Party',
    memo: 'Memo',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    lines: 'Lines',
    dateRange: 'All',
    docType: (kind) => kind ?? '',
  })

  assert.equal(data.summary[0]?.value, exact)
  assert.deepEqual(data.groups[0]?.rows, [
    ['2026-07-04', 'journal', 'JE-4', '', 'Large debit', exact, null],
    ['2026-07-05', 'journal', 'JE-5', '', 'Large credit', null, exact],
  ])
})

test('zero-amount lines leave both columns empty like the on-screen register', () => {
  // The drawer renders a 0.0000 line with empty debit AND credit cells
  // (isZero guard); the export must agree — never park the zero in credit.
  const data = accountRegisterExportData({
    account: { number: '1000', name: 'Bank' },
    total: 1,
    balance: '0.0000',
    lines: [
      {
        posting_date: '2026-07-03',
        doc_kind: 'journal',
        doc_number: null,
        entry_number: 'JE-3',
        party: null,
        memo: 'Reversal stub',
        entry_memo: null,
        amount: '0.0000',
      },
    ],
  }, {
    register: 'Register',
    date: 'Date',
    type: 'Type',
    number: 'Number',
    party: 'Party',
    memo: 'Memo',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    lines: 'Lines',
    dateRange: 'All',
    docType: (kind) => kind ?? '',
  })

  assert.deepEqual(data.groups[0]?.rows, [
    ['2026-07-03', 'journal', 'JE-3', '', 'Reversal stub', null, null],
  ])
})

test('account register document type labels are localized with a safe fallback', () => {
  const t = (key: string) => `translated:${key}`
  assert.equal(
    accountRegisterDocTypeLabel('vendor_bill', t),
    'translated:transactionTypes.vendorBill',
  )
  assert.equal(accountRegisterDocTypeLabel('custom_kind', t), 'Custom Kind')
})
