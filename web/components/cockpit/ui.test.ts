import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8')

/**
 * F-t05-010 / F-t12-012 — KPI tiles used to ellipsize titles, values, and
 * subs ("CARD BALAN…", "ACTIVE CU…", "CA$…"). Every line wraps; the
 * tabular value also break-words so figures without spaces do not clip.
 */
test('stat tile labels and subs wrap instead of clipping', () => {
  const labelLine = source
    .split('\n')
    .find((line) => line.includes('tracking-wide') && line.includes('uppercase'))
  assert.ok(labelLine, 'the tile label line must exist')
  assert.ok(!labelLine.includes('truncate'), `the tile label must not truncate: ${labelLine.trim()}`)
  assert.match(labelLine, /leading-tight|leading-snug/, 'the wrapped label must stay compact')
})

test('stat tile values wrap long figures instead of clipping', () => {
  const valueLine = source
    .split('\n')
    .find((line) => line.includes('text-2xl') && line.includes('tabular-nums'))
  assert.ok(valueLine, 'the tile value line must exist')
  assert.ok(!valueLine.includes('truncate'), 'the value must wrap, never ellipsis')
  assert.match(valueLine, /break-words/, 'unbroken figures must wrap mid-string')
})
