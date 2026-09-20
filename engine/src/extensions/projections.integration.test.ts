import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { sql } from 'drizzle-orm';
import { db, env, withBypassContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { installTestExtension, disableTestExtension } from '../testing/extension-packages.ts';
import { getExtensionSettings, listActiveExtensionContributions, updateExtensionSetting } from './projections.ts';

const permissions = ['admin.customization.manage', 'admin.setup.manage', 'admin.roles.manage'];
const contributions = [
  { kind: 'nav', href: '/module-sample', label: 'Sample', group: 'insights', requiredPermission: 'sample.read' },
  { kind: 'setting', key: 'caption', label: 'Caption', valueType: 'string', defaultValue: 'Original' },
  { kind: 'permission', key: 'sample.read', label: 'Read sample' },
];

test('reviewed extension projects navigation, dated settings and grantable permissions atomically; upgrade and uninstall preserve evidence', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, 'Approver', 'admin');
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`);
    const manifest = { key: 'sample-module', name: 'Sample module', version: '1.0.0', permissions, contributions };
    try {
      const approved = await installTestExtension({orgId:org.orgId,actorId,manifest});
      assert.equal((await listActiveExtensionContributions(org.orgId)).length, 3);
      assert.equal(await actorHasPermission(db, org.orgId, actorId, 'sample.read'), true);
      const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context); } });
      let resolveNav: (orgId: string, can: (permission: string | undefined) => boolean, roleKeys: readonly string[], t: (key: string) => string) => Promise<{ items: { href: string }[] }[]>;
      const navModulePath = '../../../web/lib/nav/resolve.ts';
      try { ({ resolveNav } = await import(navModulePath)); } finally { hooks.deregister(); }
      const hasShortcut = async (can: (permission: string | undefined) => boolean) => (await resolveNav(org.orgId, can, [], (key) => key)).some((group) => group.items.some((item) => item.href === '/module-sample'));
      assert.equal(await hasShortcut(() => true), true);
      assert.equal(await hasShortcut((permission) => permission !== 'sample.read'), false, 'navigation enforces the declared permission');

      assert.equal((await getExtensionSettings(org.orgId))['sample-module']!.caption, 'Original');
      const nav = (await db.execute<{ config: {groups: {items: {href?: string; hidden?: boolean}[]}[]} }>(sql`select config from org_nav_configs where org_id = ${org.orgId}`)).rows[0]!.config;
      assert.equal(nav.groups.flatMap((group) => group.items).filter((item) => item.href === '/module-sample' && !item.hidden).length, 1);
      const beforeChange = new Date((await db.execute<{ at: string }>(sql`select date_trunc('milliseconds', clock_timestamp())::text as at`)).rows[0]!.at);
      await db.execute(sql`select pg_sleep(0.01)`);
      await updateExtensionSetting({ orgId: org.orgId, actorId, extensionKey: manifest.key, key: 'caption', value: 'Custom', reason: 'Customize caption', effectivePermissions: ['*'] });
      assert.equal((await getExtensionSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateExtensionSetting({ orgId: org.orgId, actorId, extensionKey: manifest.key, key: 'caption', value: 'Stale overwrite', expectedValue: 'Original', expectedExtensionVersionId: approved.versionId!, reason: 'Refuse lost update', effectivePermissions: ['*'] }), /Setting changed/);
      assert.equal((await getExtensionSettings(org.orgId, db, beforeChange))['sample-module']!.caption, 'Original');
      await assert.rejects(() => updateExtensionSetting({ orgId: org.orgId, actorId, extensionKey: manifest.key, key: 'caption', value: false, reason: 'Wrong type', effectivePermissions: ['*'] }));
      await assert.rejects(() => installTestExtension({orgId:org.orgId,actorId,
        manifest:{...manifest,version:'1.1.0',contributions:contributions.map(c=>c.kind==='setting'?{...c,valueType:'boolean',defaultValue:false}:c)}}), /defaultValue must be a boolean/);
      assert.equal((await getExtensionSettings(org.orgId))['sample-module']!.caption, 'Custom');
      assert.equal((await db.execute<{ count:number }>(sql`select count(*)::int as count from app_versions where org_id=${org.orgId}`)).rows[0]!.count,1,'failed projection appends no version');
      await assert.rejects(() => installTestExtension({orgId:org.orgId,actorId,manifest:{key:'second-extension',name:'Second',version:'1.0.0',permissions:['admin.customization.manage'],contributions:[{kind:'nav',href:'/module-sample',label:'Conflicting shortcut',group:'insights'}]}}),/already has an owner/);
      assert.equal((await db.execute(sql`select id from apps where org_id=${org.orgId} and key='second-extension'`)).rows.length,0,'failed projection leaves no package');
      await installTestExtension({orgId:org.orgId,actorId,manifest:{...manifest,version:'2.0.0',contributions:contributions.map(c=>c.kind==='setting'?{...c,defaultValue:'Changed default'}:c)}});
      assert.equal((await getExtensionSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateExtensionSetting({ orgId: org.orgId, actorId, extensionKey: manifest.key, key: 'caption', value: 'Stale version', expectedValue: 'Custom', expectedExtensionVersionId: approved.versionId!, reason: 'Refuse stale schema', effectivePermissions: ['*'] }), /Extension version changed/);
      await disableTestExtension({ orgId: org.orgId, actorId, key: manifest.key });
      assert.equal((await listActiveExtensionContributions(org.orgId)).length, 0);
      assert.equal(await actorHasPermission(db, org.orgId, actorId, 'sample.read'), false, 'inactive declarations defeat wildcard grants without deleting stored role grants');
      assert.equal(await hasShortcut(() => true), false, 'uninstalled shortcuts are hidden even from wildcard readers');
      assert.equal((await getExtensionSettings(org.orgId))['sample-module']!.caption, 'Custom');
      await assert.rejects(() => updateExtensionSetting({ orgId: org.orgId, actorId, extensionKey: manifest.key, key: 'caption', value: 'Dormant write', reason: 'Refused', effectivePermissions: ['*'] }), /Active extension setting/);
      const audits = (await db.execute<{ changes: Record<string, unknown>; actor_id: string }>(sql`select changes, actor_id from audit_log where org_id = ${org.orgId} and changes->>'event' like 'extension_projection%'`)).rows;
      assert.ok(audits.length >= 5);
      for (const row of audits) { assert.equal(row.actor_id, actorId); assert.ok(row.changes.reason); assert.ok('before' in row.changes && 'after' in row.changes); }
    } finally { await dropScratchOrg(org.orgId); }
  });
});
