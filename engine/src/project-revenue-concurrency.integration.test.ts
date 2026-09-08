import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { syncProjectRevenueContracts } from "./project-revenue.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

test("concurrent project revenue sync converges on one contract and obligation", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const blocker = await pool.connect();
  let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof syncProjectRevenueContracts>>>[]> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID(), typeId = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, revenueRecognition: true },
      controlAccounts: { unbilledReceivable: org.accounts.ar, projectRevenue: org.accounts.revenue },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${typeId},${org.orgId},'gate-poc','Gate POC','fixed_price',
        '{"recognition":"percent_complete_cost","billingProcedure":"standard"}'::jsonb,'{}'::jsonb)`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,starts_on,contract_value,custom)
      values(${projectId},${org.orgId},${org.subsidiaryId},'GATE-POC','Gate POC project',${org.customerId},${typeId},'active',true,
        ${org.date},1000,'{"percentCompleteOverride":"25"}'::jsonb)`);

    await db.execute(sql`insert into recognition_rules(org_id,code,name,method,is_active)
      values(${org.orgId},'PROJECT-POC','Project percent complete','percent_complete',true)`);
    await blocker.query("begin");
    await blocker.query("lock table revenue_contracts in share mode");
    const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = Promise.allSettled([
      syncProjectRevenueContracts(org.orgId, actorId, org.date, projectId),
      syncProjectRevenueContracts(org.orgId, actorId, org.date, projectId),
    ]);
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const count = (await pool.query<{ n: number }>(`with recursive blocked(pid) as (
        select pid from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))
      ) select count(*)::int as n from blocked`, [pid])).rows[0]!.n;
      if (count >= 2) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "both synchronizations must compete while contract creation is fenced");
    await blocker.query("commit");
    const results = await pending;
    for (const result of results) assert.equal(result.status, "fulfilled");
    const count = (await db.execute<{ contracts: number; obligations: number }>(sql`
      select (select count(*)::int from revenue_contracts where org_id=${org.orgId} and project_id=${projectId}) as contracts,
        (select count(*)::int from performance_obligations o join revenue_contracts c on c.id=o.contract_id and c.org_id=o.org_id
          where c.org_id=${org.orgId} and c.project_id=${projectId}) as obligations`)).rows[0]!;
    assert.deepEqual(count, { contracts: 1, obligations: 1 });
    const synced = results.flatMap((result) => result.status === "fulfilled" ? result.value.synced : []);
    assert.equal(synced.length, 2);
    assert.equal(synced[0]!.contractId, synced[1]!.contractId);
    assert.equal(synced[0]!.obligationId, synced[1]!.obligationId);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await pending;
    await dropScratchOrg(org.orgId);
  }
});
