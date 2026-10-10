import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass, withMaintenanceTransaction, withOrgTransaction } from "../platform/db.ts";
import { assertFixtureDatabase, createScratchUser } from "../testing/fixtures.ts";
import { deliverFlowEmail, processDueSchedulerOutbox } from "../scheduling/outbox.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { admitSampleRetirement, executeSampleRetirement } from "./retirement.ts";
import type { RetirementDatabaseIdentity } from "./retirement-contract.ts";

/** Run native claims and settlement with an in-memory queue boundary. No mail
 * provider, Redis producer or attachment storage is reached by these fixtures. */
export async function drainSampleFixtureFlowEmails(orgId: string): Promise<number> {
  await assertFixtureDatabase();
  return withOrgTransaction(orgId, async () => {
    const posture = (await db.execute<{ restricted: boolean }>(sql`
      select not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=session_user`)).rows[0];
    assert.equal(posture?.restricted, true, "fixture outbox processing requires the restricted tenant connection");
    const pending = (await db.execute<{ id: string; kind: string; status: string; due: boolean; payload: { attachments?: unknown[] } }>(sql`
      select id,kind,status,next_attempt_at<=now()+interval '1 second' as due,payload from scheduler_outbox
      where org_id=${orgId} and (status in ('pending','running') or (status='failed' and terminal_failed_at is null))
      order by id`)).rows;
    assert.ok(pending.length <= 200, "the bounded fixture drain never silently leaves overflow work");
    for (const row of pending) {
      assert.equal(row.kind, "flow_email", "unrelated scheduler jobs need their own native lifecycle");
      assert.equal(row.status, "pending", "do not recover another worker's claimed fixture delivery");
      assert.equal(row.due, true);
      assert.equal(row.payload.attachments?.length ?? 0, 0, "fixture email must not stage external attachments");
    }
    if (!pending.length) return 0;
    const expected = new Set(pending.map(row => row.id));
    const accepted: string[] = [];
    const outcome = await processDueSchedulerOutbox(new Date(Date.now() + 1_000), 200, async row => {
      assert.equal(row.org_id, orgId);
      assert.equal(row.kind, "flow_email");
      assert.ok(expected.has(row.id), "the scoped worker must claim only this fixture's reviewed rows");
      await deliverFlowEmail(row, async (data, options) => {
        assert.equal(data.orgId, orgId);
        assert.equal(options.jobId, `flow-email|${row.id}`);
        accepted.push(row.id);
      });
    });
    assert.deepEqual(outcome, { processed: pending.length, succeeded: pending.length, failed: 0, fenced: 0 });
    assert.deepEqual(accepted.sort(), [...expected].sort());
    const settled = (await db.execute<{ id: string; status: string; attempts: number }>(sql`
      select id,status,attempt_count as attempts from scheduler_outbox
      where org_id=${orgId} and id=any(${sql.param([...expected])}::uuid[]) order by id`)).rows;
    assert.deepEqual(settled, [...expected].sort().map(id => ({ id, status: "succeeded", attempts: 1 })), "native settlement retains the completed delivery evidence");
    return accepted.length;
  });
}

/** Return false only when the native lifecycle is absent. Callers retain their
 * legacy fixture path in that case; installed retirement never falls back. */
export async function retireSampleFixtureCompanies(homeOrgId: string, exactOrgIds: readonly string[]): Promise<boolean> {
  await assertFixtureDatabase();
  const installed = await withMaintenanceTransaction(null, async () => (await db.execute<{ installed: boolean }>(sql`
    select to_regprocedure('tenant_retirement.openbooks_retirement_register(uuid,text,text,jsonb,uuid[],uuid[],uuid,text,jsonb,jsonb)') is not null as installed`)).rows[0]!.installed);
  if (!installed) return false;
  const selection = [...new Set(exactOrgIds)];
  assert.ok(!selection.includes(homeOrgId), "the recovery actor's home company must be retained");
  const state = await withMaintenanceTransaction(null, async () => ({
    database: (await db.execute<RetirementDatabaseIdentity & Record<string, unknown>>(sql`select current_database() as database,inet_server_addr()::text as "serverAddress",
      inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"`)).rows[0]!,
    live: (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map(row => row.id),
  }));
  const retireOrgIds = selection.filter(id => state.live.includes(id));
  if (!retireOrgIds.length) return true;
  for (const orgId of retireOrgIds) await drainSampleFixtureFlowEmails(orgId);
  const actorId = await withBypass(() => createScratchUser(homeOrgId, "Sample fixture recovery administrator", "admin"));
  const plan = await sampleRetirementPlan({ version: 1, database: state.database, retainOrgIds: state.live.filter(id => !retireOrgIds.includes(id)),
    retireOrgIds, reason: "Retire the exact sample fixtures after native preservation verification" });
  assert.deepEqual(plan.blockers, []);
  // Synthetic disposable-fixture attestations are not operational backup proof.
  const fixtureHash = createHash("sha256").update("Sample fixture recovery contract").digest("hex");
  const runId = randomUUID();
  await admitSampleRetirement({ plan, runId, actorId, recovery: { backupSha256: fixtureHash, restoreReceiptSha256: fixtureHash,
    preservationReceiptSha256: fixtureHash, objectRetentionReceiptSha256: fixtureHash, verifiedAt: new Date().toISOString(), verifier: "Disposable sample fixture" } });
  for (const orgId of retireOrgIds) await executeSampleRetirement({ runId, orgId, planDigest: plan.digest });
  return true;
}
