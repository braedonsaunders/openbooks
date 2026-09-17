import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8')

/**
 * F-t05-010 — at 1024px the five-across KPI tiles ellipsize their titles
 * ("CARD BALAN…", "OPEN RECON…") and sub-text ("all lines matc…"). Labels
 * and subs must wrap legibly; only the tabular value stays single-line.
 */
test('stat tile labels and subs wrap instead of clipping', () => {
  const labelLine = source
    .split('\n')
    .find((line) => line.includes('tracking-wide') && line.includes('uppercase'))
  assert.ok(labelLine, 'the tile label line must exist')
  assert.ok(!labelLine.includes('truncate'), `the tile label must not truncate: ${labelLine.trim()}`)
  assert.match(labelLine, /leading-tight|leading-snug/, 'the wrapped label must stay compact')
})

test('stat tile values stay single-line tabular numbers', () => {
  const valueLine = source
    .split('\n')
    .find((line) => line.includes('text-2xl') && line.includes('tabular-nums'))
  assert.ok(valueLine, 'the tile value line must exist')
  assert.ok(valueLine.includes('truncate'), 'the value must stay single-line')
})
