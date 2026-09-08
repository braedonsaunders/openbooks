import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "./db.ts";
import { calculatePayRun, commitPayRun, createPayRun } from "./payroll-run.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

async function evidence(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'documents',(select jsonb_agg(to_jsonb(d) order by id) from documents d where org_id=${orgId}),
    'runs',(select jsonb_agg(to_jsonb(r) order by document_id) from pay_runs r where org_id=${orgId}),
    'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from pay_stub_lines l where org_id=${orgId}),
    'projection',(select jsonb_agg(to_jsonb(l) order by id) from document_lines l where org_id=${orgId}),
    'sequences',(select jsonb_agg(to_jsonb(s) order by id) from number_sequences s where org_id=${orgId}),
    'time',(select jsonb_agg(to_jsonb(t) order by id) from time_entries t where org_id=${orgId})
  ) as state`)).rows[0]!.state;
}

for (const operation of ["create", "calculate", "dry-run", "simulate", "commit"] as const) {
  test(`disabled Payroll refuses ${operation} without changing evidence`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      if (operation === "simulate") await commitPayRun(input);
      const before = await evidence(fx.orgId);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":false}'::jsonb) where id=${fx.orgId}`);
      const run = () => operation === "create" ? createPayRun({ orgId: fx.orgId, actorId: fx.actorId,
        payScheduleId: fx.scheduleId, periodStart: "2026-06-21", periodEnd: "2026-07-04" })
        : operation === "commit" ? commitPayRun(input)
        : calculatePayRun({ ...input, dryRun: operation === "dry-run", simulate: operation === "simulate" });
      await withOrgTransaction(fx.orgId, async () => {
        await assert.rejects(run(), /payroll feature is disabled/i);
        assert.deepEqual(await evidence(fx.orgId), before);
      });
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','true'::jsonb) where id=${fx.orgId}`);
      assert.ok(await run(), "reenabling Payroll restores the operation against preserved data");
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });
}

for (const operation of ["create", "calculate", "commit"] as const) {
  test(`payroll ${operation} waits for a concurrent feature disable`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    const writer = await pool.connect();
    let pending: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      const { input } = await calculatedRun(fx);
      const before = await evidence(fx.orgId);
      await writer.query("begin");
      await writer.query("select set_config('app.bypass_rls','on',true)");
      await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"payroll\":false}'::jsonb) where id=$1", [fx.orgId]);
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const call = operation === "create" ? createPayRun({ orgId: fx.orgId, actorId: fx.actorId,
        payScheduleId: fx.scheduleId, periodStart: "2026-06-21", periodEnd: "2026-07-04" })
        : operation === "calculate" ? calculatePayRun(input) : commitPayRun(input);
      pending = call.then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
      let blocked = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "payroll must wait for the authoritative feature state");
      await writer.query("commit");
      const result = await pending;
      if (result.status !== "rejected") assert.fail("disabled Payroll must refuse new work");
      assert.ok(result.reason instanceof Error);
      const code = (result.reason as Error & { cause?: { code?: string } }).cause?.code;
      assert.ok(/payroll feature is disabled/i.test(result.reason.message) || (operation === "calculate" && code === "40001"));
      assert.deepEqual(await evidence(fx.orgId), before);
    } finally {
      await writer.query("rollback"); writer.release(); await pending;
      await dropScratchOrgReporting(fx.orgId);
    }
  });
}
