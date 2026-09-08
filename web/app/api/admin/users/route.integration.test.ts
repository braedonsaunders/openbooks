import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, orgContext, withOrgTransaction } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

const state: { authz: {
  user: { orgId: string; id: string; isSuperAdmin: boolean };
  permissions: Set<string>; allowedSubsidiaryIds: null;
} | null } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.user-control-integration")] = state;
const hooks = registerHooks({ resolve(specifier, context, next) {
  const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
  if (specifier === "server-only") return virtual("export {}");
  if (specifier.endsWith("/lib/authz") && /\/api\/admin\/(users|roles)\/route.ts/.test(context.parentURL ?? "")) {
    return virtual("export async function guardPermission(){return globalThis[Symbol.for('openbooks.user-control-integration')].authz}");
  }
  return next(specifier, context);
} });
const { POST } = await import("./route");
const { DELETE } = await import("../roles/route");
hooks.deregister();
const skip = !process.env.OPENBOOKS_DB_URL;

const request = (method: string, body: object) => new Request("http://localhost/api/admin/users", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const call = (body: object) => POST(request("POST", body));

async function seed() {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Control actor", "control_actor");
  const targetId = await createScratchUser(org.orgId, "Control target", "control_target");
  const firstRole = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${org.orgId} and key = 'control_target'`)).rows[0]!.id;
  const extraRole = (await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
    values (${org.orgId}, 'control_extra', 'Extra', false, '[]'::jsonb) returning id`)).rows[0]!.id;
  state.authz = { user: { orgId: org.orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(["admin.users.manage", "admin.roles.manage"]), allowedSubsidiaryIds: null };
  return { orgId: org.orgId, actorId, targetId, firstRole, extraRole };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function assignments(f: Fixture, userId = f.targetId) {
  return (await db.execute<{ role_id: string }>(sql`select role_id from role_assignments
    where org_id = ${f.orgId} and user_id = ${userId} order by role_id`)).rows.map((row) => row.role_id);
}

async function waitForBlocked(pid: number, minimum = 1) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await pool.query<{ n: number }>(`with recursive waiting(pid) as (
      select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))
      union select a.pid from pg_stat_activity a join waiting w on w.pid = any(pg_blocking_pids(a.pid))
    ) select count(*)::int as n from waiting`, [pid]);
    if (result.rows[0]!.n >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("requests did not reach the controlled concurrency barrier");
}

test("UUID case cannot bypass self-grant or self-deactivation, and unassignment removes the equivalent role", { skip }, async () => {
  const f = await seed();
  try {
    const before = await assignments(f, f.actorId);
    assert.equal((await call({ action: "assign", userId: f.actorId.toUpperCase(), roleId: f.extraRole.toUpperCase() })).status, 403);
    assert.equal((await call({ action: "set-active", userId: f.actorId.toUpperCase(), isActive: false })).status, 400);
    assert.deepEqual(await assignments(f, f.actorId), before);
    assert.equal((await db.execute(sql`select is_active from users where id = ${f.actorId}`)).rows[0]!.is_active, true);
    assert.equal((await call({ action: "assign", userId: f.targetId.toUpperCase(), roleId: f.extraRole.toUpperCase() })).status, 200);
    assert.ok((await assignments(f)).includes(f.extraRole));
    assert.equal((await call({ action: "unassign", userId: f.targetId.toUpperCase(), roleId: f.extraRole.toUpperCase() })).status, 200);
    assert.deepEqual(await assignments(f), [f.firstRole]);
    const evidence = await db.execute<{ changes: { userId: unknown[]; roleId: unknown[] } }>(sql`select changes from audit_log
      where org_id = ${f.orgId} and table_name = 'role_assignments' order by at, id`);
    assert.equal(evidence.rows.length, 2);
    assert.ok(evidence.rows.every((row) => row.changes.userId.includes(f.targetId) && row.changes.roleId.includes(f.extraRole)));
    assert.equal((await call({ action: "assign", userId: [f.targetId], roleId: f.extraRole })).status, 400);
    assert.equal((await call({ action: "assign", userId: f.targetId, roleId: [f.extraRole] })).status, 400);
  } finally { state.authz = null; await dropScratchOrg(f.orgId); }
});

for (const change of ["widen", "delete"] as const) {
  test(`role assignment rechecks a concurrently ${change === "widen" ? "widened" : "deleted"} role`, { skip }, async () => {
    const f = await seed();
    const writer = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await writer.query("begin");
      await writer.query("select set_config('app.bypass_rls', 'on', true)");
      if (change === "widen") await writer.query(`update app_roles set permissions = '["gl.post"]'::jsonb where id = $1`, [f.extraRole]);
      else await writer.query("delete from app_roles where id = $1", [f.extraRole]);
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      pending = call({ action: "assign", userId: f.targetId, roleId: f.extraRole });
      await waitForBlocked(pid);
      await writer.query("commit");
      assert.equal((await pending).status, change === "widen" ? 403 : 404);
      assert.deepEqual(await assignments(f), [f.firstRole]);
      if (change === "widen") {
        state.authz!.permissions.add("gl.post");
        assert.equal((await call({ action: "assign", userId: f.targetId, roleId: f.extraRole })).status, 200);
        assert.ok((await assignments(f)).includes(f.extraRole));
      }
    } finally {
      await writer.query("rollback"); writer.release(); await pending?.catch(() => undefined);
      state.authz = null; await dropScratchOrg(f.orgId);
    }
  });
}

for (const repeatableRead of [false, true]) {
test(`concurrent role deletion and unassignment preserve the last role (${repeatableRead ? "repeatable read" : "read committed"})`, { skip }, async () => {
  const f = await seed();
  const writer = await pool.connect();
  const trigger = `zz_last_role_${randomUUID().replaceAll("-", "")}`;
  const pending: Promise<Response>[] = [];
  let installed = false;
  try {
    await db.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${f.orgId}, ${f.targetId}, ${f.extraRole})`);
    // Pause commits after the existing deferred guard has run. The old paths
    // both passed that guard against mutually stale assignment snapshots.
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
      if OLD.org_id = '${f.orgId}'::uuid and OLD.user_id = '${f.targetId}'::uuid then
        perform pg_advisory_xact_lock(hashtextextended('${trigger}' || OLD.role_id::text, 0));
      end if; return NULL; end $$`));
    await db.execute(sql.raw(`create constraint trigger ${trigger} after delete on role_assignments
      deferrable initially deferred for each row execute function ${trigger}()`));
    installed = true;
    await writer.query("begin");
    await writer.query("select pg_advisory_xact_lock(hashtextextended($1, 0)), pg_advisory_xact_lock(hashtextextended($2, 0))", [trigger + f.firstRole, trigger + f.extraRole]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const run = async (work: () => Promise<Response>) => {
      if (!repeatableRead) return work();
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)", [f.orgId]);
        const result = await orgContext.run({ orgId: f.orgId, bypass: false, txDb: drizzle({ client }) }, async () => await work());
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally { client.release(); }
    };
    pending.push(run(() => DELETE(request("DELETE", { id: f.firstRole }))), run(() => call({ action: "unassign", userId: f.targetId, roleId: f.extraRole })));
    for (const operation of pending) void operation.catch(() => undefined);
    await waitForBlocked(pid, 2);
    await writer.query("commit");
    const results = await Promise.allSettled(pending);
    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.status === 200).length, 1);
    for (const result of results) {
      if (result.status === "fulfilled") assert.ok([200, 409].includes(result.value.status));
      else {
        assert.ok(repeatableRead, "read-committed refusal returns a conflict response");
        const error = result.reason as { code?: string; cause?: { code?: string } };
        assert.equal(error.cause?.code ?? error.code, "40001", "stale snapshots must fail with a serialization refusal");
      }
    }
    assert.equal((await assignments(f)).length, 1);
  } finally {
    await writer.query("rollback"); writer.release(); await Promise.allSettled(pending);
    if (installed) await db.execute(sql.raw(`drop trigger ${trigger} on role_assignments`));
    await db.execute(sql.raw(`drop function if exists ${trigger}()`));
    state.authz = null; await dropScratchOrg(f.orgId);
  }
});
}

for (const action of ["assign", "unassign", "set-active"] as const) {
  test(`${action} audit failure rolls back its evidence and preserves ambient caller work`, { skip }, async () => {
    const f = await seed();
    const trigger = `user_audit_${randomUUID().replaceAll("-", "")}`;
    let installed = false;
    try {
      if (action === "unassign") await db.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${f.orgId}, ${f.targetId}, ${f.extraRole})`);
      const snapshot = async () => ({
        users: (await db.execute(sql`select * from users where org_id = ${f.orgId} order by id`)).rows,
        assignments: (await db.execute(sql`select * from role_assignments where org_id = ${f.orgId} order by id`)).rows,
        sessions: (await db.execute(sql`select * from auth_sessions where user_id = ${f.targetId} order by id`)).rows,
        audit: (await db.execute(sql`select * from audit_log where org_id = ${f.orgId} order by id`)).rows,
      });
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
        if NEW.org_id = '${f.orgId}'::uuid and NEW.table_name in ('role_assignments', 'users') then
          raise exception 'user audit storage unavailable';
        end if; return NEW; end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before insert on audit_log for each row execute function ${trigger}()`));
      installed = true;
      const body = { action, userId: f.targetId, roleId: f.extraRole, isActive: false };
      await withOrgTransaction(f.orgId, async () => {
        await db.execute(sql`update app_roles set description = 'earlier caller work' where id = ${f.extraRole}`);
        const before = await snapshot();
        await assert.rejects(call(body));
        assert.deepEqual(await snapshot(), before);
      });
      assert.equal((await db.execute(sql`select description from app_roles where id = ${f.extraRole}`)).rows[0]!.description, "earlier caller work");
      await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`)); installed = false;
      assert.equal((await call(body)).status, 200);
      const evidence = await db.execute(sql`select action from audit_log where org_id = ${f.orgId}`);
      assert.equal(evidence.rows.length, 1, "successful retry has exactly one audit entry");
      if (action === "set-active") assert.equal((await db.execute(sql`select is_active from users where id = ${f.targetId}`)).rows[0]!.is_active, false);
      else assert.equal((await assignments(f)).includes(f.extraRole), action === "assign");
    } finally {
      if (installed) await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      state.authz = null; await dropScratchOrg(f.orgId);
    }
  });
}
