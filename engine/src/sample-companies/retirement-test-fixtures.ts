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
    const posture = (
      await db.execute<{ restricted: boolean }>(
        sql`
      select not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=session_user`,
        "objects",
      )
    )[0];
    assert.equal(
      posture?.restricted,
      true,
      "fixture outbox processing requires the restricted tenant connection",
    );
    const pending = await db.execute<{
      id: string;
      kind: string;
      status: string;
      due: boolean;
      payload: { attachments?: unknown[] };
    }>(
      sql`
      select id,kind,status,next_attempt_at<=now()+interval '1 second' as due,payload from scheduler_outbox
      where org_id=${orgId} and (status in ('pending','running') or (status='failed' and terminal_failed_at is null))
      order by id`,
      "objects",
    );
    assert.ok(
      pending.length <= 200,
      "the bounded fixture drain never silently leaves overflow work",
    );
    for (const row of pending) {
      assert.equal(
        row.kind,
        "flow_email",
        "unrelated scheduler jobs need their own native lifecycle",
      );
      assert.equal(
        row.status,
        "pending",
        "do not recover another worker's claimed fixture delivery",
      );
      assert.equal(row.due, true);
      assert.equal(
        row.payload.attachments?.length ?? 0,
        0,
        "fixture email must not stage external attachments",
      );
    }
    if (!pending.length) return 0;
    const expected = new Set(pending.map((row) => row.id));
    const accepted: string[] = [];
    const outcome = await processDueSchedulerOutbox(
      new Date(Date.now() + 1_000),
      200,
      async (row) => {
        assert.equal(row.org_id, orgId);
        assert.equal(row.kind, "flow_email");
        assert.ok(
          expected.has(row.id),
          "the scoped worker must claim only this fixture's reviewed rows",
        );
        await deliverFlowEmail(row, async (data, options) => {
          assert.equal(data.orgId, orgId);
          assert.equal(options.jobId, `flow-email|${row.id}`);
          accepted.push(row.id);
        });
      },
    );
    assert.deepEqual(outcome, {
      processed: pending.length,
      succeeded: pending.length,
      failed: 0,
      fenced: 0,
    });
    assert.deepEqual(accepted.sort(), [...expected].sort());
    const settled = await db.execute<{ id: string; status: string; attempts: number }>(
      sql`
      select id,status,attempt_count as attempts from scheduler_outbox
      where org_id=${orgId} and id=any(${sql.param([...expected])}::uuid[]) order by id`,
      "objects",
    );
    assert.deepEqual(
      settled,
      [...expected].sort().map((id) => ({ id, status: "succeeded", attempts: 1 })),
      "native settlement retains the completed delivery evidence",
    );
    return accepted.length;
  });
}

/** Retire exact fixture companies through the same governed lifecycle as production. */
export async function retireSampleFixtureCompanies(
  homeOrgId: string,
  exactOrgIds: readonly string[],
): Promise<void> {
  await assertFixtureDatabase();
  const selection = [...new Set(exactOrgIds)];
  assert.ok(!selection.includes(homeOrgId), "the recovery actor's home company must be retained");
  const state = await withMaintenanceTransaction(null, async () => ({
    database: (
      await db.execute<RetirementDatabaseIdentity & Record<string, unknown>>(
        sql`select current_database() as database,inet_server_addr()::text as "serverAddress",
      inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"`,
        "objects",
      )
    )[0]!,
    live: (await db.execute<{ id: string }>(sql`select id from orgs order by id`, "objects")).map(
      (row) => row.id,
    ),
  }));
  const retireOrgIds = selection.filter((id) => state.live.includes(id));
  if (!retireOrgIds.length) return;
  for (const orgId of retireOrgIds) await drainSampleFixtureFlowEmails(orgId);
  // bypass: identity-bootstrap — the recovery administrator is created in the home organization before any tenant context exists.
  const actorId = await withBypass(() =>
    createScratchUser(homeOrgId, "Sample fixture recovery administrator", "admin"),
  );
  const plan = await sampleRetirementPlan({
    version: 1,
    database: state.database,
    retainOrgIds: state.live.filter((id) => !retireOrgIds.includes(id)),
    retireOrgIds,
    reason: "Retire the exact sample fixtures after native preservation verification",
  });
  assert.deepEqual(
    plan.blockers,
    [],
    JSON.stringify({
      guardDrift: plan.guardDrift,
      retainedDependencies: plan.retainedDependencies,
      retainedAccessDependencies: plan.retainedAccessDependencies,
    }),
  );
  // Synthetic disposable-fixture attestations are not operational backup proof.
  const fixtureHash = createHash("sha256").update("Sample fixture recovery contract").digest("hex");
  const runId = randomUUID();
  await admitSampleRetirement({
    plan,
    runId,
    actorId,
    recovery: {
      backupSha256: fixtureHash,
      restoreReceiptSha256: fixtureHash,
      preservationReceiptSha256: fixtureHash,
      objectRetentionReceiptSha256: fixtureHash,
      verifiedAt: new Date().toISOString(),
      verifier: "Disposable sample fixture",
    },
  });
  for (const orgId of retireOrgIds)
    await executeSampleRetirement({ runId, orgId, planDigest: plan.digest });
}
