import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t09-009: Convert-to-Invoice on a fully converted SO fired a 422 ('Every
// line is already fully converted') from a live button next to a badge that
// already says fully converted. The action must disable once nothing is
// convertible instead of offering the dead-end.
const source = readFileSync(new URL('./OrderDrawer.tsx', import.meta.url), 'utf8')
const convertBlock = source.slice(
  source.indexOf('? convertTargets.map((target)'),
  source.indexOf('? convertTargets.map((target)') + 600,
)

test('convert actions disable once the order is fully converted', () => {
  assert.match(convertBlock, /disabled=\{[^}]*converted\.full/)
})
