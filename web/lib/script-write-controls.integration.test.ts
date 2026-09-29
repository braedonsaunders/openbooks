import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { SessionUser } from "./auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __scriptWriteSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptWriteSession.user}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
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

const scriptLifecycleCases = [{ label: "script lifecycle cursor", register: () => {
  const root = pathToFileURL(process.cwd() + '/').href;
  const control: { afterRun: (() => Promise<void>) | null } = { afterRun: null };
  Object.assign(globalThis, { __scriptLifecycleRun: control });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@openbooks/engine/src/scripting/scripting.ts' && decodeURIComponent(context.parentURL ?? '').endsWith('/scripts/[id]/run/route.ts')) {
      const actual = JSON.stringify(root + 'engine/src/scripting/scripting.ts');
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${actual};import {runScheduledScript as run} from ${actual};export async function runScheduledScript(...args){const result=await run(...args);await globalThis.__scriptLifecycleRun.afterRun?.();return result}`) };
    }
    return next(specifier, context);
  }});
  const runRouteReady = import('../app/api/admin/scripts/[id]/run/route').then(
    ({ POST }) => { hooks.deregister(); return POST; },
    (error: unknown) => { hooks.deregister(); throw error; },
  );
  async function fixture(run: (orgId: string, id: string, actor: string) => Promise<void>) {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, 'Script administrator', 'admin');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"scripts":true}'::jsonb) where id=${org.orgId}`);
      session.user = { id: actor, orgId: org.orgId, name: 'Script administrator', email: 'script@scratch.test', roles: [], isSuperAdmin: false,
        envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const id = (await db.execute<{ id: string }>(sql`insert into user_scripts(org_id,name,trigger_point,source,cron,next_run_at,is_active)
        values(${org.orgId},'Scheduled','scheduled','function main(ctx) { return 42; }','0 12 * * *','2030-01-01 12:00:00.123456+00',true) returning id`)).rows[0]!.id;
      await run(org.orgId, id, actor);
    } finally { session.user = null; control.afterRun = null; await dropScratchOrgReporting(org.orgId); }
  }
  const cursor = async (orgId: string, id: string) => (await db.execute<{ value: string | null }>(sql`select next_run_at::text as value from user_scripts where org_id=${orgId} and id=${id}`)).rows[0]!.value;
  const patch = (orgId: string, id: string, body: Record<string, unknown>) => withOrgContext(orgId, () => PATCH(new Request('http://audit.local/api/admin/scripts', {
    method: 'PATCH', body: JSON.stringify({ id, name: 'Edited', triggerPoint: 'scheduled', source: 'function main(ctx) { return 1; }', cron: '0 12 * * *', isActive: true, ...body }),
  })));
  const runNow = (orgId: string, id: string) => withOrgContext(orgId, async () => (await runRouteReady)(new Request(`http://audit.local/api/admin/scripts/${id}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  }), { params: Promise.resolve({ id }) }));
  const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
  test('ordinary script edits retain the live locked cursor and its microseconds', enabled, async () => fixture(async (orgId, id) => {
    const blocker = await pool.connect(); let pending: Promise<Response> | undefined;
    try {
      await blocker.query('begin'); await blocker.query("select set_config('app.current_org',$1,true)", [orgId]);
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await blocker.query("update user_scripts set next_run_at='2031-01-01 12:00:00.654321+00' where org_id=$1 and id=$2", [orgId, id]);
      pending = patch(orgId, id, { timeoutMs: 3000, sortOrder: 42 });
      let waiting = false; for (let i = 0; i < 200; i++) { waiting = (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as waiting`)).rows[0]!.waiting; if (waiting) break; await delay(10); }
      assert.ok(waiting); await blocker.query('commit'); assert.equal((await pending).status, 200); assert.match((await cursor(orgId, id))!, /^2031-01-01 .*\.654321/);
    } finally { await blocker.query('rollback'); blocker.release(); await pending?.catch(() => undefined); }
  }));
  for (const transition of ['cron', 'disable', 'event', 'activate'] as const) test(`script PATCH applies the ${transition} scheduling transition`, enabled, async () => fixture(async (orgId, id) => {
    if (transition === 'activate') await db.execute(sql`update user_scripts set is_active=false,next_run_at=null where org_id=${orgId} and id=${id}`);
    const from = Date.now(); const body = transition === 'cron' ? { cron: '0 13 * * *' } : transition === 'disable' ? { isActive: false } : transition === 'event' ? { triggerPoint: 'before_submit', cron: null } : {};
    assert.equal((await patch(orgId, id, body)).status, 200); const next = await cursor(orgId, id);
    if (transition === 'disable' || transition === 'event') assert.equal(next, null);
    else { assert.ok(next); const date = new Date(next); assert.ok(date.getTime() > from && date.getTime() <= Date.now() + 86_400_000); assert.equal(date.getUTCHours(), transition === 'cron' ? 13 : 12); }
  }));
  for (const active of [true, false]) test(`script DELETE preserves ${active ? 'active' : 'inactive'} execution history with a conflict`, enabled, async () => fixture(async (orgId, id, actor) => {
    await db.execute(sql`update user_scripts set is_active=${active},next_run_at=case when ${active} then next_run_at else null end where org_id=${orgId} and id=${id}`);
    await db.execute(sql`insert into script_runs(org_id,script_id,status,created_by) values(${orgId},${id},'ok',${actor})`);
    const response = await withOrgContext(orgId, () => DELETE(new Request(`http://audit.local/api/admin/scripts/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) }));
    assert.equal(response.status, 409); assert.match((await response.json()).error, /Deactivate.*preserve/i);
    assert.equal((await db.execute(sql`select id from script_runs where org_id=${orgId} and script_id=${id}`)).rows.length, 1);
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${orgId} and table_name='user_scripts'`)).rows.length, 0);
    assert.equal((await patch(orgId, id, { isActive: false })).status, 200); assert.equal(await cursor(orgId, id), null);
  }));
  for (const [trigger, active, status] of [['scheduled', false, 409], ['bulk', false, 409], ['before_submit', true, 422], ['endpoint', true, 422], ['client', true, 422]] as const)
    test(`Run now refuses ${active ? 'active' : 'inactive'} ${trigger} before execution`, enabled, async () => fixture(async (orgId, id) => {
      await db.execute(sql`update user_scripts set trigger_point=${trigger},is_active=${active} where org_id=${orgId} and id=${id}`);
      const before = await cursor(orgId, id); assert.equal((await runNow(orgId, id)).status, status); assert.equal(await cursor(orgId, id), before);
      assert.equal((await db.execute(sql`select id from script_runs where org_id=${orgId} and script_id=${id}`)).rows.length, 0);
    }));
  test('Run now advances an unchanged microsecond cursor and records the actor', enabled, async () => fixture(async (orgId, id, actor) => {
    const from = Date.now(), response = await runNow(orgId, id); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ok');
    const next = new Date((await cursor(orgId, id))!).getTime(); assert.ok(next > from && next <= Date.now() + 86_400_000);
    assert.deepEqual((await db.execute(sql`select created_by,status from script_runs where org_id=${orgId} and script_id=${id}`)).rows, [{ created_by: actor, status: 'ok' }]);
  }));
  for (const change of ['cron', 'deactivate', 'trigger', 'tick'] as const) test(`Run now cannot overwrite a concurrent ${change} scheduling change`, enabled, async () => fixture(async (orgId, id) => {
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    control.afterRun = async () => { reached.resolve(); await release.promise; }; const pending = runNow(orgId, id);
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error('runner gate was not reached'); })]);
      if (change === 'cron') await db.execute(sql`update user_scripts set cron='0 13 * * *' where org_id=${orgId} and id=${id}`);
      if (change === 'deactivate') await db.execute(sql`update user_scripts set is_active=false where org_id=${orgId} and id=${id}`);
      if (change === 'trigger') await db.execute(sql`update user_scripts set trigger_point='before_submit' where org_id=${orgId} and id=${id}`);
      if (change === 'tick') await db.execute(sql`update user_scripts set next_run_at='2030-01-01 12:00:00.123457+00' where org_id=${orgId} and id=${id}`);
      const expected = await cursor(orgId, id); release.resolve(); assert.equal((await pending).status, 200); assert.equal(await cursor(orgId, id), expected);
    } finally { release.resolve(); await pending; control.afterRun = null; }
  }));
}}] as const;
for (const row of scriptLifecycleCases) row.register();

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
      const payload = { id: original.id, name: "Changed", triggerPoint: "before_submit", source: "function main(ctx) {}" };
      const request = new Request("http://audit.local/api/admin/scripts", { method,
        body: JSON.stringify(payload),
      });
      // The route parses through the shared JSON boundary, which streams
      // request.body directly and never calls request.json() — so the
      // mid-parse revocation rides the stream's first read, still after the
      // route's initial API guard. The bytes are re-encoded from the same
      // payload; the original stream is never consumed.
      //
      // highWaterMark 0 is load-bearing: a default stream fires pull
      // spontaneously on construction, so the revocation would commit before
      // the initial guard runs and the test would pin the entry refusal
      // instead of the in-transaction recheck. With a zero watermark pull
      // fires only on the parse read, and the read awaits it — so the
      // revocation always lands between the entry guard and the locked
      // recheck.
      const rawBytes = new TextEncoder().encode(JSON.stringify(payload));
      let armed = true;
      Object.defineProperty(request, "body", {
        configurable: true,
        value: new ReadableStream(
          {
            async pull(controller) {
              if (armed) {
                armed = false;
                await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,scripts}','false') where id=${org.orgId}`);
              }
              controller.enqueue(rawBytes);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      });
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
