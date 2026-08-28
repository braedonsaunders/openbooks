import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { accountParentPath, orderAccountHierarchy } from './account-hierarchy'
import { decimalAdd, decimalCmp, decimalSum } from './statement-format'

const CLASS_OF = { asset_bank: 'asset', expense: 'expense' }

test('orders accounts parent-first within one statement class', () => {
  const rows = [
    { id: 'parent', parent_id: null, name: 'Cash', type: 'asset_bank' },
    { id: 'child', parent_id: 'parent', name: 'Operating', type: 'asset_bank' },
    { id: 'expense', parent_id: null, name: 'Rent', type: 'expense' },
  ]
  const result = orderAccountHierarchy(rows, 'asset', CLASS_OF)
  assert.deepEqual(result.ordered.map((row) => row.id), ['parent', 'child'])
  assert.equal(result.parentIds.get('child'), 'parent')
})

test('keeps cross-class and cyclic imported accounts visible as roots', () => {
  const rows = [
    { id: 'asset', parent_id: 'expense', name: 'Cash', type: 'asset_bank' },
    { id: 'expense', parent_id: null, name: 'Rent', type: 'expense' },
    { id: 'cycle-a', parent_id: 'cycle-b', name: 'A', type: 'asset_bank' },
    { id: 'cycle-b', parent_id: 'cycle-a', name: 'B', type: 'asset_bank' },
  ]
  const result = orderAccountHierarchy(rows, 'asset', CLASS_OF)
  assert.deepEqual(result.ordered.map((row) => row.id), ['asset', 'cycle-a', 'cycle-b'])
  assert.equal(result.parentIds.get('asset'), null)
  assert.equal(result.parentIds.get('cycle-a'), null)
  assert.equal(result.parentIds.get('cycle-b'), null)
})

test('builds a bounded parent breadcrumb', () => {
  const rows = [
    { id: 'root', parent_id: null, name: 'Expenses', type: 'expense' },
    { id: 'parent', parent_id: 'root', name: 'Facilities', type: 'expense' },
    { id: 'leaf', parent_id: 'parent', name: 'Rent', type: 'expense' },
  ]
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(accountParentPath(rows[2]!, byId), 'Expenses / Facilities')
})

test('roll-up arithmetic remains exact for large and fractional ledger balances', () => {
  const balances = ['9007199254740.9911', '0.0089', '0.1000']
  const childTotal = decimalSum(balances.slice(0, 2))
  const parentTotal = decimalAdd(childTotal, balances[2]!)
  const accounts = [
    { id: 'parent', parent_id: null, name: 'Cash', type: 'asset_bank', balance: balances[0]! },
    { id: 'child', parent_id: 'parent', name: 'Operating', type: 'asset_bank', balance: balances[1]! },
  ]
  const byId = new Map(accounts.map((account) => [account.id, account]))
  const rolled = new Map(accounts.map((account) => [account.id, account.balance]))
  for (const account of accounts) {
    let parentId = account.parent_id
    while (parentId) {
      rolled.set(parentId, decimalAdd(rolled.get(parentId)!, account.balance))
      parentId = byId.get(parentId)?.parent_id ?? null
    }
  }

  assert.equal(childTotal, '9007199254741.0000')
  assert.equal(parentTotal, '9007199254741.1000')
  assert.equal(rolled.get('parent'), '9007199254741.0000')
  assert.equal(decimalCmp(parentTotal, '0.0000'), 1)
})

test('accounts hierarchy keeps exact arithmetic at the query-to-tree boundary', () => {
  const page = readFileSync(new URL('../app/(app)/accounts/page.tsx', import.meta.url), 'utf8')

  assert.match(page, /new Map<string, string>\(accounts\.map\(\(a\) => \[a\.id, a\.balance\]\)\)/)
  assert.match(page, /rolled\.set\(p, decimalAdd\(rolled\.get\(p\) \?\? '0\.0000', a\.balance\)\)/)
  assert.match(page, /const classBalance = decimalSum\(classAccounts\.map\(\(account\) => account\.balance\)\)/)
  assert.doesNotMatch(page, /Number\(a\.balance\)/)
  assert.doesNotMatch(page, /Number\(account\.balance\)/)
})

test('account balance SQL distinguishes unrestricted, restricted, and empty scopes', () => {
  const data = readFileSync(new URL('./data.ts', import.meta.url), 'utf8')

  // null/undefined are the only unrestricted sentinels; a present empty set
  // contributes the deny-all predicate instead of widening to org scope.
  assert.match(data, /allowedSubsidiaryIds\?: ReadonlySet<string> \| null/)
  assert.match(data, /allowedSubsidiaryIds == null\s*\n\s*\? sql``/)
  assert.match(data, /allowedSubsidiaryIds\.size === 0\s*\n\s*\? sql`and false`/)
  assert.match(data, /a\.subsidiary_id is null or a\.subsidiary_id = any/)
  assert.match(data, /subsidiaryVisibleFilter\(sql`g\.subsidiary_id`, allowedSubsidiaryIds \?\? null\)/)
  assert.match(data, /subsidiaryVisibleFilter\(sql`l\.subsidiary_id`, allowedSubsidiaryIds \?\? null\)/)
})

test('both chart-of-accounts callers forward subsidiary scope and preserve balance text', () => {
  const page = readFileSync(new URL('../app/(app)/accounts/page.tsx', import.meta.url), 'utf8')
  const assistant = readFileSync(new URL('./assistant/tools.ts', import.meta.url), 'utf8')

  assert.match(page, /accountsWithBalances\(authz\.user\.orgId, undefined, authz\.allowedSubsidiaryIds\)/)
  assert.match(assistant, /accountsWithBalances\(authz\.user\.orgId, a\.asOf, authz\.allowedSubsidiaryIds\)/)
  assert.match(assistant, /balance: r\.balance/)
})
