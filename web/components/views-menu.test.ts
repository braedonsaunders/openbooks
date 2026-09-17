import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./views-menu.tsx', import.meta.url), 'utf8')

// F-t09-013 residual: the trigger button translates the unrenamed seeded
// view through displayListViewName, but the dropdown rows rendered the raw
// stored name — "Default view" leaked back in fr the moment the menu opened.
test('the views dropdown translates the unrenamed seeded view', () => {
  assert.doesNotMatch(
    source,
    /\{v\.name\}/,
    'a raw stored view name reads English for the seeded baseline in every locale',
  )
  assert.match(
    source,
    /displayListViewName\(v\.name/,
    'dropdown rows must resolve through the same seeded-name helper as the trigger',
  )
})
