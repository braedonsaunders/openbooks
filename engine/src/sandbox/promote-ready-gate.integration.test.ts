import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, longPool } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { sandboxRefreshLockKey } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

// D5: promotion capture must refuse a sandbox that is anything but ready,
// and must hold the same-sandbox lock refresh uses. Without the gate, a
// failed/provisioning sandbox (missing customization rows) captures a
// reviewable change set proposing mass production deletions — every
// production customization without a sandbox counterpart reads as a DELETE.
// Without the lock, a refresh can wipe rows under the diff or commit a new
// clone under it. No skip guard: a DB-owned test that self-skips turns CI
// red, so these fail loud without a database instead of skipping silently.

async function runTeardowns(...steps: Array<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "test teardown failed");
}

interface SandboxPair { prodOrgId: string; sbxOrgId: string; sandboxId: string; prodScriptId: string }

/** Hand-rolled sandbox pair with one production-only customization. */
async function seedPair(status: string): Promise<SandboxPair> {
  const prod = await createScratchOrg();
  const sbxOrgId = randomUUID();
  const seed = randomUUID();
  const sandboxId = randomUUID();
  await db.execute(sql`
    insert into orgs (id, name, base_currency, country, settings, env_kind, sandbox_of, sandbox_seed)
    values (${sbxOrgId}, ${"Scratch " + sbxOrgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb,
            'sandbox', ${prod.orgId}, ${seed})`);
  await db.execute(sql`
    insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
    values (${sandboxId}, ${sbxOrgId}, ${prod.orgId}, 'Promotion Gate Regression', 'full', false, ${status})`);
  // A production customization with no sandbox counterpart: under the bug
  // this single row captures as a reviewable DELETE of production config.
  const prodScriptId = randomUUID();
  await db.execute(sql`
    insert into user_scripts (org_id, id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
    values (${prod.orgId}, ${prodScriptId}, 'Ledger Guard', 'after_post', 'journal_entry',
            'function main(ctx) { return true }', 2000, 100, true)`);
  return { prodOrgId: prod.orgId, sbxOrgId, sandboxId, prodScriptId };
}

async function changeSetCount(): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from change_sets`);
  return r.rows[0]!.n;
}

for (const status of ["failed", "refreshing", "provisioning", "deleting"]) {
  test(`capture refuses a ${status} sandbox instead of proposing mass deletions`, async () => {
    const pair = await seedPair(status);
    try {
      const before = await changeSetCount();
      await assert.rejects(
        () => buildChangeSet(pair.sandboxId, "Gate Regression", null),
        /not ready/,
      );
      // Zero rows is a failure: the refused capture must leave no draft
      // behind for anyone to review or apply.
      assert.equal(await changeSetCount(), before);
    } finally {
      await runTeardowns(
        () => dropScratchOrgReporting(pair.sbxOrgId),
        () => dropScratchOrgReporting(pair.prodOrgId),
      );
    }
  });
}

test("capture holds the refresh lock: a concurrent refresh waits, then the capture lands whole", async () => {
  const pair = await seedPair("ready");
  const holder = await longPool.connect();
  try {
    // A refresh in progress holds this advisory lock; capture must block on
    // it rather than diffing rows the refresh is about to wipe.
    await holder.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      sandboxRefreshLockKey(pair.sandboxId),
    ]);
    const before = await changeSetCount();
    const pending = buildChangeSet(pair.sandboxId, "Gate Lock Regression", null);
    // The capture is issued but cannot proceed while the lock is held: give
    // it ample time to prove it blocks instead of finishing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await changeSetCount(), before, "capture must not finish while a refresh holds the lock");
    await holder.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
      sandboxRefreshLockKey(pair.sandboxId),
    ]);
    const { changeSetId, itemCount } = await pending;
    assert.equal(itemCount, 1);
    const items = (await db.execute<{ table_name: string; op: string; target_id: string }>(sql`
      select table_name, op, target_id::text as target_id from change_set_items where change_set_id = ${changeSetId}`));
    assert.deepEqual(items.rows, [
      { table_name: "user_scripts", op: "delete", target_id: pair.prodScriptId },
    ]);
  } finally {
    try {
      await holder.query("select pg_advisory_unlock_all()");
    } catch {
      // The connection may already be released on failure paths.
    }
    holder.release();
    await runTeardowns(
      () => dropScratchOrgReporting(pair.sbxOrgId),
      () => dropScratchOrgReporting(pair.prodOrgId),
    );
  }
});

test("apply refuses while the sandbox is mid-refresh", async () => {
  const pair = await seedPair("ready");
  try {
    const { changeSetId } = await buildChangeSet(pair.sandboxId, "Gate Apply Regression", null);
    // Review + approve need distinct production actors holding sandbox
    // authority; the apply gate is what this regression proves.
    const reviewer = await createScratchUser(pair.prodOrgId, "Gate Reviewer", "admin");
    const approver = await createScratchUser(pair.prodOrgId, "Gate Approver", "admin");
    const applier = await createScratchUser(pair.prodOrgId, "Gate Applier", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${pair.prodOrgId} and key='admin'`);
    await reviewChangeSet(changeSetId, reviewer);
    await approveChangeSet(changeSetId, approver);
    await db.execute(sql`update sandboxes set status = 'refreshing' where id = ${pair.sandboxId}`);
    await assert.rejects(() => applyChangeSet(changeSetId, applier), /not ready/);
    const status = (await db.execute<{ status: string }>(sql`
      select status from change_sets where id = ${changeSetId}`)).rows[0]!.status;
    assert.equal(status, "approved", "the refused apply must leave the approval intact");
  } finally {
    await runTeardowns(
      () => dropScratchOrgReporting(pair.sbxOrgId),
      () => dropScratchOrgReporting(pair.prodOrgId),
    );
  }
});
