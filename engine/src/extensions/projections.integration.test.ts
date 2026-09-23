import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { sql } from 'drizzle-orm';
import { db, env, withBypassContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { installTestExtension, disableTestExtension } from '../testing/extension-packages.ts';
import { getExtensionSettings, listActiveExtensionContributions, updateExtensionSetting } from './projections.ts';
import { defaultNavConfig } from '../navigation/nav-registry.ts';

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

type NavProbeItem = { href?: string; hidden?: boolean; extensionKey?: string };

async function navItemsAt(orgId: string, href: string): Promise<NavProbeItem[]> {
  const nav = (await db.execute<{ config: { groups: { items: NavProbeItem[] }[] } }>(sql`select config from org_nav_configs where org_id = ${orgId}`)).rows[0]!.config;
  return nav.groups.flatMap((group) => group.items).filter((item) => item.href === href);
}

test('a disabled extension releases its navigation href; re-enabling refuses while another extension owns it', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, 'Approver', 'admin');
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`);
    const permissions = ['admin.customization.manage'];
    try {
      await installTestExtension({ orgId: org.orgId, actorId, manifest: { key: 'first-extension', name: 'First', version: '1.0.0', permissions, contributions: [{ kind: 'nav', href: '/module-sample', label: 'Sample A', group: 'insights' }] } });
      await disableTestExtension({ orgId: org.orgId, actorId, key: 'first-extension' });
      // The href is free again: a different extension may claim it.
      await installTestExtension({ orgId: org.orgId, actorId, manifest: { key: 'second-extension', name: 'Second', version: '1.0.0', permissions, contributions: [{ kind: 'nav', href: '/module-sample', label: 'Sample B', group: 'insights' }] } });
      let atHref = await navItemsAt(org.orgId, '/module-sample');
      assert.equal(atHref.filter((item) => !item.hidden).length, 1);
      assert.equal(atHref.find((item) => !item.hidden)?.extensionKey, 'second-extension');
      // The disabled owner's row is kept for history, but owns nothing.
      assert.ok(atHref.some((item) => item.hidden && item.extensionKey === 'first-extension'));
      // Re-enabling the first extension while the second owns the href refuses.
      // Variable indirection (not a literal) so engine typecheck does not
      // follow the import into web's graph — same pattern as the nav import.
      const storePath = '../../../web/lib/apps/store.ts';
      const { setAppStatus } = await import(storePath);
      await assert.rejects(() => setAppStatus(org.orgId, actorId, 'first-extension', 'installed'), /already has an owner/);
      atHref = await navItemsAt(org.orgId, '/module-sample');
      assert.equal(atHref.find((item) => !item.hidden)?.extensionKey, 'second-extension');
    } finally { await dropScratchOrg(org.orgId); }
  });
});

test('retired hidden links do not count toward the 256-item navigation cap', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, 'Approver', 'admin');
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`);
    try {
      const config = defaultNavConfig();
      const group = config.groups.find((entry) => entry.id === 'insights')!;
      for (let i = 0; i < 300; i++) group.items.push({ kind: 'link', href: `/retired-${i}`, label: `Retired ${i}`, extensionKey: 'retired-ext', hidden: true });
      await db.execute(sql`insert into org_nav_configs (org_id, config, created_by, updated_by)
        values (${org.orgId}, ${JSON.stringify(config)}::jsonb, ${actorId}, ${actorId})
        on conflict (org_id) do update set config = excluded.config, updated_by = excluded.updated_by, updated_at = now()`);
      // 300+ stored rows but only a handful visible: a new install still succeeds.
      await installTestExtension({ orgId: org.orgId, actorId, manifest: { key: 'fresh-extension', name: 'Fresh', version: '1.0.0', permissions: ['admin.customization.manage'], contributions: [{ kind: 'nav', href: '/module-fresh', label: 'Fresh', group: 'insights' }] } });
      const stored = (await db.execute<{ config: { groups: { items: NavProbeItem[] }[] } }>(sql`select config from org_nav_configs where org_id = ${org.orgId}`)).rows[0]!.config;
      const items = stored.groups.flatMap((entry) => entry.items);
      assert.equal(items.filter((item) => item.href === '/module-fresh' && !item.hidden).length, 1);
      assert.equal(items.filter((item) => item.hidden).length, 300);
    } finally { await dropScratchOrg(org.orgId); }
  });
});

