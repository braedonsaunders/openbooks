import assert from 'node:assert/strict'
import test from 'node:test'
import { localTimeFields, resolveLocalTime } from './zoned-date-time'

test('daylight-saving gaps never normalize to another time and repeated hours retain both exact instants', () => {
  assert.equal(resolveLocalTime({ date: '2026-03-08', time: '02:30:00' }, 'America/Toronto').kind, 'gap')
  assert.deepEqual(resolveLocalTime({ date: '2026-11-01', time: '01:30:00' }, 'America/Toronto').choices, [
    { instant: '2026-11-01T05:30:00.000Z', offset: 'UTC-04:00' },
    { instant: '2026-11-01T06:30:00.000Z', offset: 'UTC-05:00' },
  ])
  assert.equal(resolveLocalTime({ date: '2026-04-05', time: '01:45:00' }, 'Australia/Lord_Howe').choices.length, 2)
})
test('local fields round-trip exact instants across fractional offsets and preserve seconds', () => {
  for (const zone of ['UTC', 'Asia/Kathmandu', 'Pacific/Chatham', 'Australia/Lord_Howe', 'America/Toronto']) {
    const instant = '2026-01-09T23:58:17.000Z'
    const local = localTimeFields(instant, zone)!
    assert.ok(
      resolveLocalTime(local, zone).choices.some((choice) => choice.instant === instant),
      `${zone} must preserve the selected instant`,
    )
  }
  for (const local of [
    { date: '2026-02-30', time: '10:00' },
    { date: '2026-01-09', time: '24:00' },
  ])
    assert.equal(resolveLocalTime(local, 'UTC').kind, 'invalid')
  for (const zone of ['unknown', '+03:00'])
    assert.equal(resolveLocalTime({ date: '2026-01-09', time: '10:00' }, zone).kind, 'invalid')
})
