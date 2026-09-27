import assert from 'node:assert/strict'
import test from 'node:test'
import { plannedTimesheetRows, type PlannedRow } from './timesheet-prefill.ts'

const plan = (projectId: string, itemId: string | null = 'item-1'): PlannedRow => ({ projectId, itemId, isBillable: true, plannedHours: '8.0000' })
const existing = (projectId: string, itemId: string | null = 'item-1') => ({ projectId, itemId, isBillable: true })

test('planned rows are added only when visible and not already represented', () => {
  const cases = [
    { name: 'unmatched booking', planned: [plan('p1')], current: [], options: ['p1'], rows: [plan('p1')], badges: [] },
    { name: 'matching row gets a badge', planned: [plan('p1')], current: [existing('p1')], options: ['p1'], rows: [], badges: [0] },
    { name: 'project outside picker is dropped', planned: [plan('p1')], current: [], options: ['p2'], rows: [], badges: [] },
    { name: 'different items stay separate', planned: [plan('p1', 'i1'), plan('p1', 'i2')], current: [], options: ['p1'], rows: [plan('p1', 'i1'), plan('p1', 'i2')], badges: [] },
  ]
  for (const entry of cases) {
    assert.deepEqual(plannedTimesheetRows(entry.planned, entry.current, new Set(entry.options)), {
      rows: entry.rows,
      badgeOnExisting: entry.badges,
    }, entry.name)
  }
})
