import assert from 'node:assert/strict'
import test from 'node:test'
import { formatWindow } from './rule-window.ts'

test('window cells render the range or the open-ended label', () => {
  assert.equal(formatWindow('2026-01-01', '2026-12-31', 'open-ended'), '2026-01-01 – 2026-12-31')
  assert.equal(formatWindow('2027-01-01', null, 'open-ended'), '2027-01-01 – open-ended')
})
