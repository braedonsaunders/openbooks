import assert from 'node:assert/strict'
import test from 'node:test'
import { fillFromSchedule, type FillableRow } from './timesheet-fill.ts'

const days = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']
const blank = (): FillableRow => ({ projectId: '', memo: '', hours: ['', '', '', '', '', '', ''], immutable: false })
const options = { projectIds: new Set(['kiln']), blank }

test('bookings fill empty days on their project row and reuse the untouched blank line', () => {
  const result = fillFromSchedule([blank()], [
    { onDate: '2026-10-12', hours: '8.0000', projectId: 'kiln', targetLabel: 'Kiln rebuild' },
    { onDate: '2026-10-13', hours: '7.5000', projectId: 'kiln', targetLabel: 'Kiln rebuild' },
    { onDate: '2026-10-14', hours: '8.0000', projectId: null, targetLabel: 'Training' },
  ], days, options)
  assert.equal(result.filled, 3)
  assert.deepEqual(result.rows.map((row) => [row.projectId, row.memo, row.hours.join(',')]), [
    ['kiln', '', ',8,7.5,,,,'],
    ['', 'Training', ',,,8,,,'],
  ])
})

test('hours already entered and locked rows are never overwritten', () => {
  const entered: FillableRow = { projectId: 'kiln', memo: '', hours: ['', '6', '', '', '', '', ''], immutable: false }
  const locked: FillableRow = { projectId: 'kiln', memo: '', hours: ['', '', '8', '', '', '', ''], immutable: true }
  const result = fillFromSchedule([entered, locked], [
    { onDate: '2026-10-12', hours: '8.0000', projectId: 'kiln', targetLabel: 'Kiln rebuild' },
    { onDate: '2026-10-13', hours: '8.0000', projectId: 'kiln', targetLabel: 'Kiln rebuild' },
    { onDate: '2026-10-15', hours: '8.0000', projectId: 'other', targetLabel: 'Not on the picker' },
  ], days, options)
  assert.equal(result.skipped, 2)
  assert.equal(result.rows[0]!.hours[1], '6')
  assert.equal(result.rows[1]!.hours[2], '8')
  // A project the person cannot charge becomes a memo line instead of a hidden project id.
  assert.deepEqual(result.rows.at(-1), { ...blank(), memo: 'Not on the picker', hours: ['', '', '', '', '8', '', ''] })
})
