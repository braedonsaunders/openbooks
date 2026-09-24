import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, env } from "../platform/db.ts";
import { createPayApplication, ConstructionBillingError } from "./construction-billing.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

test("createPayApplication refuses by name while Projects is disabled and writes nothing", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb)
      where id=${org.orgId}`);
    await assert.rejects(
      createPayApplication(org.orgId, actorId, projectId, "2026-08-31", "10", null),
      (error: unknown) =>
        error instanceof ConstructionBillingError && error.message === "Projects feature is disabled",
    );
    const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from pay_applications
      where org_id=${org.orgId}`)).rows[0]!.n;
    assert.equal(count, 0, "a refused application must leave no pay_applications row");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("createPayApplication blocked on the fence loses to a committed Projects disable", async () => {
  const org = await createScratchOrg();
  const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  let pending: Promise<unknown> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{}'::jsonb)
      || '{"projects":true}'::jsonb where id=${org.orgId}`);
    await writer.connect();
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    // Stage the disable without committing: the uncommitted flag write holds
    // the org row exclusively, so a creator that checked the gate first must
    // wait on the fence instead of racing past it.
    await writer.query("update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb) where id=$1", [
      org.orgId,
    ]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = createPayApplication(org.orgId, actorId, projectId, "2026-08-31", "10", null);
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await writer.query("select pg_stat_clear_snapshot()");
      const row = (await writer.query<{ blocked: boolean }>(
        "select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked",
        [pid],
      )).rows[0]!;
      if (row.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(blocked, "create must wait on the feature fence while the disable holds the org row");
    await writer.query("commit");
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ConstructionBillingError && error.message === "Projects feature is disabled",
    );
    const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from pay_applications
      where org_id=${org.orgId}`)).rows[0]!.n;
    assert.equal(count, 0, "the losing creator must leave no pay_applications row");
  } finally {
    await writer.query("rollback").catch(() => {});
    await writer.end();
    await pending?.catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});
