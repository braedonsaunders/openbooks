import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.project-percent-feature-race")] = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../../../../../lib/authz" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/projects/[id]/percent-complete/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardPermission(){return globalThis[Symbol.for('openbooks.project-percent-feature-race')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PUT } = await import("../app/api/projects/[id]/percent-complete/route");

test("project percent-complete refuses a Projects disable committed while its write waits", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID();
    state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["projects.manage"]), allowedSubsidiaryIds: null } as Authz;
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"revenueRecognition":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,status,is_active,custom)
      values(${projectId},${org.orgId},${org.subsidiaryId},'PERCENT-FENCE','Percentage fence','active',true,'{}'::jsonb)`);
    const snapshot = async () => (await db.execute(sql`select custom,updated_at,updated_by from projects where org_id=${org.orgId} and id=${projectId}`)).rows[0]!;
    const before = await snapshot();
    const send = () => PUT(new Request("https://openbooks.test/api/projects/fixture/percent-complete", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ percentComplete: 75 }),
    }), { params: Promise.resolve({ id: projectId }) });
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb) where id=$1", [org.orgId]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = send();
    void pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
      if (row.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "request must reach the write fence after reading the old enabled feature");
    await writer.query("commit");
    const response = await pending;
    assert.equal(response.status, 404, JSON.stringify(await response.json()));
    assert.deepEqual(await snapshot(), before, "disabled feature must preserve the override and its audit columns");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','true'::jsonb) where id=${org.orgId}`);
    assert.equal((await send()).status, 200);
    assert.equal(((await snapshot()).custom as { percentCompleteOverride: number }).percentCompleteOverride, 75);
  } finally {
    await writer.query("rollback");
    writer.release();
    await pending?.catch(() => {});
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
