import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UX-20: the automations page repeated its empty state — the empty-state
// card AND the table's own empty copy rendered together. The table now
// hides while nothing exists, leaving the single intentional empty card.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('one intentional empty state: the table hides when nothing exists (UX-20)', () => {
  assert.match(
    source,
    /hasRows: automations\.length > 0/,
    'the loader must report whether anything exists',
  )
  assert.match(
    source,
    /when: f\('hasRows'\)/,
    'the table must hide while nothing exists instead of repeating the empty card',
  )
  assert.match(
    source,
    /when: f\('isEmpty'\)/,
    'the single empty-state card still owns the empty page',
  )
})
