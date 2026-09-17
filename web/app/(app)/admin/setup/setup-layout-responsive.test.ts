import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t11-009: every /admin/setup/* page squeezed its content to ~170px at
// 390px because the rail and panel rendered side by side. The shared setup
// shell now stacks the rail above the content below sm (pure CSS, no new
// strings or state), so all 24 setup routes inherit the fix. These pins
// hold the responsive contract; the 390px visual itself is the tester's
// screenshot pass (no authed browser in this environment).
const layout = readFileSync(new URL('./layout.tsx', import.meta.url), 'utf8')
const nav = readFileSync(new URL('./SetupNav.tsx', import.meta.url), 'utf8')

test('the setup body stacks below sm and keeps the rail at sm and up', () => {
  assert.match(layout, /flex-col sm:flex-row/, 'body stacks, then rows')
  assert.match(layout, /w-full/, 'the rail takes full width when stacked')
  assert.match(layout, /sm:w-52/, 'the desktop rail width is unchanged')
  assert.match(layout, /border-b/, 'the stacked rail divides horizontally')
  assert.match(layout, /sm:border-r sm:border-b-0/, 'the desktop rail divides vertically')
})

test('the nav becomes a horizontal strip below sm and the grouped rail at sm and up', () => {
  assert.match(nav, /flex-row.*sm:flex-col/, 'groups sit side by side, then stack')
  assert.match(nav, /overflow-x-auto/, 'the strip scrolls sideways')
  assert.match(nav, /sm:overflow-visible/, 'the rail does not clip')
  assert.match(nav, /hidden.*sm:block/, 'group headings hide in the strip')
  assert.match(nav, /shrink-0/, 'strip entries never squeeze')
})
