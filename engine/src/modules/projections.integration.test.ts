import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { actorHasPermission } from '../actor-permissions.ts';
import { sql } from 'drizzle-orm';
import { db, env, withBypassContext } from '../db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../test-fixtures.ts';
import { installModule, uninstallModule } from './installer.ts';
import { requestModuleInstallApproval, requestModuleUpgradeApproval, decideModuleApproval, cancelModuleApprovalRequest } from './lifecycle.ts';
import { getModuleSettings, listActiveModuleContributions, updateModuleSetting } from './projections.ts';

const permissions = ['admin.customization.manage', 'admin.setup.manage', 'admin.roles.manage'];
const contributions = [
  { kind: 'nav', href: '/module-sample', label: 'Sample', group: 'insights', requiredPermission: 'sample.read' },
  { kind: 'setting', key: 'caption', label: 'Caption', valueType: 'string', defaultValue: 'Original' },
  { kind: 'permission', key: 'sample.read', label: 'Read sample' },
];

test('signed module projects navigation, dated settings and grantable permissions atomically; upgrade and uninstall preserve evidence', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const requesterId = await createScratchUser(org.orgId, 'Requester', 'admin');
    const actorId = await createScratchUser(org.orgId, 'Approver', 'admin');
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`);
    const manifest = { key: 'sample-module', name: 'Sample module', version: '1.0.0', permissions, contributions };
    try {
      await assert.rejects(() => installModule({ orgId: org.orgId, actorId, manifest, installerEffectivePermissions: ['*'] }), /approval/);
      const staged = await requestModuleInstallApproval({ orgId: org.orgId, requesterId, manifest, installerEffectivePermissions: ['*'], assignees: [{ type: 'user', userId: actorId }], reason: 'Install sample module' });
      assert.equal((await listActiveModuleContributions(org.orgId)).length, 0);
      const approved = await decideModuleApproval({ gateId: staged.gateIds[0]!, userId: actorId, decision: 'approved', signature: 'Approver', approverEffectivePermissions: ['*'] });
      assert.equal(approved.resumed, 'approve');
      assert.equal((await listActiveModuleContributions(org.orgId)).length, 3);
      assert.equal(await actorHasPermission(db, org.orgId, actorId, 'sample.read'), true);
      const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context); } });
      let resolveNav: (orgId: string, can: (permission: string | undefined) => boolean, roleKeys: readonly string[], t: (key: string) => string) => Promise<{ items: { href: string }[] }[]>;
      const navModulePath = '../../../web/lib/nav/resolve.ts';
      try { ({ resolveNav } = await import(navModulePath)); } finally { hooks.deregister(); }
      const hasShortcut = async (can: (permission: string | undefined) => boolean) => (await resolveNav(org.orgId, can, [], (key) => key)).some((group) => group.items.some((item) => item.href === '/module-sample'));
      assert.equal(await hasShortcut(() => true), true);
      assert.equal(await hasShortcut((permission) => permission !== 'sample.read'), false, 'navigation enforces the declared permission');

      assert.equal((await getModuleSettings(org.orgId))['sample-module']!.caption, 'Original');
      const nav = (await db.execute<{ config: {groups: {items: {href?: string; hidden?: boolean}[]}[]} }>(sql`select config from org_nav_configs where org_id = ${org.orgId}`)).rows[0]!.config;
      assert.equal(nav.groups.flatMap((group) => group.items).filter((item) => item.href === '/module-sample' && !item.hidden).length, 1);
      const beforeChange = new Date((await db.execute<{ at: string }>(sql`select date_trunc('milliseconds', clock_timestamp())::text as at`)).rows[0]!.at);
      await db.execute(sql`select pg_sleep(0.01)`);
      await updateModuleSetting({ orgId: org.orgId, actorId, moduleKey: manifest.key, key: 'caption', value: 'Custom', reason: 'Customize caption', effectivePermissions: ['*'] });
      assert.equal((await getModuleSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateModuleSetting({ orgId: org.orgId, actorId, moduleKey: manifest.key, key: 'caption', value: 'Stale overwrite', expectedValue: 'Original', expectedModuleVersionId: approved.versionId!, reason: 'Refuse lost update', effectivePermissions: ['*'] }), /Setting changed/);
      assert.equal((await getModuleSettings(org.orgId, db, beforeChange))['sample-module']!.caption, 'Original');
      await assert.rejects(() => updateModuleSetting({ orgId: org.orgId, actorId, moduleKey: manifest.key, key: 'caption', value: false, reason: 'Wrong type', effectivePermissions: ['*'] }));
      const incompatible = await requestModuleUpgradeApproval({ orgId: org.orgId, requesterId, key: manifest.key,
        manifest: { ...manifest, version: '1.1.0', contributions: contributions.map((c) => c.kind === 'setting' ? { ...c, valueType: 'boolean', defaultValue: false } : c) },
        installerEffectivePermissions: ['*'], assignees: [{ type: 'user', userId: actorId }], reason: 'Attempt incompatible setting migration' });
      await assert.rejects(() => decideModuleApproval({ gateId: incompatible.gateIds[0]!, userId: actorId, decision: 'approved', signature: 'Approver', approverEffectivePermissions: ['*'] }), /defaultValue must be a boolean/);
      assert.equal((await getModuleSettings(org.orgId))['sample-module']!.caption, 'Custom');
      assert.equal((await db.execute<{ status: string }>(sql`select status from flow_gates where id = ${incompatible.gateIds[0]}`)).rows[0]!.status, 'pending', 'projection failure rolls back approval decision');
      assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from module_versions where org_id = ${org.orgId}`)).rows[0]!.count, 1, 'projection failure appends no version');
      await cancelModuleApprovalRequest({ orgId: org.orgId, actorId, moduleId: incompatible.moduleId, reason: 'Retain current setting type' });
      const collision = await requestModuleInstallApproval({ orgId: org.orgId, requesterId,
        manifest: { key: 'second-module', name: 'Second', version: '1.0.0', permissions: ['admin.customization.manage'], contributions: [{ kind: 'nav', href: '/module-sample', label: 'Conflicting shortcut', group: 'insights' }] },
        installerEffectivePermissions: ['*'], assignees: [{ type: 'user', userId: actorId }], reason: 'Attempt conflicting navigation' });
      await assert.rejects(() => decideModuleApproval({ gateId: collision.gateIds[0]!, userId: actorId, decision: 'approved', signature: 'Approver', approverEffectivePermissions: ['*'] }), /already has an owner/);
      assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from module_versions where org_id = ${org.orgId} and module_id = ${collision.moduleId}`)).rows[0]!.count, 0);
      await cancelModuleApprovalRequest({ orgId: org.orgId, actorId, moduleId: collision.moduleId, reason: 'Keep original shortcut owner' });
      const upgrade = await requestModuleUpgradeApproval({ orgId: org.orgId, requesterId, key: manifest.key, manifest: { ...manifest, version: '2.0.0', contributions: contributions.map((c) => c.kind === 'setting' ? { ...c, defaultValue: 'Changed default' } : c) }, installerEffectivePermissions: ['*'], assignees: [{ type: 'user', userId: actorId }], reason: 'Upgrade defaults' });
      await decideModuleApproval({ gateId: upgrade.gateIds[0]!, userId: actorId, decision: 'approved', signature: 'Approver', approverEffectivePermissions: ['*'] });
      assert.equal((await getModuleSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateModuleSetting({ orgId: org.orgId, actorId, moduleKey: manifest.key, key: 'caption', value: 'Stale version', expectedValue: 'Custom', expectedModuleVersionId: approved.versionId!, reason: 'Refuse stale schema', effectivePermissions: ['*'] }), /Module version changed/);
      await uninstallModule({ orgId: org.orgId, actorId, key: manifest.key, reason: 'Deactivate sample' });
      assert.equal((await listActiveModuleContributions(org.orgId)).length, 0);
      assert.equal(await actorHasPermission(db, org.orgId, actorId, 'sample.read'), false, 'inactive declarations defeat wildcard grants without deleting stored role grants');
      assert.equal(await hasShortcut(() => true), false, 'uninstalled shortcuts are hidden even from wildcard readers');
      assert.equal((await getModuleSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateModuleSetting({ orgId: org.orgId, actorId, moduleKey: manifest.key, key: 'caption', value: 'Dormant write', reason: 'Refused', effectivePermissions: ['*'] }), /Active module setting/);
      const audits = (await db.execute<{ changes: Record<string, unknown>; actor_id: string }>(sql`select changes, actor_id from audit_log where org_id = ${org.orgId} and changes->>'event' like 'module_projection%'`)).rows;
      assert.ok(audits.length >= 5);
      for (const row of audits) { assert.equal(row.actor_id, actorId); assert.ok(row.changes.reason); assert.ok('before' in row.changes && 'after' in row.changes); }
    } finally { await dropScratchOrg(org.orgId); }
  });
});
