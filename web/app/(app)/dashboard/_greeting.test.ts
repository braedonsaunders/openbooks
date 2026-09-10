import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGreeting } from './_greeting'

const copy = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' }

/**
 * The greeting is the one string both dashboard render paths share: the
 * native branch in page.tsx and the ViewSpec loader in view.ts import the
 * same `buildGreeting`, so a drift between two copies cannot desync the
 * conformance comparison. These pin the time boundaries and the name
 * handling that the shared helper owns.
 */
test('dashboard greeting picks the stem by hour of day', () => {
  assert.equal(buildGreeting(new Date(2026, 0, 1, 8, 30), 'Ada', copy), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 12, 0), 'Ada', copy), 'Good afternoon, Ada')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 16, 59), 'Ada', copy), 'Good afternoon, Ada')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 17, 0), 'Ada', copy), 'Good evening, Ada')
})

test('dashboard greeting uses the first name, or the bare stem without one', () => {
  assert.equal(buildGreeting(new Date(2026, 0, 1, 9, 0), 'Ada Lovelace', copy), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 9, 0), '  Ada   Lovelace  ', copy), 'Good morning, Ada')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 9, 0), null, copy), 'Good morning')
  assert.equal(buildGreeting(new Date(2026, 0, 1, 9, 0), '   ', copy), 'Good morning')
})
