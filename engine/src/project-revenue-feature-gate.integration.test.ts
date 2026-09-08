import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { syncProjectRevenueContracts } from "./project-revenue.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

test("project revenue sync preserves contracts and schedules while Projects is disabled", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID(), typeId = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: false, revenueRecognition: true },
      controlAccounts: { unbilledReceivable: org.accounts.ar, projectRevenue: org.accounts.revenue },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${typeId},${org.orgId},'gate-poc','Gate POC','fixed_price',
        '{"recognition":"percent_complete_cost","billingProcedure":"standard"}'::jsonb,'{}'::jsonb)`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,starts_on,contract_value,custom)
      values(${projectId},${org.orgId},${org.subsidiaryId},'GATE-POC','Gate POC project',${org.customerId},${typeId},'active',true,
        ${org.date},1000,'{"percentCompleteOverride":"25"}'::jsonb)`);
    const sync = () => syncProjectRevenueContracts(org.orgId, actorId, org.date, projectId);
    assert.deepEqual(await sync(), { synced: [], problems: [] });
    const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from revenue_contracts
      where org_id=${org.orgId} and project_id=${projectId}`)).rows[0]!.n;
    assert.equal(count, 0, "disabled Projects cannot create revenue contracts");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','true'::jsonb) where id=${org.orgId}`);
    const enabled = await sync();
    assert.equal(enabled.problems.length, 0);
    assert.equal(enabled.synced.length, 1);
    assert.equal(enabled.synced[0]!.percentComplete, "25.0000");
    const snapshot = async () => (await db.execute<{ evidence: unknown }>(sql`
      select jsonb_build_object(
        'contracts',(select jsonb_agg(to_jsonb(c) order by c.id) from revenue_contracts c where org_id=${org.orgId}),
        'obligations',(select jsonb_agg(to_jsonb(o) order by o.id) from performance_obligations o where org_id=${org.orgId}),
        'schedules',(select jsonb_agg(to_jsonb(s) order by s.id) from recognition_schedule_lines s where org_id=${org.orgId})
      ) as evidence`)).rows[0]!.evidence;
    const before = await snapshot();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update projects set custom=jsonb_set(custom,'{percentCompleteOverride}','"75"'::jsonb)
      where org_id=${org.orgId} and id=${projectId}`);
    assert.deepEqual(await sync(), { synced: [], problems: [] });
    assert.deepEqual(await snapshot(), before, "disabled sync preserves every historical and scheduled row");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','true'::jsonb) where id=${org.orgId}`);
    const resumed = await sync();
    assert.equal(resumed.synced[0]!.contractId, enabled.synced[0]!.contractId);
    assert.equal(resumed.synced[0]!.obligationId, enabled.synced[0]!.obligationId);
    assert.equal(resumed.synced[0]!.percentComplete, "75.0000");
  } finally { await dropScratchOrg(org.orgId); }
});
