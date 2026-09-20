import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAnnouncement } from './home-announcements-validate'

/**
 * HR-15 home announcements validation (pure; storage is DB-owned).
 * Every refusal names the remedy — an admin acts on the message.
 */
test('a well-formed announcement validates', () => {
  assert.deepEqual(validateAnnouncement({ title: 'Holiday party', audience: 'all', startsOn: '2026-12-01' }), {
    title: 'Holiday party',
    body: null,
    audience: 'all',
    startsOn: '2026-12-01',
    endsOn: null,
  })
})

test('a blank title refuses by name', () => {
  assert.throws(() => validateAnnouncement({ title: '  ', startsOn: '2026-12-01' }), /needs a title/)
})

test('an unknown audience refuses with the three valid values', () => {
  assert.throws(() => validateAnnouncement({ title: 'X', audience: 'everyone', startsOn: '2026-12-01' }), /all, managers, or employees/)
})

test('a missing start date refuses by name', () => {
  assert.throws(() => validateAnnouncement({ title: 'X' }), /startsOn/)
})

test('an end before the start refuses by name', () => {
  assert.throws(
    () => validateAnnouncement({ title: 'X', startsOn: '2026-12-02', endsOn: '2026-12-01' }),
    /cannot come down before it goes live/,
  )
})
