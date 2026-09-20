/**
 * 0188 — the governed amend path clears submitted HRM change requests.
 *
 * 0185 retains every submitted request as history and refuses DELETE. That
 * rule stands for production paths; this suite proves the ONE allowance
 * 0188 adds: under `openbooks.amend = on` (fixture teardown, sandbox wipe,
 * org purge) a submitted request can be removed, so an organisation that
 * holds one is not pinned forever. Both directions are asserted against a
 * live PostgreSQL: the refusal without the GUC, the deletion with it, and
 * the real fixture teardown of an org holding a committed submitted request.
 *
 * Self-skips without OPENBOOKS_DB_URL like every DB-backed suite.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Seed = { orgId: string; actorId: string; employmentId: string };

async function seed(): Promise<Seed> {
  const [{ db }, { createScratchOrg, createScratchUser }] = await Promise.all([
    import("../engine/src/platform/db.ts"),
    import("../engine/src/testing/fixtures.ts"),
  ]);
  const org = await createScratchOrg();
  assert.ok(org.customerId && org.subsidiaryId, "scratch org must seed a party and a subsidiary");
  const actorId = await createScratchUser(org.orgId, "HRM wipe actor", "hrm_wipe_actor");
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${org.orgId}, ${org.customerId}, ${org.subsidiaryId}, 1)`);
  return { orgId: org.orgId, actorId, employmentId };
}

/** Insert a draft and submit it against a real flow run; returns the request id. */
async function submittedRequest(run: { execute: (q: unknown) => Promise<unknown> }, s: Seed): Promise<string> {
  const id = randomUUID();
  await run.execute(sql`
    insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload,
       payload_digest, payload_schema_version, created_by)
    values (${id}, ${s.orgId}, ${s.employmentId}, 1, ${JSON.stringify({ kind: "transfer", level: 1 })}::jsonb,
      ${"0".repeat(64)}, 'v1', ${s.actorId})`);
  const flowId = randomUUID();
  await run.execute(sql`
    insert into flows (id, org_id, subject_kind, graph)
    values (${flowId}, ${s.orgId}, 'hrm_employment_change_request', '{}'::jsonb)`);
  const runId = randomUUID();
  await run.execute(sql`
    insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
    values (${runId}, ${s.orgId}, ${flowId}, 'hrm_employment_change_request', ${id}, 'on_submit')`);
  await run.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'wipe allowance proof',
           submitted_by = ${s.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${id}`);
  return id;
}

test("a submitted request refuses DELETE without the amend allowance and clears with it", { skip: !DB, timeout: 120_000 }, async (t) => {
  const { db } = await import("../engine/src/platform/db.ts");
  const { dropScratchOrgReporting } = await import("../engine/src/testing/fixtures.ts");
  const s = await seed();
  t.after(async () => {
    await dropScratchOrgReporting(s.orgId);
  });
  class Rollback extends Error {}
  await assert.rejects(
    db.transaction(async (tx) => {
      const id = await submittedRequest(tx, s);
      // Production shape: no GUC, the retention rule fires.
      await tx.execute(sql`savepoint no_guc`);
      await assert.rejects(
        tx.execute(sql`delete from hrm_employment_change_requests where id = ${id}`),
        (error: unknown) => /retained as history/.test(String(error) + String((error as { cause?: unknown }).cause ?? "")),
        "submitted request must refuse DELETE without the amend allowance",
      );
      await tx.execute(sql`rollback to savepoint no_guc`);
      await tx.execute(sql`release savepoint no_guc`);
      const still = (await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_employment_change_requests where id = ${id}`)).rows[0]!.n;
      assert.equal(still, 1, "the refused DELETE removed nothing");
      // Governed amend path: the same statement clears exactly one row.
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`);
      const deleted = (await tx.execute<{ id: string }>(sql`
        delete from hrm_employment_change_requests where id = ${id} returning id`)).rows;
      assert.equal(deleted.length, 1, "amend allowance must delete exactly the submitted row");
      const gone = (await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_employment_change_requests where id = ${id}`)).rows[0]!.n;
      assert.equal(gone, 0);
      throw new Rollback();
    }),
    (error: unknown) => error instanceof Rollback,
  );
});

test("fixture teardown clears an organisation that holds a committed submitted request", { skip: !DB, timeout: 120_000 }, async () => {
  const { db } = await import("../engine/src/platform/db.ts");
  const { dropScratchOrgReporting } = await import("../engine/src/testing/fixtures.ts");
  const s = await seed();
  // Committed on purpose: this is the state that pinned scratch orgs before 0188.
  const id = await submittedRequest(db, s);
  const before = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_employment_change_requests where org_id = ${s.orgId}`)).rows[0]!.n;
  assert.equal(before, 1);
  await dropScratchOrgReporting(s.orgId);
  // Under the pooled lifecycle the org row is a reusable slot that is reset and
  // released, so the proof is that the org's HRM rows are gone — the exact
  // state that pinned scratch orgs before 0188 — not that the org row vanished.
  const after = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_employment_change_requests where org_id = ${s.orgId} or id = ${id}`)).rows[0]!.n;
  assert.equal(after, 0, "teardown must remove the submitted request with the rest of the org");
  const runs = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_runs where org_id = ${s.orgId}`)).rows[0]!.n;
  assert.equal(runs, 0, "the bound flow run is gone with it");
  const employments = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from worker_employments where org_id = ${s.orgId}`)).rows[0]!.n;
  assert.equal(employments, 0, "the 0184 rows are gone with it");
});
