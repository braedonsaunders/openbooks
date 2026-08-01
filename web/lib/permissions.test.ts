import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEffectivePermissions } from './permissions.ts'

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
