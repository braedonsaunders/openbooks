import assert from 'node:assert/strict'
import test from 'node:test'
import { isIsoCalendarDate, isIsoTimestamp } from './crm-dates'

test('isIsoTimestamp accepts the datetime-local and ISO shapes CRM clients send', () => {
  for (const value of [
    '2026-09-05',
    '2026-09-05T10:30',
    '2026-09-05 10:30',
    '2026-09-05T10:30:15',
    '2026-09-05T10:30:15.123',
    '2026-09-05T10:30:15.123456Z',
    '2026-09-05T10:30:00Z',
    '2026-09-05T10:30:00+02:00',
    '2026-09-05T10:30:00-0700',
    '2028-02-29T00:00',
    '2027-02-28T23:59:59',
  ]) {
    assert.equal(isIsoTimestamp(value), true, value)
  }
})

test('isIsoTimestamp refuses free text, impossible fields, and non-strings', () => {
  for (const value of [
    'soon',
    'next week',
    '',
    '   ',
    '20260905T1030',
    '2026-13-01T10:00',
    '2026-02-30T10:00',
    '2027-02-29T00:00',
    '2026-09-05T24:00',
    '2026-09-05T25:00',
    '2026-09-05T10:60',
    '2026-09-05T10:30:60',
    '2026-09-05T10',
    '2026-09-05T10:30:00+25:00',
    '0000-01-01T00:00',
    12,
    null,
    undefined,
    new Date(),
    {},
  ]) {
    assert.equal(isIsoTimestamp(value), false, String(value))
  }
})

test('isIsoCalendarDate is the shared date-only boundary', () => {
  assert.equal(isIsoCalendarDate('2026-03-01'), true)
  assert.equal(isIsoCalendarDate('2026-02-30'), false)
  assert.equal(isIsoCalendarDate('2026-03-01T00:00'), false)
  assert.equal(isIsoCalendarDate('soon'), false)
})
