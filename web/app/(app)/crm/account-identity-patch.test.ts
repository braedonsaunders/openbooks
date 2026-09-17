import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAccountIdentityPatch } from './account-identity-patch'

const form = { displayName: 'T12 Test Lead 2', email: '', phone: '', website: '' }

test('placeholder-draft save omits the status change but keeps the revision', () => {
  const body = buildAccountIdentityPatch({ is_active: false, updated_at: 'rev-1' }, form)
  assert.ok(!('isActive' in body), `create path must not send a status change, got ${JSON.stringify(body)}`)
  assert.equal(body.expectedUpdatedAt, 'rev-1')
  assert.equal(body.displayName, 'T12 Test Lead 2')
})

test('later saves on an active record echo the active flag as a no-op', () => {
  const body = buildAccountIdentityPatch({ is_active: true, updated_at: 'rev-2' }, form)
  assert.equal(body.isActive, true)
  assert.equal(body.expectedUpdatedAt, 'rev-2')
})
