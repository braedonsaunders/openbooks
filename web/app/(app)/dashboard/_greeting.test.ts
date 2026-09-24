import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGreeting } from './_greeting'

const copy = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' }

/**
 * The greeting is the one string both dashboard render paths share: the
 * loader in view.ts is the only caller, and it imports the
 * same `buildGreeting`, so a drift between two copies cannot desync the
 * conformance comparison. These pin the time boundaries and the name
 * handling that the shared helper owns.
 */
test('dashboard greeting picks the stem by hour of day', () => {
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 8, 30)), 'Ada', copy, 'UTC', 'en'), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 12, 0)), 'Ada', copy, 'UTC', 'en'), 'Good afternoon, Ada')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 16, 59)), 'Ada', copy, 'UTC', 'en'), 'Good afternoon, Ada')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 17, 0)), 'Ada', copy, 'UTC', 'en'), 'Good evening, Ada')
})

/**
 * The stem follows the VIEWER's clock, never the server's. 8:10 PM EDT is
 * 00:10 UTC: a UTC server saying "Good morning" at that instant is the
 * production defect — in America/Toronto it is evening.
 */
test('dashboard greeting resolves the hour in the given time zone', () => {
  // 2026-09-15T00:10:00Z: 8:10 PM EDT the previous day, 2:10 PM in Kiritimati.
  const instant = new Date('2026-09-15T00:10:00.000Z')
  assert.equal(buildGreeting(instant, 'Ada', copy, 'America/Toronto', 'fr'), 'Good evening, Ada')
  assert.equal(buildGreeting(instant, 'Ada', copy, 'Pacific/Kiritimati', 'fr'), 'Good afternoon, Ada')
  assert.equal(buildGreeting(instant, 'Ada', copy, 'UTC', 'fr'), 'Good morning, Ada')
})

test('dashboard greeting falls back to UTC for an unknown time zone', () => {
  const instant = new Date('2026-09-15T00:10:00.000Z')
  assert.equal(buildGreeting(instant, 'Ada', copy, 'Not/AZone', 'en'), 'Good morning, Ada')
})

test('dashboard greeting uses the first name, or the bare stem without one', () => {
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 9, 0)), 'Ada Lovelace', copy, 'UTC', 'en'), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 9, 0)), '  Ada   Lovelace  ', copy, 'UTC', 'en'), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 9, 0)), null, copy, 'UTC', 'en'), 'Good morning')
  assert.equal(buildGreeting(new Date(Date.UTC(2026, 0, 1, 9, 0)), '   ', copy, 'UTC', 'en'), 'Good morning')
})
