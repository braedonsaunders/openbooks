import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "./db.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { calculatePayRun, commitPayRun, createPayRun } from "./payroll-run.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

async function snapshot(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'runs',(select jsonb_agg(to_jsonb(r) order by document_id) from pay_runs r where org_id=${orgId}),
    'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from pay_stub_lines l where org_id=${orgId}),
    'components',(select jsonb_agg(to_jsonb(c) order by id) from pay_components c where org_id=${orgId}),
    'projection',(select jsonb_agg(to_jsonb(d) order by id) from document_lines d where org_id=${orgId}),
    'claims',(select jsonb_agg(jsonb_build_object('id',id,'batch',payroll_batch_ref) order by id) from time_entries where org_id=${orgId})
    ) as state`)).rows[0]!.state;
}

for (const scenario of ["existing snapshot", "fresh roster"] as const) {
  test(`scoped calculation preserves the entire hidden ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Hidden calculation owner','CAD','CA')`);
      await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      const input = scenario === "existing snapshot" ? (await calculatedRun(fx)).input : {
        orgId: fx.orgId, actorId: fx.actorId, documentId: (await createPayRun({ orgId: fx.orgId, actorId: fx.actorId,
          payScheduleId: fx.scheduleId, periodStart: "2026-07-05", periodEnd: "2026-07-18" })).documentId,
      };
      const before = await snapshot(fx.orgId);
      await withOrgTransaction(fx.orgId, async () => {
        await assert.rejects(calculatePayRun({ ...input, allowedSubsidiaryIds: new Set([fx.subsidiaryId]) }), /pay run not found/);
        assert.deepEqual(await snapshot(fx.orgId), before, "a caught scope refusal cannot rewrite any payroll evidence");
      });
      const allowed = { ...input, allowedSubsidiaryIds: new Set([fx.subsidiaryId, childId]) };
      const calculated = await calculatePayRun(allowed);
      assert.equal(calculated.employees, 1);
      assert.deepEqual(calculated.errors, []);
      if (scenario === "existing snapshot") assert.ok((await commitPayRun(allowed)).lines > 0);
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });
}

for (const operation of ["calculate", "commit"] as const) {
  test(`payroll ${operation} refuses a concurrent employee transfer before any writes`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    const writer = await pool.connect();
    let pending: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      await db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      const { input } = await calculatedRun(fx);
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Transferred calculation owner','CAD','CA')`);
      const before = await snapshot(fx.orgId);
      await writer.query("begin"); await writer.query("select set_config('app.bypass_rls','on',true)");
      await writer.query("update parties set subsidiary_id=$1 where org_id=$2 and id=$3", [childId, fx.orgId, fx.employeeId]);
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const call = { ...input, allowedSubsidiaryIds: new Set([fx.subsidiaryId]) };
      pending = (operation === "calculate" ? calculatePayRun(call) : commitPayRun(call))
        .then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
      let blocked = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "payroll must wait for employee ownership");
      await writer.query("commit");
      const result = await pending;
      if (result.status !== "rejected") assert.fail("inaccessible employee must be refused");
      assert.ok(result.reason instanceof Error);
      const code = (result.reason as Error & { cause?: { code?: string } }).cause?.code;
      // Calculation uses repeatable read: a transfer committed after its
      // snapshot must abort serialization rather than read the newer owner.
      assert.ok(/pay run not found/.test(result.reason.message) || (operation === "calculate" && code === "40001"));
      assert.deepEqual(await snapshot(fx.orgId), before);
    } finally {
      await writer.query("rollback"); writer.release(); await pending;
      await dropScratchOrgReporting(fx.orgId);
    }
  });
}
