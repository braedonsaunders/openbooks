import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  applyOverheadForTime,
  backfillOverhead,
  countUnappliedOverheadTime,
} from "./overhead-apply.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

// Regression for B-PRJ-07: when hours x rate rounded to 0.0000 the entry was
// skipped WITHOUT stamping overhead_journal_entry_id, so
// countUnappliedOverheadTime counted it forever, backfillOverhead broke on
// the first all-zero batch, and the route answered {ok:true, entries:0}
// over a permanent backlog. Dust now stamps applied-with-zero (a custom
// marker that needs no journal — overhead is statistical), the counter
// excludes it, and the backfill continues past zero batches while
// unstamped rows remain.
async function seedDustOrg(): Promise<{
  orgId: string;
  actorId: string;
  dustEarly: string;
  dustLate: string;
  normalId: string;
}> {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const deptShop = randomUUID();
    const proj = randomUUID();
    const dustEarly = randomUUID();
    const dustLate = randomUUID();
    const normalId = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into departments(id,org_id,name)
      values(${deptShop},${org.orgId},'Shop')`);
    // A dust-fine org-wide rate (0.01h x 0.0001 rounds to 0.0000) next to a
    // real department rate, so one org holds both dust and carriable hours.
    await db.execute(sql`insert into overhead_rates(id,org_id,department_id,category,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${org.orgId},null,'Facilities','standard','per_hour',0.0001,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptShop},'Facilities','standard','per_hour',10,'2026-01-01')`);
    const employeeId = (await db.execute<{ id: string }>(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${randomUUID()},${org.orgId},'person','Dust worker',${org.subsidiaryId},true,'{}'::jsonb)
      returning id`)).rows[0]!.id;
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${proj},${org.orgId},${org.subsidiaryId},'DUST-1','Dust job',${org.customerId},'active',true,'{}'::jsonb)`);
    // The late dust entry carries an existing custom key the stamp must
    // merge with, never overwrite.
    await db.execute(sql`insert into time_entries
      (id,org_id,employee_party_id,worked_on,hours,project_id,department_id,status,
       cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      values(${dustEarly},${org.orgId},${employeeId},'2026-07-01',0.01,${proj},null,
        'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId}),
            (${normalId},${org.orgId},${employeeId},'2026-07-03',2,${proj},${deptShop},
        'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId}),
            (${dustLate},${org.orgId},${employeeId},'2026-07-05',0.01,${proj},null,
        'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{"source":"import"}'::jsonb,${actorId},${actorId})`);
    return { orgId: org.orgId, actorId, dustEarly, dustLate, normalId };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function customOf(orgId: string, id: string): Promise<Record<string, unknown>> {
  const r = (await db.execute<{ custom: Record<string, unknown> }>(sql`
    select custom from time_entries where org_id = ${orgId} and id = ${id}`));
  return r.rows[0]?.custom ?? {};
}

test("dust stamps applied-with-zero and clears the backlog", async () => {
  const f = await seedDustOrg();
  try {
    assert.equal((await countUnappliedOverheadTime(f.orgId)).entries, 3);

    // The zero batch posts no journal but stamps progress and names it.
    const zero = await applyOverheadForTime(f.orgId, f.actorId, [f.dustEarly]);
    assert.equal(zero.entryId, null);
    assert.equal(zero.entries, 0);
    assert.equal(zero.dust, 1);
    assert.equal((await customOf(f.orgId, f.dustEarly)).overheadZeroApplied, true);
    assert.equal((await countUnappliedOverheadTime(f.orgId)).entries, 2);

    // Re-presenting a dust entry is a no-op, not a second stamp.
    const again = await applyOverheadForTime(f.orgId, f.actorId, [f.dustEarly]);
    assert.equal(again.entryId, null);
    assert.equal(again.dust, 0);

    // The backfill carries the real hours and stamps the remaining dust in
    // one pass, leaving no backlog: entries, journal, and stamped dust agree.
    const backfill = await backfillOverhead(f.orgId, f.actorId);
    assert.equal(backfill.entries, 1);
    assert.equal(backfill.total, "20.0000");
    assert.equal(backfill.journals, 1);
    assert.equal(backfill.dust, 1);
    const lateCustom = await customOf(f.orgId, f.dustLate);
    assert.equal(lateCustom.overheadZeroApplied, true);
    assert.equal(lateCustom.source, "import");
    assert.equal((await countUnappliedOverheadTime(f.orgId)).entries, 0);
    assert.equal((await countUnappliedOverheadTime(f.orgId)).hours, "0");
  } finally {
    await dropScratchOrg(f.orgId);
  }
});

test("the backfill continues past an all-dust batch to later batches", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const deptShop = randomUUID();
    const proj = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into departments(id,org_id,name)
      values(${deptShop},${org.orgId},'Shop')`);
    await db.execute(sql`insert into overhead_rates(id,org_id,department_id,category,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${org.orgId},null,'Facilities','standard','per_hour',0.0001,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptShop},'Facilities','standard','per_hour',10,'2026-01-01')`);
    const employeeId = (await db.execute<{ id: string }>(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${randomUUID()},${org.orgId},'person','Batch dust worker',${org.subsidiaryId},true,'{}'::jsonb)
      returning id`)).rows[0]!.id;
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${proj},${org.orgId},${org.subsidiaryId},'DUST-B','Dust batch job',${org.customerId},'active',true,'{}'::jsonb)`);
    // A full first page of dust (the backfill takes 2000 ids per pass)
    // followed by one carriable batch: the old loop stopped at the first
    // journal-less pass and stranded the real hours forever.
    await db.execute(sql`insert into time_entries
      (org_id,employee_party_id,worked_on,hours,project_id,status,
       cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      select ${org.orgId},${employeeId},'2026-07-01',0.01,${proj},'approved',
        25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId}
        from generate_series(1, 2000)`);
    await db.execute(sql`insert into time_entries
      (id,org_id,employee_party_id,worked_on,hours,project_id,department_id,status,
       cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      values(${randomUUID()},${org.orgId},${employeeId},'2026-07-03',2,${proj},${deptShop},
        'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId})`);
    assert.equal((await countUnappliedOverheadTime(org.orgId)).entries, 2001);
    const backfill = await backfillOverhead(org.orgId, actorId);
    assert.equal(backfill.entries, 1);
    assert.equal(backfill.journals, 1);
    assert.equal(backfill.dust, 2000);
    assert.equal((await countUnappliedOverheadTime(org.orgId)).entries, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mixed batch carries and stamps dust in one unit", async () => {
  const f = await seedDustOrg();
  try {
    const mixed = await applyOverheadForTime(f.orgId, f.actorId, [f.dustEarly, f.normalId]);
    assert.ok(mixed.entryId);
    assert.equal(mixed.entries, 1);
    assert.equal(mixed.total, "20.0000");
    assert.equal(mixed.dust, 1);
    assert.equal((await customOf(f.orgId, f.dustEarly)).overheadZeroApplied, true);
    // One dust entry remains: the backlog counts exactly it.
    assert.equal((await countUnappliedOverheadTime(f.orgId)).entries, 1);
  } finally {
    await dropScratchOrg(f.orgId);
  }
});
