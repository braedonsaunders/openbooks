import assert from 'node:assert/strict';
import test from 'node:test';
import { denyInactiveModulePermissions } from './permission-availability.ts';
import { permissionSetCovers, resolveEffectivePermissions } from '../permissions.ts';

test('inactive module permissions fail closed beneath wildcards without changing unrelated permissions', () => {
  for (const grants of [['*'], ['addon.*', 'gl.read'], ['addon.read', 'addon.write', 'gl.read']]) {
    const permissions = denyInactiveModulePermissions(new Set(grants), ['addon.read']);
    assert.equal(permissionSetCovers(permissions, 'addon.read'), false);
    assert.equal(permissionSetCovers(permissions, 'addon.write'), true);
    assert.equal(permissionSetCovers(permissions, 'gl.read'), true);
  }
});

test('active module permission keys survive unrelated deny overrides when a wildcard is materialized', () => {
  const permissions = resolveEffectivePermissions({ rolePermissionSets: [['*']], additionalKnownPermissions: ['addon.read'], overrides: [{ permission: 'gl.post', effect: 'deny' }] });
  assert.equal(permissionSetCovers(permissions, 'addon.read'), true);
  assert.equal(permissionSetCovers(permissions, 'gl.post'), false);
  assert.equal(permissionSetCovers(permissions, 'gl.read'), true);
});
