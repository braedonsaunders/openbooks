import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-coord-004: approved orders predating the line warehouse picker carry
// NULL warehouses and are storage-immutable, so fulfillment failed closed
// with no way forward. The way forward is a narrow assign-warehouse action
// (not a reopened draft edit): these pins hold the wiring without a
// database — the refusal/assign behavior itself is covered by
// order-line-warehouse.integration.test.ts.
const handlers = readFileSync(new URL('./handlers.ts', import.meta.url), 'utf8')
const cycle = readFileSync(new URL('../../../lib/order-cycle.ts', import.meta.url), 'utf8')
const salesRoute = readFileSync(
  new URL('../sales-orders/[id]/assign-warehouse/route.ts', import.meta.url),
  'utf8',
)
const purchaseRoute = readFileSync(
  new URL('../purchase-orders/[id]/assign-warehouse/route.ts', import.meta.url),
  'utf8',
)

test('the assign-warehouse action is wired for both order kinds', () => {
  assert.match(handlers, /makeAssignWarehousePOST/, 'the shared maker exists')
  assert.match(handlers, /assignOrderLineWarehouse\(/, 'the maker calls the order-cycle writer')
  assert.match(salesRoute, /kind: 'sales_order'/, 'the sales route binds its kind')
  assert.match(purchaseRoute, /kind: 'purchase_order'/, 'the purchase route binds its kind')
  assert.match(handlers, /sales and purchase orders only/, 'other kinds are refused')
})

test('the writer reopens instead of editing approved lines in place', () => {
  assert.match(cycle, /migration 0034/, 'the immutability reason is stated')
  assert.match(cycle, /set status = 'draft'/, 'the header reopens inside the transaction')
  assert.match(cycle, /set status = 'approved'/, 'approved is restored before commit')
  assert.match(cycle, /order_line_warehouse_assigned/, 'the assignment is audited')
})

test('the refusal names the line with a typed code', () => {
  assert.match(cycle, /ORDER_LINE_WAREHOUSE_REQUIRED/, 'the refusal carries a machine code')
  assert.match(cycle, /assign a warehouse to the line/, 'the refusal names the way forward')
})
