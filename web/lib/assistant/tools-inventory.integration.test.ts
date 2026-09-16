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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function reader(orgId: string, subsidiaryIds: Set<string> | null, perms: string[] = ['assistant.use', 'items.read']) {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Inventory scope reader',
    email: 'inventory-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(perms), allowedSubsidiaryIds: subsidiaryIds };
}

test('inventory reads: happy path plus subsidiary isolation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden depot','CAD','CA',true,false)
      `);
      const movedAt = `${org.date}T12:00:00Z`;
      await db.execute(sql`
        insert into inventory_movements(id,org_id,item_id,kind,moved_at,stock_location_id,quantity,unit_cost,total_value,status,subsidiary_id)
        values (${randomUUID()},${org.orgId},${org.items.fifo},'receipt',${movedAt}::timestamptz,${org.stockLocationId},10,'5','50','posted',${org.subsidiaryId}),
               (${randomUUID()},${org.orgId},${org.items.fifo},'receipt',${movedAt}::timestamptz,${org.stockLocationId},99,'5','495','posted',${hidden})
      `);
      await db.execute(sql`
        insert into inventory_writedowns(id,org_id,item_id,stock_location_id,subsidiary_id,kind,date,quantity,previous_value,new_value,amount,framework,journal_entry_id)
        values (${randomUUID()},${org.orgId},${org.items.fifo},${org.stockLocationId},${hidden},'writedown',${org.date},1,'50','40','10','us_gaap',${randomUUID()})
      `);
    });

    const restricted = reader(org.orgId, new Set([org.subsidiaryId]));
    const levels = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'inventory_levels', {}));
    assert.equal(levels.ok, true, JSON.stringify(levels));
    const levelData = (levels as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(levelData.total, 1);
    assert.equal(levelData.sumQuantity, '10.0000');

    const movements = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'inventory_movements', {}));
    assert.equal(movements.ok, true, JSON.stringify(movements));
    const movementData = (movements as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(movementData.total, 1);
    assert.equal(movementData.sumQuantity, '10.0000');

    const writedowns = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'inventory_writedowns', {}));
    assert.equal(writedowns.ok, true, JSON.stringify(writedowns));
    assert.equal((writedowns as { ok: true; data: Record<string, unknown> }).data.total, 0);

    const items = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'search_items', { query: 'FIFO' }));
    assert.equal(items.ok, true, JSON.stringify(items));
    assert.ok(((items as { ok: true; data: Record<string, unknown> }).data.total as number) >= 1);

    const full = reader(org.orgId, null);
    const fullLevels = await withOrgContext(org.orgId, () =>
      executeAssistantTool(full, 'inventory_levels', {}));
    assert.equal(fullLevels.ok, true, JSON.stringify(fullLevels));
    assert.equal((fullLevels as { ok: true; data: Record<string, unknown> }).data.sumQuantity, '109.0000');

    const noperm = reader(org.orgId, null, ['assistant.use']);
    const denied = await withOrgContext(org.orgId, () =>
      executeAssistantTool(noperm, 'inventory_levels', {}));
    assert.equal(denied.ok, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('inventory stock reads refuse while the feature is off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`);
    });
    const authz = reader(org.orgId, null);
    const levels = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'inventory_levels', {}));
    assert.equal(levels.ok, false);
    assert.equal((levels as { ok: false; error: string }).error, 'inventory_feature_disabled');
    const items = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'search_items', {}));
    assert.equal(items.ok, true, JSON.stringify(items));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
