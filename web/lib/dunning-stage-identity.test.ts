import assert from 'node:assert/strict'
import test from 'node:test'
import { dunningStageIdentities } from './dunning-stage-identity'

const previous = [{ id: 'reminder', sequence: 1 }, { id: 'escalation', sequence: 2 }]
test('a legacy policy edit keeps delivery identities instead of reopening sent reminders', () => {
  assert.deepEqual(dunningStageIdentities(previous, [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]),
    { ok: true, ids: ['reminder', 'escalation', null] })
})
test('reordering stages preserves their identities', () => {
  assert.deepEqual(dunningStageIdentities(previous, [{ id: 'escalation', sequence: 1 }, { id: 'reminder', sequence: 2 }]),
    { ok: true, ids: ['escalation', 'reminder'] })
})
test('a foreign or repeated stage refuses with the corrective action named', () => {
  const foreign = dunningStageIdentities(previous, [{ id: 'other-policy-stage', sequence: 1 }])
  assert.equal(foreign.ok, false)
  if (!foreign.ok) assert.match(foreign.error, /belongs to this policy.*Refresh Policies/)
  const duplicate = dunningStageIdentities(previous, [{ id: 'reminder', sequence: 1 }, { id: 'reminder', sequence: 2 }])
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.error, /Remove the duplicate/)
})
