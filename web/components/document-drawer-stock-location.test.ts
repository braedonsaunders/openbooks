import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-003 pickers: the invoice drawer must offer a line-level warehouse
// picker on customer invoices exactly when the choice is real (several
// active locations) and only on stocked rows — and persist the choice
// through the generic edit writer.
const drawer = readFileSync(new URL('./document-drawer.tsx', import.meta.url), 'utf8')

test('the invoice drawer models a per-line warehouse', () => {
  assert.match(drawer, /stockLocationId: string/, 'LineRow carries the line warehouse')
  assert.match(drawer, /stock_location_id \?\? ''/, 'stored lines hydrate the row')
  assert.match(drawer, /stockLocationId: r\.stockLocationId \|\| null/, 'the save payload sends the choice')
})

test('the invoice picker shows only for several locations and stocked rows', () => {
  assert.match(drawer, /recordType === 'customer_invoice'/, 'the picker is scoped to customer invoices')
  assert.match(drawer, /stockLocations \?\? \[\]\)\.length > 1/, 'a single location never asks a question')
  assert.match(drawer, /isCellEditable/, 'non-stocked rows get no picker control')
  assert.match(drawer, /labels\.warehouse/, 'the column labels through the shared key')
})

test('the shared grid honors per-row edit gates', () => {
  const grid = readFileSync(new URL('./line-grid.tsx', import.meta.url), 'utf8')
  assert.match(grid, /isCellEditable\?: \(row: Row, index: number\) => boolean/, 'columns declare the gate')
})
