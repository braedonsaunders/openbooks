import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-003 pickers: the order drawer must offer a line-level warehouse
// picker exactly when the choice is real (several active locations) and
// only on stocked rows — and persist the choice through the draft writer.
const drawer = readFileSync(new URL('./OrderDrawer.tsx', import.meta.url), 'utf8')
const handlers = readFileSync(new URL('../../api/_order/handlers.ts', import.meta.url), 'utf8')
const lib = readFileSync(new URL('../../api/_order/lib.ts', import.meta.url), 'utf8')

test('the order drawer models a per-line warehouse', () => {
  assert.match(drawer, /stockLocationId: string/, 'LineRow carries the line warehouse')
  assert.match(drawer, /stock_location_id \?\? ''/, 'stored lines hydrate the row')
  assert.match(drawer, /stockLocationId: r\.stockLocationId \|\| null/, 'the save payload sends the choice')
})

test('the order picker shows only for several locations and stocked rows', () => {
  assert.match(drawer, /stockLocations\.length < 2/, 'a single location never asks a question')
  assert.match(drawer, /isCellEditable/, 'non-stocked rows get no picker control')
  assert.match(drawer, /labels\.warehouse/, 'the column labels through the shared key')
})

test('the order draft writer persists a validated line warehouse', () => {
  assert.match(lib, /stockLocationId\?: string \| null/, 'OrderLineInput accepts the choice')
  assert.match(handlers, /resolveLineStockLocation/, 'PATCH resolves every submitted line')
  assert.match(handlers, /stock_location_id/, 'the line re-insert stores the resolution')
})
