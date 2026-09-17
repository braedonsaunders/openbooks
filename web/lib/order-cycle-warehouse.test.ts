import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F-coord-004: fulfillment/receipt must refuse a stocked order line with no
// warehouse instead of failing deep in the inventory kernel. The rule is
// pure so the refusal predicate is pinned here without a database; the
// end-to-end legacy shape (refuse → assign → fulfill) is covered by
// order-line-warehouse.integration.test.ts. Only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { missingOrderLineWarehouses, ORDER_LINE_WAREHOUSE_REQUIRED } = await import('./order-cycle.ts')

const PROFILED_NULL = { lineNumber: 1, itemId: 'item-1', hasInventoryProfile: true, stockLocationId: null }

test('the refusal code is a stable contract', () => {
  assert.equal(ORDER_LINE_WAREHOUSE_REQUIRED, 'ORDER_LINE_WAREHOUSE_REQUIRED')
})

test('a warehouseless stocked line is flagged when the default is ambiguous', () => {
  assert.deepEqual(missingOrderLineWarehouses([PROFILED_NULL], 2), [{ lineNumber: 1, itemId: 'item-1' }])
  assert.deepEqual(missingOrderLineWarehouses([PROFILED_NULL], 0), [{ lineNumber: 1, itemId: 'item-1' }])
})

test('a single active warehouse falls back silently, so nothing is refused', () => {
  assert.deepEqual(missingOrderLineWarehouses([PROFILED_NULL], 1), [])
})

test('only stocked lines without a warehouse are flagged', () => {
  const lines = [
    { lineNumber: 1, itemId: 'item-1', hasInventoryProfile: true, stockLocationId: null },
    { lineNumber: 2, itemId: 'item-2', hasInventoryProfile: true, stockLocationId: 'wh-1' },
    { lineNumber: 3, itemId: 'item-3', hasInventoryProfile: false, stockLocationId: null },
    { lineNumber: 4, itemId: null, hasInventoryProfile: false, stockLocationId: null },
  ]
  assert.deepEqual(missingOrderLineWarehouses(lines, 3), [{ lineNumber: 1, itemId: 'item-1' }])
})

test('a blank warehouse counts as missing, like the drawer picker treats it', () => {
  assert.deepEqual(
    missingOrderLineWarehouses([{ ...PROFILED_NULL, stockLocationId: '' }], 2),
    [{ lineNumber: 1, itemId: 'item-1' }],
  )
})
