import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./StatementMatrixTable.tsx', import.meta.url), 'utf8')

test('statement tables stay readable at phone widths', () => {
  // F-t07-008: at 390px the amount cells clipped mid-number past the
  // viewport with no reachable scroll. The table scroller must be a real
  // scroll container (shrinkable, width-capped) and the label column must
  // narrow on phones so single-column statements fit.
  assert.match(
    source,
    /overflow-x-auto/,
    'the statement table must scroll horizontally instead of spilling past the viewport',
  )
  assert.match(
    source,
    /min-w-0/,
    'the scroll container must be shrinkable so flex ancestors cannot stretch it past the viewport',
  )
  assert.match(
    source,
    /min-w-\[10rem\] sm:min-w-\[16rem\]/,
    'the label column must narrow on phones so amounts stay reachable',
  )
})
