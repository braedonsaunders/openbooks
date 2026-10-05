// Boundary behaviour of the carrier adjustment import: pasted billing text
// parses to import rows, and every unusable paste refuses by name with the
// fix — the operator is mid-reconciliation and must not lose the paste to a
// raw syntax error.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAdjustmentItems } from './adjustment-import.ts'

const ROW = {
  providerAdjustmentId: 'adj-1',
  providerShipmentId: 'shp-9',
  kind: 'weight_correction',
  amount: '2.50',
  currency: 'USD',
}

test('a usable paste parses to import rows', () => {
  const parsed = parseAdjustmentItems(JSON.stringify([ROW, { ...ROW, providerAdjustmentId: 'adj-2' }]))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.items.length, 2)
})

test('a single object parses as one row', () => {
  const parsed = parseAdjustmentItems(JSON.stringify(ROW))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.items[0]?.providerAdjustmentId, 'adj-1')
})

test('empty text refuses with the fix', () => {
  const parsed = parseAdjustmentItems('   ')
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Paste the billing export/)
})

test('broken JSON refuses with its position', () => {
  const parsed = parseAdjustmentItems('[{"providerAdjustmentId":')
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /not valid JSON/)
})

test('a row missing its identity refuses by name', () => {
  const { providerAdjustmentId: _dropped, ...rest } = ROW
  const parsed = parseAdjustmentItems(JSON.stringify([rest]))
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /row 1.*providerAdjustmentId/)
})

test('an unknown kind refuses with the six it accepts', () => {
  const parsed = parseAdjustmentItems(JSON.stringify([{ ...ROW, kind: 'mystery' }]))
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /weight_correction/)
})

test('a non-object paste refuses instead of importing nothing', () => {
  for (const text of ['"just a string"', '42', 'null']) {
    const parsed = parseAdjustmentItems(text)
    assert.equal(parsed.ok, false, text)
  }
})
