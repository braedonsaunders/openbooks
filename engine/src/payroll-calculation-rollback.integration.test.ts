import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "./db.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { calculatePayRun, commitPayRun } from "./payroll-run.ts";
import { cmp } from "./money.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

async function evidence(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'documents',(select jsonb_agg(to_jsonb(d) order by id) from documents d where org_id=${orgId}),
    'runs',(select jsonb_agg(to_jsonb(r) order by document_id) from pay_runs r where org_id=${orgId}),
    'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from pay_stub_lines l where org_id=${orgId}),
    'components',(select jsonb_agg(to_jsonb(c) order by id) from pay_components c where org_id=${orgId}),
    'entitlements',(select jsonb_agg(to_jsonb(e) order by id) from entitlement_ledger e where org_id=${orgId}),
    'projection',(select jsonb_agg(to_jsonb(d) order by id) from document_lines d where org_id=${orgId}),
    'time',(select jsonb_agg(to_jsonb(t) order by id) from time_entries t where org_id=${orgId})
  ) as state`)).rows[0]!.state;
}

test("a caught late payroll commit refusal restores all evidence in an ambient transaction",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    const blocker = await pool.connect();
    let pending: Promise<PromiseSettledResult<void>> | undefined;
    try {
      const { input } = await calculatedRun(fx);
      const line = (await db.execute<{ id: string }>(sql`insert into document_lines
        (org_id,document_id,line_number,account_id,description,amount,created_by,updated_by)
        select ${fx.orgId},${input.documentId},1,id,'Existing draft projection',1,${fx.actorId},${fx.actorId}
        from accounts where org_id=${fx.orgId} and number='6000' returning id`)).rows[0]!;
      const before = await evidence(fx.orgId);
      await blocker.query("begin");
      await blocker.query("select set_config('app.bypass_rls','on',true)");
      await blocker.query("select id from document_lines where org_id=$1 and id=$2 for update", [fx.orgId, line.id]);
      const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      pending = withOrgTransaction(fx.orgId, async () => {
        await assert.rejects(commitPayRun(input), /inputs changed after it was last calculated \(settings\)/);
        assert.deepEqual(await evidence(fx.orgId), before, "caught refusal must restore projection, liabilities, and time claims");
      }).then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
      let blocked = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "commit must reach projection replacement after its initial freshness checks");
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout='2s'`);
        await tx.execute(sql`update orgs set updated_at=clock_timestamp() where id=${fx.orgId}`);
      });
      await blocker.query("commit");
      const result = await pending;
      if (result.status === "rejected") throw result.reason;
      assert.deepEqual(await evidence(fx.orgId), before);
      assert.deepEqual((await calculatePayRun(input)).errors, []);
      assert.ok((await commitPayRun(input)).lines > 0);
    } finally {
      await blocker.query("rollback"); blocker.release(); await pending;
      await dropScratchOrgReporting(fx.orgId);
    }
  });

for (const mode of ["dry-run", "simulation"] as const) {
  for (const ambient of [false, true]) {
    test(`payroll ${mode} preserves all evidence ${ambient ? "inside an ambient transaction" : "standalone"}`,
      { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
        const fx = await seedAdoption();
        try {
          const { input } = await calculatedRun(fx);
          if (mode === "simulation") await commitPayRun(input);
          const before = await evidence(fx.orgId);
          const preview = async () => {
            const result = await calculatePayRun({ ...input, ...(mode === "simulation" ? { simulate: true } : { dryRun: true }) });
            assert.equal(result.employees, 1);
            assert.deepEqual(result.errors, []);
            assert.equal(cmp(result.gross, "240"), 0);
            if (mode === "simulation") assert.equal(result.stubs?.length, 1);
            assert.deepEqual(await evidence(fx.orgId), before, "preview must preserve IDs, values, and audit evidence");
          };
          if (ambient) {
            await withOrgTransaction(fx.orgId, async () => {
              await db.execute(sql`update parties set custom=custom || '{"previewCallerWork":true}'::jsonb
                where org_id=${fx.orgId} and id=${fx.employeeId}`);
              await preview();
            });
            assert.equal((await db.execute<{ marker: boolean }>(sql`select (custom->>'previewCallerWork')::boolean as marker
              from parties where org_id=${fx.orgId} and id=${fx.employeeId}`)).rows[0]!.marker, true,
            "preview rollback must preserve the caller's earlier work");
          } else await preview();
          assert.deepEqual(await evidence(fx.orgId), before, "committing the caller transaction cannot persist preview writes");
          if (mode === "dry-run") {
            assert.deepEqual((await calculatePayRun(input)).errors, []);
            assert.ok((await commitPayRun(input)).lines > 0, "real calculation and commit must still persist");
          }
        } finally { await dropScratchOrgReporting(fx.orgId); }
      });
  }
}
