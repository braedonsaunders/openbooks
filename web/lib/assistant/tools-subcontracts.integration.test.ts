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

const PERMS = ['assistant.use', 'ap.read', 'projects.read', 'reports.read'];

function reader(orgId: string, subsidiaryIds: Set<string> | null, perms: string[] = PERMS) {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Subcontract scope reader',
    email: 'subcontract-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(perms), allowedSubsidiaryIds: subsidiaryIds };
}

test('subcontract and wip reads: commitments, pay apps, prebills, isolation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  const projectId = randomUUID();
  const hiddenProjectId = randomUUID();
  const contractId = randomUUID();
  const prebillId = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true,"wipBilling":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden site','CAD','CA',true,false)
      `);
      await db.execute(sql`
        insert into projects(id,org_id,name,subsidiary_id,customer_id)
        values (${projectId},${org.orgId},'Visible tower',${org.subsidiaryId},${org.customerId}),
               (${hiddenProjectId},${org.orgId},'Hidden annex',${hidden},${org.customerId})
      `);
      await db.execute(sql`
        insert into subcontracts(id,org_id,project_id,vendor_id,number,title,status,currency,original_commitment,default_retainage_percent)
        values (${contractId},${org.orgId},${projectId},${org.vendorId},'SC-0001','Concrete frame','active','CAD','10000','10'),
               (${randomUUID()},${org.orgId},${hiddenProjectId},${org.vendorId},'SC-0002','Hidden steel','active','CAD','50000','10')
      `);
      await db.execute(sql`
        insert into subcontract_sov_lines(id,org_id,subcontract_id,item_no,description,scheduled_value,sort_order)
        values (${randomUUID()},${org.orgId},${contractId},1,'Frame pour','10000',1)
      `);
      await db.execute(sql`
        insert into subcontract_change_orders(id,org_id,subcontract_id,number,status,amount)
        values (${randomUUID()},${org.orgId},${contractId},'CO-001','approved','1000')
      `);
      await db.execute(sql`
        insert into vendor_pay_applications(id,org_id,subcontract_id,application_number,period_end,status,default_retainage_percent,gross_this_period,retainage_this_period,net_due)
        values (${randomUUID()},${org.orgId},${contractId},1,${org.date},'billed','10','2000','200','1800')
      `);
      await db.execute(sql`
        insert into wip_prebills(id,org_id,project_id,worksheet_number,period_end,status,original_bill_amount,proposed_bill_amount,cost_amount,adjustment_amount)
        values (${prebillId},${org.orgId},${projectId},'WS-0001',${org.date},'draft','3000','2800','1500','-200'),
               (${randomUUID()},${org.orgId},${hiddenProjectId},'WS-0002',${org.date},'draft','9000','9000','4000','0')
      `);
    });

    const restricted = reader(org.orgId, new Set([org.subsidiaryId]));
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'search_subcontracts', {}));
    assert.equal(search.ok, true, JSON.stringify(search));
    const searchData = (search as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(searchData.total, 1);
    assert.equal(searchData.sumRevisedCommitment, '11000.0000');
    assert.equal(searchData.sumBilledToDate, '2000.0000');
    assert.equal(searchData.sumRetainageWithheld, '200.0000');

    const get = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'get_subcontract', { id: contractId }));
    assert.equal(get.ok, true, JSON.stringify(get));
    const detail = (get as { ok: true; data: Record<string, unknown> }).data;
    assert.equal((detail.subcontract as Record<string, unknown>).revisedCommitment, '11000.0000');
    assert.equal((detail.sovLines as unknown[]).length, 1);
    assert.equal((detail.changeOrders as unknown[]).length, 1);
    assert.equal((detail.payApplications as unknown[]).length, 1);

    const prebills = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'list_wip_prebills', {}));
    assert.equal(prebills.ok, true, JSON.stringify(prebills));
    assert.equal((prebills as { ok: true; data: Record<string, unknown> }).data.total, 1);

    const prebill = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'get_wip_prebill', { id: prebillId }));
    assert.equal(prebill.ok, true, JSON.stringify(prebill));
    assert.equal(
      ((prebill as { ok: true; data: Record<string, unknown> }).data.proposedBillAmount as string),
      '2800.0000',
    );

    const analytics = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'wip_analytics', { asOf: org.date }));
    assert.equal(analytics.ok, true, JSON.stringify(analytics));

    const noperm = reader(org.orgId, null, ['assistant.use']);
    const denied = await withOrgContext(org.orgId, () =>
      executeAssistantTool(noperm, 'search_subcontracts', {}));
    assert.equal(denied.ok, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('subcontract and wip reads refuse while their features are off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":false,"wipBilling":false}'::jsonb) where id=${org.orgId}`);
    });
    const authz = reader(org.orgId, null);
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'search_subcontracts', {}));
    assert.equal(search.ok, false);
    assert.equal((search as { ok: false; error: string }).error, 'subcontracts_feature_disabled');
    const prebills = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'list_wip_prebills', {}));
    assert.equal(prebills.ok, false);
    assert.equal((prebills as { ok: false; error: string }).error, 'wipBilling_feature_disabled');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
