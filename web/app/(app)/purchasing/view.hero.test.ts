import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UX-13: the commitments hero sat in a `min-h-[24rem]` panel with its own
// inner scroll inside a `flex-1` grid — stretched and blank beside five
// rows, pushing the rail's next purchase action down. The panel sizes to
// its content like the banking roster hero; the rail keeps the cockpit's
// shared scroll column.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('UX-13: the commitments hero panel sizes to content, never a fixed minimum', () => {
  assert.doesNotMatch(
    source,
    /min-h-\[24rem\]/,
    'no fixed minimum height forces a blank stretch on few rows',
  )
  assert.match(
    source,
    /className: 'self-start lg:col-span-2'/,
    'the hero stays a two-column panel top-aligned to its content',
  )
})

test('UX-13: the hero body carries no inner scroll column', () => {
  assert.match(
    source,
    /bodyClassName: 'p-0',\n\s*className: 'self-start lg:col-span-2'/,
    'the hero body renders the table directly — no nested scroll beside the rail',
  )
})

test('UX-13: the rail keeps the shared cockpit scroll column', () => {
  assert.match(
    source,
    /grid\('flex min-h-0 flex-col gap-5 overflow-y-auto', \[/,
    'pulse, trend, directory, and attention ride the shared scrolling rail',
  )
})
