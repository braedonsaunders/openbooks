import assert from 'node:assert/strict'
import test from 'node:test'
import { accountParentPath, orderAccountHierarchy } from './account-hierarchy'

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

test('keeps cross-class and cyclic legacy accounts visible as roots', () => {
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
