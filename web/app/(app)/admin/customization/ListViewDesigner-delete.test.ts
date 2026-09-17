import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ListViewDesigner.tsx', import.meta.url), 'utf8')

/**
 * F-t05-011 — deleting a saved list view fired on one click with no
 * confirmation (compare: rule Delete raises a native confirm). The view
 * delete must confirm first, mirroring the FormDesigner F-t10-004 guard.
 */
test('deleting a saved list view confirms before the DELETE goes out', () => {
  assert.match(
    source,
    /async function remove\(\)[\s\S]{0,400}confirm\(/,
    'remove() must ask for confirmation before deleting the view',
  )
  assert.match(
    source,
    /deleteConfirm/,
    'the confirmation names the consequence through a localized string',
  )
})
