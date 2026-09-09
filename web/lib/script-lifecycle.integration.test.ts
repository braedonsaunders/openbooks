import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const control: { user: SessionUser | null; afterRun: (() => Promise<void>) | null } = { user: null, afterRun: null };
Object.assign(globalThis, { __scriptLifecycle: control });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptLifecycle.user}" };
  }
  // Execute the real runner, then optionally hold its return at the race
  // boundary. API guards, QuickJS, history, and database writes remain real.
  if (specifier === "@openbooks/engine/src/scripting.ts" && decodeURIComponent(context.parentURL ?? "").endsWith("/scripts/[id]/run/route.ts")) {
    const actual = JSON.stringify(root + "engine/src/scripting.ts");
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(`
      export * from ${actual};
      import { runScheduledScript as actual } from ${actual};
      export async function runScheduledScript(...args) {
        const outcome = await actual(...args);
        await globalThis.__scriptLifecycle.afterRun?.();
        return outcome;
      }`) };
  }
  if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH } = await import("../app/api/admin/scripts/route");
const { DELETE } = await import("../app/api/admin/scripts/[id]/route");
const { POST: RUN } = await import("../app/api/admin/scripts/[id]/run/route");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(run: (orgId: string, id: string, actor: string) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Script administrator", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
    control.user = { id: actor, orgId: org.orgId, name: "Script administrator", email: "script@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const row = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,cron,next_run_at,is_active)
      values(${org.orgId},'Scheduled','scheduled','function main(ctx) { return 42; }','0 12 * * *','2030-01-01 12:00:00.123456+00',true) returning id`)).rows[0]!;
    await run(org.orgId, row.id, actor);
  } finally {
    control.user = null;
    control.afterRun = null;
    await dropScratchOrgReporting(org.orgId);
  }
}
const patchBody = (id: string, overrides: Record<string, unknown> = {}) => ({ id, name: "Edited", triggerPoint: "scheduled", source: "function main(ctx) { return 1; }", cron: "0 12 * * *", isActive: true, ...overrides });
function patch(orgId: string, id: string, overrides: Record<string, unknown> = {}) {
  return withOrgContext(orgId, () => PATCH(new Request("http://audit.local/api/admin/scripts", { method: "PATCH", body: JSON.stringify(patchBody(id, overrides)) })));
}
function runNow(orgId: string, id: string) {
  return withOrgContext(orgId, () => RUN(new Request("http://audit.local/api/admin/scripts/" + id + "/run", { method: "POST" }), { params: Promise.resolve({ id }) }));
}
async function cursor(orgId: string, id: string) {
  return (await db.execute<{ cursor: string | null }>(sql`select next_run_at::text as cursor from user_scripts where org_id=${orgId} and id=${id}`)).rows[0]!.cursor;
}

test("ordinary script edits retain the live locked cursor and its microseconds", enabled, async () => fixture(async (orgId, id) => {
  const blocker = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await blocker.query("begin");
    await blocker.query("select set_config('app.current_org',$1,true)", [orgId]);
    const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await blocker.query("update user_scripts set next_run_at='2031-01-01 12:00:00.654321+00' where org_id=$1 and id=$2", [orgId, id]);
    pending = patch(orgId, id, { timeoutMs: 3000, sortOrder: 42 });
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as waiting`)).rows[0]!.waiting;
      if (waiting) break;
      await delay(10);
    }
    assert.ok(waiting, "PATCH reached the live row lock");
    await blocker.query("commit");
    assert.equal((await pending).status, 200);
    assert.match((await cursor(orgId, id))!, /^2031-01-01 .*\.654321/);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await pending?.catch(() => undefined);
  }
}));

for (const transition of ["cron", "disable", "event", "activate"] as const) {
  test(`script PATCH applies the ${transition} scheduling transition`, enabled, async () => fixture(async (orgId, id) => {
    if (transition === "activate") await db.execute(sql`update user_scripts set is_active=false,next_run_at=null where org_id=${orgId} and id=${id}`);
    const from = Date.now();
    const overrides = transition === "cron" ? { cron: "0 13 * * *" } : transition === "disable" ? { isActive: false }
      : transition === "event" ? { triggerPoint: "before_submit", cron: null } : {};
    assert.equal((await patch(orgId, id, overrides)).status, 200);
    const next = await cursor(orgId, id);
    if (transition === "disable" || transition === "event") assert.equal(next, null);
    else {
      assert.ok(next);
      const date = new Date(next);
      assert.ok(date.getTime() > from && date.getTime() <= Date.now() + 86_400_000);
      assert.equal(date.getUTCHours(), transition === "cron" ? 13 : 12);
    }
  }));
}

for (const active of [true, false]) {
  test(`script DELETE preserves ${active ? "active" : "inactive"} execution history with an actionable conflict`, enabled, async () => fixture(async (orgId, id, actor) => {
    await db.execute(sql`update user_scripts set is_active=${active},next_run_at=case when ${active} then next_run_at else null end where org_id=${orgId} and id=${id}`);
    await db.execute(sql`insert into script_runs(org_id,script_id,status,created_by) values(${orgId},${id},'ok',${actor})`);
    const response = await withOrgContext(orgId, () => DELETE(new Request("http://audit.local/api/admin/scripts/" + id, { method: "DELETE" }), { params: Promise.resolve({ id }) }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Deactivate.*preserve/i);
    assert.equal((await db.execute(sql`select id from script_runs where org_id=${orgId} and script_id=${id}`)).rows.length, 1);
    assert.equal((await db.execute(sql`select is_active from user_scripts where org_id=${orgId} and id=${id}`)).rows[0]!.is_active, active);
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${orgId} and table_name='user_scripts'`)).rows.length, 0);
    assert.equal((await patch(orgId, id, { isActive: false })).status, 200);
    assert.equal(await cursor(orgId, id), null);
  }));
}

for (const [trigger, active, status] of [["scheduled", false, 409], ["bulk", false, 409], ["before_submit", true, 422], ["endpoint", true, 422], ["client", true, 422]] as const) {
  test(`Run now refuses ${active ? "active" : "inactive"} ${trigger} before execution`, enabled, async () => fixture(async (orgId, id) => {
    await db.execute(sql`update user_scripts set trigger_point=${trigger},is_active=${active} where org_id=${orgId} and id=${id}`);
    const before = await cursor(orgId, id);
    assert.equal((await runNow(orgId, id)).status, status);
    assert.equal(await cursor(orgId, id), before);
    assert.equal((await db.execute(sql`select id from script_runs where org_id=${orgId} and script_id=${id}`)).rows.length, 0);
  }));
}

test("Run now advances an unchanged microsecond cursor and records the authenticated actor", enabled, async () => fixture(async (orgId, id, actor) => {
  const from = Date.now();
  const response = await runNow(orgId, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  const next = new Date((await cursor(orgId, id))!).getTime();
  assert.ok(next > from && next <= Date.now() + 86_400_000);
  assert.deepEqual((await db.execute(sql`select created_by,status from script_runs where org_id=${orgId} and script_id=${id}`)).rows, [{ created_by: actor, status: "ok" }]);
}));

for (const change of ["cron", "deactivate", "trigger", "tick"] as const) {
  test(`Run now cannot overwrite a concurrent ${change} scheduling change`, enabled, async () => fixture(async (orgId, id) => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    control.afterRun = async () => { reached.resolve(); await release.promise; };
    const pending = runNow(orgId, id);
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error("runner gate was not reached"); })]);
      // Preserve the original cursor for policy changes to prove each CAS
      // predicate independently. The tick changes only its final microsecond.
      if (change === "cron") await db.execute(sql`update user_scripts set cron='0 13 * * *' where org_id=${orgId} and id=${id}`);
      if (change === "deactivate") await db.execute(sql`update user_scripts set is_active=false where org_id=${orgId} and id=${id}`);
      if (change === "trigger") await db.execute(sql`update user_scripts set trigger_point='before_submit' where org_id=${orgId} and id=${id}`);
      if (change === "tick") await db.execute(sql`update user_scripts set next_run_at='2030-01-01 12:00:00.123457+00' where org_id=${orgId} and id=${id}`);
      const expected = await cursor(orgId, id);
      release.resolve();
      assert.equal((await pending).status, 200);
      assert.equal(await cursor(orgId, id), expected);
    } finally {
      release.resolve();
      await pending;
      control.afterRun = null;
    }
  }));
}
