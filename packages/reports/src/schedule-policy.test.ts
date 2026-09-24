import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeNextRunAt } from './schedule-policy'

test('daily schedules do not skip the DST fall-back day', () => {
  const from = new Date('2026-10-31T23:00:00Z')
  const next = computeNextRunAt(
    { cadence: 'daily', hour: 1, minute: 30, timezone: 'America/Toronto' },
    from,
  )

  assert.ok(
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'].includes(next.toISOString()),
    `expected the November 1 repeated 01:30 occurrence, got ${next.toISOString()}`,
  )
  assert.ok(next.getTime() > from.getTime())
})

test('daily schedules still advance to the next local day normally', () => {
  const next = computeNextRunAt(
    { cadence: 'daily', hour: 1, minute: 30, timezone: 'America/Toronto' },
    new Date('2026-10-30T23:00:00Z'),
  )

  assert.equal(next.toISOString(), '2026-10-31T05:30:00.000Z')
})

test('a 31st monthly schedule fires on short month-ends instead of skipping', () => {
  const input = { cadence: 'monthly' as const, dayOfMonth: 31, hour: 7, minute: 0, timezone: 'UTC' }
  // January has a 31st.
  assert.equal(
    computeNextRunAt(input, new Date('2026-01-30T08:00:00Z')).toISOString(),
    '2026-01-31T07:00:00.000Z',
  )
  // February 2026 has 28 days: clamps to the 28th, not March.
  assert.equal(
    computeNextRunAt(input, new Date('2026-01-31T08:00:00Z')).toISOString(),
    '2026-02-28T07:00:00.000Z',
  )
  // April has 30 days.
  assert.equal(
    computeNextRunAt(input, new Date('2026-03-31T08:00:00Z')).toISOString(),
    '2026-04-30T07:00:00.000Z',
  )
})

test('a 29th monthly schedule respects leap years', () => {
  const input = { cadence: 'monthly' as const, dayOfMonth: 29, hour: 7, minute: 0, timezone: 'UTC' }
  // February 2027 is not a leap year: clamps to the 28th.
  assert.equal(
    computeNextRunAt(input, new Date('2027-01-29T08:00:00Z')).toISOString(),
    '2027-02-28T07:00:00.000Z',
  )
  // February 2028 is a leap year: fires on the 29th itself.
  assert.equal(
    computeNextRunAt(input, new Date('2028-01-29T08:00:00Z')).toISOString(),
    '2028-02-29T07:00:00.000Z',
  )
})
