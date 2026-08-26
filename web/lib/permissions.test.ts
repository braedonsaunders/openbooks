import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INVENTORY_ACTION_PERMISSIONS,
  INVENTORY_ADVANCED_ACTION_PERMISSIONS,
} from '@openbooks/engine/src/permissions.ts'
import {
  BUILT_IN_ROLES,
  PERMISSION_CATALOGUE,
  permissionSetCovers,
  resolveEffectivePermissions,
} from './permissions.ts'

test('a user without an explicit role assignment receives no role permissions', () => {
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: [],
    overrides: [],
  })
  assert.deepEqual([...permissions], [])
})

test('explicit role assignments are unioned and deny overrides win', () => {
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: [['ap.read', 'ap.create'], ['reports.read']],
    overrides: [
      { permission: 'ap.create', effect: 'deny' },
      { permission: 'banking.read', effect: 'grant' },
    ],
  })
  assert.deepEqual([...permissions].sort(), ['ap.read', 'banking.read', 'reports.read'])
})

/**
 * Representative SoD controls for inventory money movement
 * (fnd_mt9g743u_w8y6mv). The routes gate each verb through
 * INVENTORY_ACTION_PERMISSIONS / INVENTORY_ADVANCED_ACTION_PERMISSIONS, so the
 * mapping plus wildcard semantics ARE the boundary; the deep route, subsidiary
 * fencing, cross-entity denial, reversal atomicity, and audit-failure proofs
 * live in web/lib/permission-registry.test.ts and are equivalent coverage.
 */

test('a catalog maintainer holding items.manage alone is refused every financial inventory action', () => {
  // The route consults these exact mappings, so asserting them asserts the
  // production write path, and every demanded key must be role-assignable.
  const demanded = [
    ...Object.values(INVENTORY_ACTION_PERMISSIONS),
    ...Object.values(INVENTORY_ADVANCED_ACTION_PERMISSIONS),
  ]
  for (const perm of demanded) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    )
    assert.equal(
      permissionSetCovers(new Set(['items.manage']), perm),
      false,
      `items.manage must not carry ${perm}: catalog maintenance is not ledger authority`,
    )
  }
  // Reversal is deliberately distinct from posting (maker/checker).
  assert.equal(INVENTORY_ACTION_PERMISSIONS.reverse, 'items.reverse')
  for (const [action, perm] of Object.entries(INVENTORY_ACTION_PERMISSIONS)) {
    if (action !== 'reverse') {
      assert.equal(perm, 'items.post', `${action} moves value and demands posting authority`)
    }
  }
})

test('principals with the right financial authority are still allowed through', () => {
  // A poster clears every forward verb; wildcard grants keep working.
  const poster = new Set(['gl.post', 'items.post'])
  for (const [action, perm] of Object.entries(INVENTORY_ACTION_PERMISSIONS)) {
    if (action === 'reverse') continue
    assert.equal(permissionSetCovers(poster, perm), true, `${action} allowed for items.post`)
  }
  assert.equal(permissionSetCovers(new Set(['items.*']), 'items.reverse'), true)
  // Built-ins split the duties: controller unwinds, accountant only posts,
  // and no read-only/approval/sales role touches value at all.
  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm)
  assert.equal(holds('controller', 'items.post'), true)
  assert.equal(holds('controller', 'items.reverse'), true)
  assert.equal(holds('accountant', 'items.post'), true)
  assert.equal(holds('accountant', 'items.reverse'), false)
  for (const role of ['approver', 'viewer', 'sales_manager', 'sales_rep']) {
    assert.equal(holds(role, 'items.post'), false, `${role} must not post`)
    assert.equal(holds(role, 'items.reverse'), false, `${role} must not reverse`)
  }
})
