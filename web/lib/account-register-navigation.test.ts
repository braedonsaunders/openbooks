import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountRegisterCloseHref,
  accountRegisterHref,
} from './account-register-navigation'
import { transactionDrawerHref } from './txn-links'

test('account register opens over the current filtered list and closes to the exact list state', () => {
  const opened = accountRegisterHref(
    '/accounts',
    'q=bank&class=asset&page=3&account=stale&txn=old-entry',
    'account-id',
    { to: '2026-07-27' },
  )
  const url = new URL(opened, 'https://openbooks.example')
  assert.equal(url.pathname, '/accounts')
  assert.equal(url.searchParams.get('q'), 'bank')
  assert.equal(url.searchParams.get('class'), 'asset')
  assert.equal(url.searchParams.get('page'), '3')
  assert.equal(url.searchParams.get('account'), 'stale')
  assert.equal(url.searchParams.get('accountRegister'), 'account-id')
  assert.equal(url.searchParams.get('accountRegisterTo'), '2026-07-27')
  assert.equal(url.searchParams.has('txn'), false)

  assert.equal(
    accountRegisterCloseHref('/accounts', url.searchParams.toString()),
    '/accounts?q=bank&class=asset&page=3&account=stale',
  )
})

test('register row opens its native source transaction over the register', () => {
  const opened = transactionDrawerHref({
    pathname: '/accounts',
    query: 'q=bank&accountRegister=account-id&accountRegisterPage=2',
    entryId: 'entry-id',
    docKind: 'vendor_bill',
    docId: 'bill-id',
  })
  const url = new URL(opened, 'https://openbooks.example')
  assert.equal(url.searchParams.get('accountRegister'), 'account-id')
  assert.equal(url.searchParams.get('accountRegisterPage'), '2')
  assert.equal(url.searchParams.get('reportRecord'), 'bill-id')
  assert.equal(url.searchParams.get('reportRecordKind'), 'vendor_bill')
  assert.equal(
    url.searchParams.get('drawerReturn'),
    '/accounts?q=bank&accountRegister=account-id&accountRegisterPage=2',
  )
})

test('GL-only register row opens the shared entry drawer in place', () => {
  const opened = transactionDrawerHref({
    pathname: '/accounts',
    query: 'q=bank&accountRegister=account-id',
    entryId: 'entry-id',
  })
  const url = new URL(opened, 'https://openbooks.example')
  assert.equal(url.searchParams.get('accountRegister'), 'account-id')
  assert.equal(url.searchParams.get('txn'), 'entry-id')
  assert.equal(url.searchParams.has('reportRecord'), false)
})
