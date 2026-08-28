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
