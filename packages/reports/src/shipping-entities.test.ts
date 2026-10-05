// Behaviour of the shipping report entities: every join pins the org
// (a label must never read across legal boundaries), minor-unit costs
// convert to major units with a visible fallback, and voided labels and
// pending adjustments stay listed instead of silently dropping.
import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from './entities.ts'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins.ts'

function joinLines(from: string): string[] {
  return from.split('\n').filter((line) => /\bJOIN\b/i.test(line))
}

test('shipping label joins pin the org except global reference data', () => {
  const entity = REPORT_ENTITY_MAP.shipment_labels
  assert.ok(entity)
  assert.equal(entity.featureKey, 'shippingHub')
  assert.equal(entity.requiredPermission, 'orders.fulfill')
  const joins = joinLines(entity.from)
  assert.ok(joins.length >= 4, 'labels join fulfillment docs, documents, order and account')
  for (const join of joins) {
    if (/currencies/i.test(join)) continue
    assert.match(join, /org_id/i, join.trim())
  }
})

test('shipping label cost converts minor units and keeps every state', () => {
  const entity = REPORT_ENTITY_MAP.shipment_labels!
  const amount = entity.columns.find((column) => column.key === 'amount')
  assert.ok(amount)
  assert.equal(amount.kind, 'money')
  assert.match(amount.expr, /rate_minor/)
  assert.match(amount.expr, /minor_units/)
  const status = entity.columns.find((column) => column.key === 'status')
  assert.deepEqual(status?.options, ['purchased', 'voided', 'refunded'])
  const tracking = entity.columns.find((column) => column.key === 'tracking_status')
  assert.ok(tracking?.options?.includes('delivered') && tracking?.options?.includes('exception'))
})

test('carrier adjustments list pending rows by carrier and reason', () => {
  const entity = REPORT_ENTITY_MAP.shipping_adjustments
  assert.ok(entity)
  assert.equal(entity.featureKey, 'shippingHub')
  assert.equal(entity.requiredPermission, 'shipping.manage')
  for (const join of joinLines(entity.from)) {
    if (/currencies/i.test(join)) continue
    assert.match(join, /org_id/i, join.trim())
  }
  const kind = entity.columns.find((column) => column.key === 'kind')
  assert.ok(kind?.options?.includes('weight_correction') && kind?.options?.includes('duplicate'))
  assert.deepEqual(
    entity.columns.find((column) => column.key === 'status')?.options,
    ['pending', 'posted', 'disputed'],
  )
})

test('shipping built-ins resolve rows plus cost by carrier', () => {
  for (const slug of ['shipment-labels', 'shipping-adjustments', 'shipping-cost-by-carrier']) {
    assert.ok(BUILT_IN_REPORT_DEFINITION_MAP[slug], slug)
  }
  const cost = BUILT_IN_REPORT_DEFINITION_MAP['shipping-cost-by-carrier']!
  assert.equal(cost.query.entity, 'shipment_labels')
  assert.equal(cost.query.mode, 'summarize')
})
