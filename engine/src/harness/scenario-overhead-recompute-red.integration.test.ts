import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { applyOverheadForTime } from "../allocations/overhead-post.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { runScenario } from "../golden/scenario.ts";

test("overhead-recomputes names the posted line after its source rate changes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const projectId = randomUUID();
    const timeId = randomUUID();
    const rateId = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${employeeId},${org.orgId},'person','Overhead harness worker',${org.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${projectId},${org.orgId},${org.subsidiaryId},'OVH-HARNESS','Overhead harness job',${org.customerId},'active',true,'{}'::jsonb)`);
    await db.execute(sql`insert into time_entries
      (id,org_id,employee_party_id,worked_on,hours,project_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      values(${timeId},${org.orgId},${employeeId},${org.date},2,${projectId},'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId})`);
    await db.execute(sql`insert into overhead_rates(id,org_id,method,rate_kind,rate_percent,effective_from)
      values(${rateId},${org.orgId},'standard','per_hour',12.5,'2026-01-01')`);

    const result = await applyOverheadForTime(org.orgId, actorId, [timeId]);
    assert.ok(result.entryId, "fixture must post overhead before the rate is changed");
    const nudged = await db.execute<{ id: string }>(sql`update overhead_rates set rate_percent=13.5
      where org_id=${org.orgId} and id=${rateId} returning id`);
    assert.equal(nudged.rows.length, 1, "rate change must affect exactly the fixture's configured rate");

    const checkpoint = await runScenario(org.orgId, { at: org.date });
    const check = checkpoint.checks.find((item) => item.name === "overhead-recomputes");
    assert.ok(check, "checkpoint must carry the overhead recomputation check");
    assert.equal(check.ok, false, `changed rate must break the recomputation: ${check.detail}`);
    assert.match(check.detail, new RegExp(`entry ${result.entryId}`));
    assert.match(check.detail, /line \d+: recomputed amount differs/);
    assert.match(check.detail, /expected 27\.0000, actual 25\.0000/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
