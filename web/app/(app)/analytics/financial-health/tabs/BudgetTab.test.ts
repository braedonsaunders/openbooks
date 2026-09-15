import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./BudgetTab.tsx', import.meta.url), 'utf8')

test('budget CSV exports retain decimal money values', () => {
  assert.match(source, /filtered\.map\(\(r\) => \[r\.name, r\.type, r\.budget, r\.actual, r\.variance, /)
  assert.doesNotMatch(source, /Math\.round\(r\.(?:budget|actual|variance)\)/)
})
