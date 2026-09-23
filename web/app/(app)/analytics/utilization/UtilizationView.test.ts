import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UX-20: a 0% utilization with no tracked hours is a data prerequisite, not
// a failing team. The overview must say no time was tracked and link the
// timesheets that change it — only when the range is actually empty.
const source = readFileSync(new URL('./UtilizationView.tsx', import.meta.url), 'utf8')

test('zero tracked hours explain the 0% with a timesheets action (UX-20)', () => {
  assert.match(
    source,
    /const noTimeTracked = c\.hours === 0/,
    'the note must trigger on an empty range, never on tracked-but-idle hours',
  )
  assert.match(
    source,
    /\{t\('empty\.noTimeTracked'\)\}/,
    'the note must say no time was tracked',
  )
  assert.match(
    source,
    /href="\/timesheets"[\s\S]*?\{t\('empty\.noTimeTrackedAction'\)\}/,
    'the note must link the timesheets that change the zero',
  )
})
