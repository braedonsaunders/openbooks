import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function reader(orgId: string, subsidiaryIds: Set<string> | null, perms: string[] = ['assistant.use', 'assets.read']) {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Equipment scope reader',
    email: 'equipment-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(perms), allowedSubsidiaryIds: subsidiaryIds };
}

test('equipment reads: register KPIs, unit metrics, and subsidiary isolation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  const unitId = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"equipment":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden yard','CAD','CA',true,false)
      `);
      await db.execute(sql`
        insert into equipment_units(id,org_id,subsidiary_id,unit_number,name,status,purchase_price)
        values (${unitId},${org.orgId},${org.subsidiaryId},'EQ-0001','Visible crane','active','120000'),
               (${randomUUID()},${org.orgId},${hidden},'EQ-0002','Hidden crane','active','60000')
      `);
    });

    const restricted = reader(org.orgId, new Set([org.subsidiaryId]));
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'search_equipment', {}));
    assert.equal(search.ok, true, JSON.stringify(search));
    const searchData = (search as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(searchData.total, 1);
    assert.equal(searchData.sumPurchasePrice, '120000.0000');

    const get = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'get_equipment', { id: unitId }));
    assert.equal(get.ok, true, JSON.stringify(get));
    const detail = (get as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(detail.unit_number, 'EQ-0001');
    assert.ok((detail.metrics as Record<string, unknown>).recovery !== undefined);

    const noperm = reader(org.orgId, null, ['assistant.use']);
    const denied = await withOrgContext(org.orgId, () =>
      executeAssistantTool(noperm, 'search_equipment', {}));
    assert.equal(denied.ok, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('equipment reads refuse while the feature is off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"equipment":false}'::jsonb) where id=${org.orgId}`);
    });
    const authz = reader(org.orgId, null);
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'search_equipment', {}));
    assert.equal(search.ok, false);
    assert.equal((search as { ok: false; error: string }).error, 'equipment_feature_disabled');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
