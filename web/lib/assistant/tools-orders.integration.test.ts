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

function reader(orgId: string, subsidiaryIds: Set<string> | null, perms: string[]) {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Orders scope reader',
    email: 'orders-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(perms), allowedSubsidiaryIds: subsidiaryIds };
}

test('order reads: backlog, line remainders, and subsidiary isolation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  const soId = randomUUID();
  const hiddenPoId = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"orders":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden buyer','CAD','CA',true,false)
      `);
      await db.execute(sql`
        insert into documents(id,org_id,kind,document_number,document_date,status,currency,subtotal,tax_total,total,subsidiary_id,party_id)
        values (${soId},${org.orgId},'sales_order','SO-0001',${org.date},'draft','CAD','200','0','200',${org.subsidiaryId},${org.customerId}),
               (${hiddenPoId},${org.orgId},'purchase_order','PO-0001',${org.date},'draft','CAD','500','0','500',${hidden},${org.vendorId})
      `);
      await db.execute(sql`
        insert into document_lines(id,org_id,document_id,line_number,item_id,quantity,quantity_fulfilled,quantity_billed,unit_price,amount,subsidiary_id)
        values (${randomUUID()},${org.orgId},${soId},1,${org.items.service},'10','4','2','20','200',${org.subsidiaryId}),
               (${randomUUID()},${org.orgId},${hiddenPoId},1,${org.items.fifo},'5','0','0','100','500',${hidden})
      `);
      // Lines are immutable once approved: seed them as drafts, then commit.
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id in (${soId},${hiddenPoId})`);
    });

    const arOnly = reader(org.orgId, new Set([org.subsidiaryId]), ['assistant.use', 'ar.read']);
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(arOnly, 'search_orders', {}));
    assert.equal(search.ok, true, JSON.stringify(search));
    const searchData = (search as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(searchData.total, 1);
    assert.equal(searchData.backlogTotal, '200.0000');
    const item = ((searchData.items as Record<string, unknown>[])[0]);
    assert.ok(item);
    assert.equal(item.documentNumber, 'SO-0001');
    assert.equal(item.fulfilment, 'partially_fulfilled');
    assert.equal(item.billing, 'partially_billed');

    const get = await withOrgContext(org.orgId, () =>
      executeAssistantTool(arOnly, 'get_order', { kind: 'sales_order', id: soId }));
    assert.equal(get.ok, true, JSON.stringify(get));
    const line = ((get as { ok: true; data: Record<string, unknown> }).data.lines as Record<string, unknown>[])[0];
    assert.ok(line);
    assert.equal(line.remainingBillable, '8.0000');
    assert.equal(line.fulfilment, 'partially_fulfilled');

    // ap-only caller cannot read the sales order; ar-only caller cannot read purchase kinds.
    const apOnly = reader(org.orgId, new Set([org.subsidiaryId]), ['assistant.use', 'ap.read']);
    const crossKind = await withOrgContext(org.orgId, () =>
      executeAssistantTool(apOnly, 'get_order', { kind: 'sales_order', id: soId }));
    assert.equal(crossKind.ok, false);
    const hiddenSeeker = await withOrgContext(org.orgId, () =>
      executeAssistantTool(apOnly, 'search_orders', { kind: 'purchase_order' }));
    assert.equal(hiddenSeeker.ok, true, JSON.stringify(hiddenSeeker));
    assert.equal((hiddenSeeker as { ok: true; data: Record<string, unknown> }).data.total, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('order reads refuse while the feature is off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"orders":false}'::jsonb) where id=${org.orgId}`);
    });
    const authz = reader(org.orgId, null, ['assistant.use', 'ar.read']);
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'search_orders', {}));
    assert.equal(search.ok, false);
    assert.equal((search as { ok: false; error: string }).error, 'orders_feature_disabled');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
