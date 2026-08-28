import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextPeriod, runPayload, type RunSchedule } from './NewRunButton'

const schedule = (overrides: Partial<RunSchedule> = {}): RunSchedule => ({
  id: 'schedule-1',
  name: 'Monthly month-end',
  frequency: 'monthly',
  pay_date_offset_days: 5,
  next_period_start: '2026-02-01',
  next_period_end: '2026-02-28',
  next_pay_date: '2026-03-05',
  ...overrides,
})

test('a January 31 monthly anchor previews February 1 through February 28', () => {
  assert.deepEqual(
    nextPeriod(schedule()),
    { start: '2026-02-01', end: '2026-02-28', payDate: '2026-03-05' },
  )
})

test('an untouched dialog lets the server derive the period canonically', () => {
  const shown = { start: '2026-02-01', end: '2026-02-28', payDate: '2026-03-05' }
  assert.deepEqual(runPayload('schedule-1', shown, 'regular', [], false), {
    payScheduleId: 'schedule-1',
    runType: 'regular',
    employeePartyIds: [],
  })
})

test('editing a date keeps the explicit off-cycle window', () => {
  const shown = { start: '2026-02-03', end: '2026-02-28', payDate: '2026-03-05' }
  assert.deepEqual(runPayload('schedule-1', shown, 'bonus', [], true), {
    payScheduleId: 'schedule-1',
    periodStart: '2026-02-03',
    periodEnd: '2026-02-28',
    payDate: '2026-03-05',
    runType: 'bonus',
    employeePartyIds: [],
  })
})

test('the runs page derives the preview from the anchor and actual run history', () => {
  const source = readFileSync(new URL('../runs/page.tsx', import.meta.url), 'utf8')
  assert.match(source, /s\.anchor_period_end::text as anchor_period_end/)
  assert.match(source, /max\(r\.period_end\)::text as last_end/)
  assert.match(source, /nextPeriodAfter\(schedule, schedule\.last_end\)/)
})
