import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { postProjectLaborCost, reverseProjectLaborCost } from "./project-recognition.ts";
import { applyOverheadForTime, reverseOverheadForTime } from "./overhead-apply.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

async function seed() {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID(), projectId = randomUUID(), timeId = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      controlAccounts: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank,
        laborWip: org.accounts.cogs, laborClearing: org.accounts.clearing },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${employeeId},${org.orgId},'person','Project gate worker',${org.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${projectId},${org.orgId},${org.subsidiaryId},'FEATURE-GATE','Project gate job',${org.customerId},'active',true,'{}'::jsonb)`);
    await db.execute(sql`insert into time_entries
      (id,org_id,employee_party_id,worked_on,hours,project_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      values(${timeId},${org.orgId},${employeeId},${org.date},2,${projectId},'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId})`);
    await db.execute(sql`insert into overhead_rates(id,org_id,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${org.orgId},'standard','per_hour',12.5,'2026-07-01')`);
    return { org, actorId, projectId, timeId };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

for (const operation of ["labor", "overhead"] as const) {
  for (const scenario of ["already disabled", "disable commits while waiting"] as const) {
    test(`project ${operation} honors its parent gate: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const { org, actorId, projectId, timeId } = await seed();
      const writer = await pool.connect();
      let pending: Promise<PromiseSettledResult<string | null>> | undefined;
      const run = async () => operation === "labor"
        ? (await postProjectLaborCost(org.orgId, actorId, [timeId]))[0] ?? null
        : (await applyOverheadForTime(org.orgId, actorId, [timeId])).entryId;
      const toggle = (enabled: boolean) => db.execute(sql`update orgs
        set settings=jsonb_set(settings,'{features,projects}',${JSON.stringify(enabled)}::jsonb) where id=${org.orgId}`);
      try {
        if (scenario === "already disabled") {
          await toggle(false);
          assert.equal(await run(), null);
        } else {
          await writer.query("begin");
          await writer.query("select set_config('app.bypass_rls','on',true)");
          await writer.query("update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb) where id=$1", [org.orgId]);
          const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
          pending = run().then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
          let blocked = false;
          for (let attempt = 0; attempt < 400; attempt++) {
            const count = (await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))", [pid],
            )).rows[0]!.n;
            if (count) { blocked = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(blocked, "posting must wait for the authoritative feature edit");
          await writer.query("commit");
          assert.deepEqual(await pending, { status: "fulfilled", value: null });
        }
        const untouched = (await db.execute<{
          status: string; hours: string; cost_journal_entry_id: string | null; overhead_journal_entry_id: string | null; projects: number; journals: number;
        }>(sql`select t.status,t.hours::text,t.cost_journal_entry_id,t.overhead_journal_entry_id,
          (select count(*)::int from projects where org_id=t.org_id and id=${projectId}) as projects,
          (select count(*)::int from journal_entries where org_id=t.org_id) as journals
          from time_entries t where t.org_id=${org.orgId} and t.id=${timeId}`)).rows[0]!;
        assert.deepEqual(untouched, { status: "approved", hours: "2.0000", cost_journal_entry_id: null,
          overhead_journal_entry_id: null, projects: 1, journals: 0 });
        await toggle(true);
        const entryId = await run();
        assert.ok(entryId, "re-enabling posts the preserved source");
        assert.equal(await run(), null, "retry still posts once");
        await toggle(false);
        const reverse = operation === "labor" ? reverseProjectLaborCost : reverseOverheadForTime;
        await reverse(org.orgId, actorId, [timeId], "Controller approved historical correction", org.date);
        const source = (await db.execute<{ status: string }>(sql`
          select status from journal_entries where org_id=${org.orgId} and id=${entryId}`)).rows[0]!;
        assert.equal(source.status, "reversed", "disabled features preserve controlled correction of history");
        assert.equal(await run(), null, "disabled parent prevents recreating the reversed posting");
      } finally {
        await writer.query("rollback");
        writer.release();
        await pending;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
