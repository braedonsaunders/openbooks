import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __scriptWriteSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptWriteSession.user}" };
  }
  if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST, PATCH } = await import("../app/api/admin/scripts/route");
const { DELETE } = await import("../app/api/admin/scripts/[id]/route");

const malformed: Array<[string, Record<string, unknown>]> = [
  ["object name", { name: {} }],
  ["string activation", { isActive: "false" }],
  ["negative timeout", { timeoutMs: -10 }],
  ["fractional timeout", { timeoutMs: 1.5 }],
  ["object record kind", { documentKind: {} }],
  ["object sort order", { sortOrder: {} }],
  ["null activation", { isActive: null }],
  ["oversized timeout", { timeoutMs: 10_001 }],
  ["oversized sort order", { sortOrder: 2_147_483_648 }],
  ["object source", { source: {} }],
  ["object cron", { cron: {} }],
  ["invalid cron", { triggerPoint: "scheduled", cron: "not cron" }],
  ["missing slug", { triggerPoint: "endpoint" }],
  ["invalid trigger", { triggerPoint: "record_after_submit" }],
];
for (const method of ["POST", "PATCH"] as const) {
  for (const [label, override] of [...malformed,
    ["valid inactive", { timeoutMs: 1, sortOrder: 0 }],
    ["valid active", { isActive: true, timeoutMs: 10000, sortOrder: -1 }],
    ["valid schedule", { triggerPoint: "scheduled", cron: "0 12 * * *", isActive: true }],
    ["valid endpoint", { triggerPoint: "endpoint", endpointSlug: "test-endpoint", isActive: true }],
    ["valid defaults", { isActive: undefined }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`script write ${method}: ${label}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Script administrator", "admin");
        await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
        session.user = { id: actor, orgId: org.orgId, name: "Script administrator", email: "script@scratch.test", roles: [], isSuperAdmin: false,
          envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        const original = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active)
          values(${org.orgId},'Original','before_submit','function main(ctx) {}',false) returning id`)).rows[0]!;
        const before = (await db.execute(sql`select * from user_scripts where org_id=${org.orgId} order by id`)).rows;
        const response = await withOrgContext(org.orgId, () => (method === "POST" ? POST : PATCH)(new Request("http://audit.local/api/admin/scripts", {
          method, body: JSON.stringify({ id: original.id, name: "Changed", triggerPoint: "before_submit", source: "function main(ctx) {}", isActive: false, ...override }),
        })));
        const valid = label.startsWith("valid ");
        assert.ok(valid ? response.status === 200 : [400, 422].includes(response.status), `unexpected ${response.status}: ${await response.text()}`);
        const after = (await db.execute(sql`select * from user_scripts where org_id=${org.orgId} order by id`)).rows;
        if (!valid) assert.deepEqual(after, before);
        else {
          const saved = after.find(row => row.name === "Changed")!;
          assert.ok(saved);
          assert.equal(saved.is_active, label !== "valid inactive");
          assert.equal(saved.timeout_ms, override.timeoutMs ?? 2000);
          assert.equal(saved.sort_order, override.sortOrder ?? 100);
          assert.equal(saved.next_run_at !== null, label === "valid schedule");
        }
        assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='user_scripts'`)).rows.length, valid ? 1 : 0);
      } finally {
        session.user = null;
        await dropScratchOrgReporting(org.orgId);
      }
    });
  }
}

for (const method of ["PATCH", "DELETE"] as const) {
  test(`script ${method} audit records the row immediately before its serialized write`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const blocker = await pool.connect();
    let request: Promise<Response> | undefined;
    try {
      const actor = await createScratchUser(org.orgId, "Script administrator", "admin");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
      session.user = { id: actor, orgId: org.orgId, name: "Script administrator", email: "script@scratch.test", roles: [], isSuperAdmin: false,
        envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const original = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active)
        values(${org.orgId},'Original','before_submit','function main(ctx) {}',false) returning id`)).rows[0]!;
      await blocker.query("begin");
      await blocker.query("select set_config('app.current_org',$1,true)", [org.orgId]);
      const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await blocker.query("update user_scripts set name='Intervening committed change' where org_id=$1 and id=$2", [org.orgId,original.id]);
      request = withOrgContext(org.orgId, () => method === "PATCH" ? PATCH(new Request("http://audit.local/api/admin/scripts", {
        method, body: JSON.stringify({ id: original.id, name: "Final change", triggerPoint: "before_submit", source: "function main(ctx) {}", isActive: false }),
      })) : DELETE(new Request("http://audit.local/api/admin/scripts/" + original.id, { method }), { params: Promise.resolve({ id: original.id }) }));
      // Observe the actual waiter before committing the competing write.
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        waiting = (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as waiting`)).rows[0]!.waiting;
        if (waiting) break;
        await delay(10);
      }
      assert.ok(waiting, "script mutation reached the competing row lock");
      await blocker.query("commit");
      assert.equal((await request).status, 200);
      const audit = (await db.execute<{ changes: { before: { name: string } } }>(sql`select changes from audit_log where org_id=${org.orgId} and table_name='user_scripts' and row_id=${original.id}`)).rows[0]!;
      assert.equal(audit.changes.before.name, "Intervening committed change");
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await request?.catch(() => undefined);
      session.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

for (const method of ["POST", "PATCH"] as const) {
  test(`script ${method} rechecks the feature after request parsing`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Script administrator", "admin");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
      session.user = { id: actor, orgId: org.orgId, name: "Script administrator", email: "script@scratch.test", roles: [], isSuperAdmin: false,
        envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const original = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active)
        values(${org.orgId},'Original','before_submit','function main(ctx) {}',false) returning id`)).rows[0]!;
      // A slow request body allows a feature revocation after the initial
      // API guard. The eventual database write must observe that revocation.
      const request = new Request("http://audit.local/api/admin/scripts", { method,
        body: JSON.stringify({ id: original.id, name: "Changed", triggerPoint: "before_submit", source: "function main(ctx) {}" }),
      });
      const json = request.json.bind(request);
      request.json = async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,scripts}','false') where id=${org.orgId}`);
        return json();
      };
      const response = await withOrgContext(org.orgId, () => (method === "POST" ? POST : PATCH)(request));
      assert.equal(response.status, 404);
      assert.deepEqual((await db.execute(sql`select name from user_scripts where org_id=${org.orgId}`)).rows, [{ name: "Original" }]);
      assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='user_scripts'`)).rows.length, 0);
    } finally {
      session.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

test("script DELETE rechecks the feature under its row lock", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const blocker = await pool.connect();
  let request: Promise<Response> | undefined;
  try {
    const actor = await createScratchUser(org.orgId, "Script administrator", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
    session.user = { id: actor, orgId: org.orgId, name: "Script administrator", email: "script@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const original = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active)
      values(${org.orgId},'Original','before_submit','function main(ctx) {}',false) returning id`)).rows[0]!;
    // Hold the org row so the delete's locked feature recheck waits behind us.
    await blocker.query("begin");
    await blocker.query("select set_config('app.current_org',$1,true)", [org.orgId]);
    await blocker.query("select 1 from orgs where id=$1 for update", [org.orgId]);
    const blockerPid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    request = withOrgContext(org.orgId, () => DELETE(new Request("http://audit.local/api/admin/scripts/" + original.id, { method: "DELETE" }),
      { params: Promise.resolve({ id: original.id }) }));
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))) as waiting`)).rows[0]!.waiting;
      if (waiting) break;
      await delay(10);
    }
    assert.ok(waiting, "script delete reached the locked feature recheck");
    // Revoke while the delete waits, then release: the in-transaction
    // recheck must observe the revocation and refuse the delete.
    await blocker.query("update orgs set settings=jsonb_set(settings,'{features,scripts}','false') where id=$1", [org.orgId]);
    await blocker.query("commit");
    assert.equal((await request).status, 404);
    assert.deepEqual((await db.execute(sql`select name from user_scripts where org_id=${org.orgId}`)).rows, [{ name: "Original" }]);
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='user_scripts'`)).rows.length, 0);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await request?.catch(() => undefined);
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
