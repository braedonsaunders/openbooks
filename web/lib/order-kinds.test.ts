import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CONVERSION_TARGETS } from './order-kinds.ts'

// F-t07-002: an Approved sales order was a dead end — Convert to Invoice
// 422'd "Fulfilled quantities do not cover any line yet" while no fulfil
// control existed anywhere. A sales order must offer the shipment first,
// mirroring the purchase-order goods-receipt target (same link, same
// remainder semantics, same SHIP- numbering the engine already issues).
test('sales orders convert to a shipment before they bill', () => {
  assert.deepEqual(
    CONVERSION_TARGETS.sales_order.map((target) => target.kind),
    ['sales_fulfillment', 'customer_invoice'],
  )
  assert.deepEqual(CONVERSION_TARGETS.sales_order[0], {
    kind: 'sales_fulfillment',
    labelKey: 'kinds.shipment',
    prefix: 'SHIP-',
    link: 'fulfills',
  })
  assert.deepEqual(
    CONVERSION_TARGETS.purchase_order.map((target) => target.kind),
    ['purchase_receipt', 'vendor_bill'],
  )
})

// Every convert button renders through t(labelKey) in the
// purchaseOrders.shared namespace — a missing key leaks a raw key into the
// drawer (the F-t07-004 class of defect). All seven locales must label
// every conversion target, including the purchase-receipt key only English
// carried until F-t07-002.
const MESSAGES = join(import.meta.dirname, '..', 'messages')
const LOCALES = ['en', 'fr', 'de', 'es', 'pt-BR', 'ja', 'zh']
const TARGETS = Object.values(CONVERSION_TARGETS).flat()

for (const target of TARGETS) {
  const key = target.labelKey.replace(/^kinds\./, '')
  for (const locale of LOCALES) {
    test(`${locale} labels the convert target ${target.labelKey}`, () => {
      const catalog = JSON.parse(
        readFileSync(join(MESSAGES, locale, 'purchaseOrders.json'), 'utf8'),
      ) as { shared?: { kinds?: Record<string, string> } }
      const label = catalog.shared?.kinds?.[key]
      assert.ok(
        label && label !== target.labelKey && !label.includes('.'),
        `${locale} is missing purchaseOrders.shared.${target.labelKey}`,
      )
    })
  }
}
