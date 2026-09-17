import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t09-008: the PO→goods-receipt 422 names a missing received-not-billed
// account the operator cannot see — the item costing read view renders every
// other offset account but omits the RNB row even when set. The read view
// must show it so the fix is discoverable.
const source = readFileSync(new URL('./ItemCostingEditor.tsx', import.meta.url), 'utf8')
const readView = source.slice(source.indexOf('loaded && !profile'))

test('the costing read view shows the received-not-billed account', () => {
  assert.match(readView, /Detail label=\{t\('receivedNotBilledAccount'\)\} value=\{accountLabel\(profile\.received_not_billed_account_id\)\}/)
})
