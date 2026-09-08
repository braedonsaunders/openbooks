import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { mutatePayRunAdjustment } from "./payroll-run-adjustments.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

for (const scenario of ["authorized", "hidden snapshot", "concurrent transfer"] as const) {
  test(`direct payroll adjustment scope: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    const writer = await pool.connect();
    let pending: Promise<PromiseSettledResult<{ changed: boolean }>> | undefined;
    try {
      await db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      const { input } = await calculatedRun(fx);
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Restricted adjustment owner','CAD','CA')`);
      let targetId = fx.employeeId;
      if (scenario === "hidden snapshot") {
        await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
        targetId = randomUUID();
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active)
          values(${targetId},${fx.orgId},'person','Visible adjustment target',${fx.subsidiaryId},true)`);
        await db.execute(sql`insert into employee_payroll_profiles(org_id,employee_party_id,pay_schedule_id,province,pay_basis,is_active,created_by,updated_by)
          values(${fx.orgId},${targetId},${fx.scheduleId},'ON','hourly',true,${fx.actorId},${fx.actorId})`);
      }
      const snapshot = async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
        'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${input.documentId}),
        'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${fx.orgId}),
        'adjustments',(select jsonb_agg(to_jsonb(a) order by id) from pay_run_adjustments a where org_id=${fx.orgId})
        ) as state`)).rows[0]!.state;
      const before = await snapshot();
      const change = () => mutatePayRunAdjustment({ ...input, allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: { action: "exclude", employeePartyId: targetId } });
      if (scenario === "authorized") {
        assert.deepEqual(await change(), { changed: true });
        assert.notDeepEqual(await snapshot(), before);
      } else if (scenario === "hidden snapshot") {
        await assert.rejects(change(), /pay run not found/);
        assert.deepEqual(await snapshot(), before);
      } else {
        await writer.query("begin");
        await writer.query("select set_config('app.bypass_rls','on',true)");
        await writer.query("update parties set subsidiary_id=$1 where org_id=$2 and id=$3", [childId, fx.orgId, targetId]);
        const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        pending = change().then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
        let blocked = false;
        for (let attempt = 0; attempt < 400; attempt++) {
          const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
          if (row.blocked) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "adjustment must wait for employee ownership");
        await writer.query("commit");
        const result = await pending;
        if (result.status !== "rejected") assert.fail("transferred employee must be refused");
        assert.ok(result.reason instanceof Error);
        assert.match(result.reason.message, /pay run not found/);
        assert.deepEqual(await snapshot(), before);
      }
    } finally {
      await writer.query("rollback"); writer.release(); await pending;
      await dropScratchOrgReporting(fx.orgId);
    }
  });
}
