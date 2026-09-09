import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

async function fixture(run: (f: { orgId: string; sandboxOrgId: string; sandboxId: string; approve: () => Promise<string>; applier: string }) => Promise<void>) {
  const org = await createScratchOrg();
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    const actors: string[] = [];
    for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings='{"features":{"scripts":true}}'::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into user_scripts(org_id,name,trigger_point,source,cron,next_run_at,last_run_at,is_active)
      values(${org.orgId},'Scheduled configuration','scheduled','function main(ctx) {}','0 12 * * *','2030-01-01T12:00:00Z','2026-01-01T12:00:00Z',true)`);
    sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Script runtime isolation", tier: "full", masked: false });
    const sandboxId = sandbox.sandboxId;
    await run({ orgId: org.orgId, sandboxOrgId: sandbox.sandboxOrgId, sandboxId, applier: actors[3]!, approve: async () => {
      const { changeSetId } = await buildChangeSet(sandboxId, "Script configuration", actors[0]);
      await reviewChangeSet(changeSetId, actors[1]);
      await approveChangeSet(changeSetId, actors[2]);
      return changeSetId;
    } });
  } finally {
    if (sandbox) await deleteSandbox(sandbox.sandboxId);
    await dropScratchOrgReporting(org.orgId);
  }
}

test("sandbox script execution alone produces no configuration promotion", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set last_run_at='2026-02-01T12:00:00Z',next_run_at='2031-01-01T12:00:00Z' where org_id=${f.sandboxOrgId}`);
    const change = await buildChangeSet(f.sandboxId, "Runtime only");
    assert.equal(change.itemCount, 0);
  });
});

test("script configuration promotion preserves live production execution timestamps", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set name='Promoted',last_run_at='2026-02-01T12:00:00Z',next_run_at='2031-01-01T12:00:00Z' where org_id=${f.sandboxOrgId}`);
    const id = await f.approve();
    await applyChangeSet(id, f.applier);
    const row = (await db.execute(sql`select name,last_run_at::text,next_run_at::text from user_scripts where org_id=${f.orgId}`)).rows[0]!;
    assert.equal(row.name, "Promoted");
    assert.match(String(row.last_run_at), /^2026-01-01 /);
    assert.match(String(row.next_run_at), /^2030-01-01 /);
  });
});

test("production execution after capture does not invalidate a script configuration promotion", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set name='Promoted' where org_id=${f.sandboxOrgId}`);
    const id = await f.approve();
    await db.execute(sql`update user_scripts set last_run_at='2026-03-01T12:00:00Z',next_run_at='2032-01-01T12:00:00Z' where org_id=${f.orgId}`);
    await applyChangeSet(id, f.applier);
    const row = (await db.execute(sql`select name,last_run_at::text,next_run_at::text from user_scripts where org_id=${f.orgId}`)).rows[0]!;
    assert.equal(row.name, "Promoted");
    assert.match(String(row.last_run_at), /^2026-03-01 /);
    assert.match(String(row.next_run_at), /^2032-01-01 /);
  });
});

test("a promoted cron change derives a fresh production schedule instead of copying a sandbox cursor", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set cron='0 13 * * *',next_run_at=null where org_id=${f.sandboxOrgId}`);
    const id = await f.approve();
    const from = Date.now();
    await applyChangeSet(id, f.applier);
    const row = (await db.execute(sql`select cron,next_run_at from user_scripts where org_id=${f.orgId}`)).rows[0]!;
    assert.equal(row.cron, "0 13 * * *");
    assert.ok(row.next_run_at, "active schedule must have a due cursor");
    const next = new Date(String(row.next_run_at));
    assert.ok(next.getTime() > from && next.getTime() <= Date.now() + 86_400_000);
    assert.equal(next.getUTCHours(), 13);
  });
});

test("promoting a new scheduled script starts a production cursor without sandbox execution evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`insert into user_scripts(org_id,name,trigger_point,source,cron,next_run_at,last_run_at,is_active)
      values(${f.sandboxOrgId},'New scheduled script','scheduled','function main(ctx) {}','0 14 * * *',null,'2026-02-01T12:00:00Z',true)`);
    const id = await f.approve();
    const from = Date.now();
    await applyChangeSet(id, f.applier);
    const row = (await db.execute(sql`select next_run_at,last_run_at from user_scripts where org_id=${f.orgId} and name='New scheduled script'`)).rows[0]!;
    assert.equal(row.last_run_at, null);
    assert.ok(row.next_run_at);
    const next = new Date(String(row.next_run_at));
    assert.ok(next.getTime() > from && next.getTime() <= Date.now() + 86_400_000);
    assert.equal(next.getUTCHours(), 14);
  });
});

for (const transition of ["disable", "event"] as const) {
  test(`promotion clears the scheduled cursor on ${transition} while preserving execution evidence`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    await fixture(async f => {
      if (transition === "disable") await db.execute(sql`update user_scripts set is_active=false where org_id=${f.sandboxOrgId}`);
      else await db.execute(sql`update user_scripts set trigger_point='before_submit',cron=null where org_id=${f.sandboxOrgId}`);
      const id = await f.approve();
      await applyChangeSet(id, f.applier);
      const row = (await db.execute(sql`select next_run_at,last_run_at::text from user_scripts where org_id=${f.orgId}`)).rows[0]!;
      assert.equal(row.next_run_at, null);
      assert.match(String(row.last_run_at), /^2026-01-01 /);
    });
  });
}

test("script execution isolation does not bypass production configuration conflicts", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set name='Promoted' where org_id=${f.sandboxOrgId}`);
    const id = await f.approve();
    await db.execute(sql`update user_scripts set source='function main(ctx) { return 42; }' where org_id=${f.orgId}`);
    await assert.rejects(applyChangeSet(id, f.applier), /changed since capture/);
    const row = (await db.execute(sql`select source,name from user_scripts where org_id=${f.orgId}`)).rows[0]!;
    assert.equal(row.source, "function main(ctx) { return 42; }");
    assert.equal(row.name, "Scheduled configuration");
  });
});

test("promotion refuses invalid scheduled policy without applying configuration or audit rows", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await fixture(async f => {
    await db.execute(sql`update user_scripts set cron='not a cron',name='Invalid' where org_id=${f.sandboxOrgId}`);
    const id = await f.approve();
    await assert.rejects(applyChangeSet(id, f.applier), /cron/i);
    const row = (await db.execute(sql`select cron,name from user_scripts where org_id=${f.orgId}`)).rows[0]!;
    assert.equal(row.cron, "0 12 * * *");
    assert.equal(row.name, "Scheduled configuration");
    assert.equal((await db.execute(sql`select status from change_sets where id=${id}`)).rows[0]!.status, "approved");
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${f.orgId} and changes->>'changeSetId'=${id}`)).rows.length, 0);
  });
});

for (const [label, updates, error] of [
  ["trigger", { trigger_point: "record_after_submit" }, /invalid trigger/],
  ["source", { source: "return 1" }, /function main/],
  ["negative timeout", { timeout_ms: -1 }, /timeoutMs/],
  ["oversized timeout", { timeout_ms: 10001 }, /timeoutMs/],
  ["endpoint slug", { trigger_point: "endpoint", endpoint_slug: "Invalid Slug" }, /endpoint slug/],
] as Array<[string, Record<string, unknown>, RegExp]>) {
  test(`promotion refuses invalid script ${label}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    await fixture(async f => {
      await db.execute(sql`update user_scripts set ${sql.join(Object.entries(updates).map(([key,value]) => sql`${sql.identifier(key)}=${value}`),sql`, `)} where org_id=${f.sandboxOrgId}`);
      const id = await f.approve();
      await assert.rejects(applyChangeSet(id, f.applier), error);
      assert.equal((await db.execute(sql`select status from change_sets where id=${id}`)).rows[0]!.status, "approved");
      assert.equal((await db.execute(sql`select id from audit_log where org_id=${f.orgId} and changes->>'changeSetId'=${id}`)).rows.length, 0);
    });
  });
}
