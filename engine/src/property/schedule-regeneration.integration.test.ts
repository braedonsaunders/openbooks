import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { scheduleLeaseCharges } from "./management.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * B-PRP-005: the daily scheduler rolls a 13-month window while an operator
 * may cut a look-ahead horizon in the same minute. The overlap must serialize
 * on the lease so the loser re-reads committed charges and counts only
 * genuinely new lines — six monthly periods July–December materialise exactly
 * once however the two runs interleave.
 */
test("overlapping schedule regenerations serialize on the lease", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const holder = await pool.connect();
  let contender: Promise<{ created: number }> | undefined;
  let open = true;
  try {
    const actor = await createScratchUser(org.orgId, "Schedule operator", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
    const propertyId = randomUUID(), leaseId = randomUUID(), chargeId = randomUUID();
    await db.execute(sql`insert into managed_properties(id,org_id,subsidiary_id,code,name,property_type,currency,rent_income_account_id)
      values(${propertyId},${org.orgId},${org.subsidiaryId},'REGEN','Regen tower','commercial','CAD',${org.accounts.revenue})`);
    await db.execute(sql`insert into property_leases(id,org_id,property_id,tenant_id,lease_number,status,starts_on,billing_day,payment_terms_days,auto_invoice,auto_post)
      values(${leaseId},${org.orgId},${propertyId},${org.customerId},'REGEN','active','2026-07-01',1,0,true,false)`);
    await db.execute(sql`insert into lease_charges(id,org_id,lease_id,charge_type,description,amount,frequency,effective_from,income_account_id)
      values(${chargeId},${org.orgId},${leaseId},'base_rent','Monthly rent','1000','monthly','2026-07-01',${org.accounts.revenue})`);

    // An in-flight regen holds the per-lease lock across an open transaction,
    // the way a scheduler tick does while it writes.
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls','on',true)");
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `property-schedule:${org.orgId}:${leaseId}`,
    ]);
    const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

    let settled = false;
    contender = scheduleLeaseCharges(org.orgId, actor, null, leaseId, "2026-12-31").then(
      (value) => { settled = true; return value; },
      (reason: unknown) => { settled = true; throw reason; },
    );
    let blocked = false;
    for (let attempt = 0; attempt < 400 && !settled && !blocked; attempt += 1) {
      const n = (await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
        [holderPid],
      )).rows[0]!.n;
      if (n) blocked = true;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the overlapping regen must wait for the in-flight regen instead of racing it");

    await holder.query("commit");
    open = false;
    const result = await contender;
    assert.equal(result.created, 6, "six monthly periods July-December materialise exactly once");
    const lines = (await db.execute<{ n: number; total: string }>(sql`
      select count(*)::int as n, coalesce(sum(amount),0)::text as total from lease_schedule_lines
       where org_id=${org.orgId} and lease_id=${leaseId}`)).rows[0]!;
    assert.deepEqual([lines.n, lines.total], [6, "6000.0000"]);

    // A pure re-run replays the same deterministic stream and creates nothing.
    assert.equal((await scheduleLeaseCharges(org.orgId, actor, null, leaseId, "2026-12-31")).created, 0);
  } finally {
    if (open) await holder.query("rollback").catch(() => undefined);
    holder.release();
    await contender?.then(() => undefined, () => undefined);
    await dropScratchOrg(org.orgId);
  }
});
