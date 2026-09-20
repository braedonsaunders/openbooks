import assert from 'node:assert/strict'
import test from 'node:test'
import { canSeeWidget, hasAdminPersona } from './_widget-access'
import type { Authz } from '@/lib/authz'

/**
 * HR-15 persona gates: admin by grants (never role names), everyone else by
 * own/team-scoped reads with null-absent data.
 */
function fakeAuthz(permissions: string[]): Authz {
  return {
    user: { id: 'user-1', orgId: 'org-1', name: 'Test', email: 't@example.com', roles: [], envKind: 'production' },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as unknown as Authz
}

test('the admin persona follows manage grants, not role names', () => {
  assert.equal(hasAdminPersona(fakeAuthz([])), false)
  assert.equal(hasAdminPersona(fakeAuthz(['admin.setup.manage'])), true)
  assert.equal(hasAdminPersona(fakeAuthz(['payroll.manage'])), true)
  assert.equal(hasAdminPersona(fakeAuthz(['hrm.leave.manage'])), true)
  assert.equal(hasAdminPersona(fakeAuthz(['hrm.*'])), true)
  assert.equal(hasAdminPersona(fakeAuthz(['*'])), true)
  assert.equal(hasAdminPersona(fakeAuthz(['gl.read', 'ap.approve'])), false)
})

test('admin-rail tiles resolve through the persona', () => {
  const admin = fakeAuthz(['admin.setup.manage'])
  const plain = fakeAuthz(['gl.read'])
  for (const id of ['admin-attention', 'workflow-errors', 'admin-calendar']) {
    assert.equal(canSeeWidget(admin, id), true, `${id} shows for the admin persona`)
    assert.equal(canSeeWidget(plain, id), false, `${id} hides without manage grants`)
  }
  // An hrm-only manager sees no admin rail.
  assert.equal(canSeeWidget(fakeAuthz(['hrm.employment.read', 'hrm.leave.approve']), 'admin-attention'), false)
})

test('persona tiles are placement-open: the loader (not the gate) keeps them honest', () => {
  const plain = fakeAuthz(['gl.read'])
  for (const id of ['inbox-list', 'pay-tile', 'balance-tile', 'team-approvals', 'team-steps', 'home-ask']) {
    assert.equal(canSeeWidget(plain, id), true, `${id} renders the honest empty card without a grant`)
  }
})
