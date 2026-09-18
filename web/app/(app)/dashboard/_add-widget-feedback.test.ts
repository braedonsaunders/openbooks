import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Fleet-8 dx: palette adds appended the widget at the bottom with no feedback
// — off-screen on a tall dashboard the click read as "nothing happened" —
// and a rapid double-click appended the widget twice, because the duplicate
// check ran on stale render state outside the state update.
const grid = readFileSync(new URL('./_dashboard-grid.tsx', import.meta.url), 'utf8')
const palette = readFileSync(new URL('./_widget-palette.tsx', import.meta.url), 'utf8')

test('adding a widget scrolls it into view with a highlight', () => {
  assert.match(
    grid,
    /scrollIntoView/,
    'the grid must bring a just-added cell into view',
  )
  assert.match(
    grid,
    /flashId/,
    'the grid must track the just-added cell for its highlight',
  )
  assert.match(
    grid,
    /ring-teal-500/,
    'the just-added cell must carry a visible highlight ring',
  )
})

test('duplicate adds collapse inside the state update', () => {
  assert.match(
    grid,
    /prev\.some\(\(x\) => x\.id === id\)/,
    'the append path must re-check presence inside the functional update',
  )
})

test('already-placed widgets stay out of the picker and return on remove', () => {
  // The picker's placed-set derives from live layout state, so removing a
  // widget re-offers it — no separate bookkeeping to drift.
  assert.match(
    grid,
    /new Set\(layout\.map\(\(w\) => w\.id\)\)/,
    'presence must derive from layout state, not a parallel list',
  )
  assert.match(
    palette,
    /!present\.has\(w\.id\)/,
    'the picker must hide already-placed widgets',
  )
})
