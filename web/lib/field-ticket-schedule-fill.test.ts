import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScheduledWork } from '@openbooks/engine/src/schedule-boards/prefill.ts'
import { fillTicketFromSchedule } from './field-ticket-schedule-fill.ts'

const input = { projectId: 'project', days: ['2026-10-08', '2026-10-09'], timeTypeId: 'regular' }
const work = (override: Partial<ScheduledWork> = {}): ScheduledWork => ({
  entryId: 'booking', boardName: 'Field', workerPartyId: 'worker', workerName: 'Employee',
  onDate: '2026-10-08', hours: '0.1000', projectId: 'project', projectTaskId: null,
  targetLabel: 'Job', detail: null, startsAt: '', endsAt: '', ...override,
})

test('split bookings aggregate exact hours and preserve their task assignments', () => {
  const result = fillTicketFromSchedule([], [work(), work({ hours: '0.2000' }), work({ projectTaskId: 'task', hours: '7.7000' })], input)
  assert.equal(result.filled, 1)
  assert.equal(result.rows[0]?.cells['regular|2026-10-08'], '0.3000')
  assert.equal(result.rows[1]?.cells['regular|2026-10-08'], '7.7000')
  assert.equal(result.rows[1]?.projectTaskId, 'task')
})

test('existing hours and unfinished edits win across every time type, item and task', () => {
  const original = [{ employeePartyId: 'worker', itemId: 'labor', projectTaskId: 'other-task',
    cells: { 'overtime|2026-10-08': '3.5', 'regular|2026-10-09': '-' } }]
  const result = fillTicketFromSchedule(original, [work(), work({ onDate: '2026-10-09' })], input)
  assert.deepEqual(result.rows, original)
  assert.equal(result.filled, 0)
  assert.equal(result.skipped, 2)
})

test('repeat fill preserves the grid and other projects and dates are excluded', () => {
  const scheduled = [work(), work({ projectId: 'other' }), work({ onDate: '2026-10-10' })]
  const first = fillTicketFromSchedule([], scheduled, input)
  const replay = fillTicketFromSchedule(first.rows, scheduled, input)
  assert.equal(first.rows.length, 1)
  assert.equal(first.filled, 1)
  assert.equal(replay.filled, 0)
  assert.deepEqual(replay.rows, first.rows)
})
