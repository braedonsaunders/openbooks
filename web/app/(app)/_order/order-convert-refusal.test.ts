import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t03-001: "Convert to Goods receipt" on an expense-line-only PO 422s
// ("line 1 is not stock and is billed on a two-way match, not received")
// and the drawer only toasted — no toast survives attention, and the PO
// just sits Approved. A convert refusal must pin as a record-level alert
// until the next action, carrying the server's typed reason.
const source = readFileSync(new URL('./OrderDrawer.tsx', import.meta.url), 'utf8')

test('a convert refusal pins as an alert, not only a toast (F-t03-001)', () => {
  const convertBlock = source.slice(
    source.indexOf('async function convert('),
    source.indexOf('async function convert(') + 1800,
  )
  assert.match(
    convertBlock,
    /setActionError\(/,
    'the convert failure branch must pin the typed reason as an alert',
  )
})

test('the order drawer renders a record-level alert region (F-t03-001)', () => {
  assert.match(
    source,
    /role="alert"/,
    'the drawer must render a role=alert region for pinned refusals',
  )
})
