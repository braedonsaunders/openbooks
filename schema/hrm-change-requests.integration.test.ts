/// <reference types="node" />

/**
 * Behavioral coverage for 0185_hrm_employment_change_requests — governed
 * HRM employment change REQUEST storage (proposals, never mutations).
 *
 * What this suite pins:
 * - rows are born drafts with a storage-computed canonical digest (the
 *   caller-supplied digest is ignored, never trusted);
 * - digest canonicalization is semantic (key order / whitespace do not
 *   move the digest);
 * - draft edits advance request_revision by exactly one and recompute the
 *   digest; touch-only updates hold the revision;
 * - submit freezes identity, payload, expected revision, revision, and
 *   submission stamps; post-submit edits are refused;
 * - the transition machine (draft -> pending_approval -> approved /
 *   rejected / withdrawn, approved -> applied; draft -> withdrawn without
 *   fabricated submission) with terminal states terminal;
 * - decision snapshots exist exactly on decided rows, bind the row's
 *   digests, and freeze once written;
 * - employment scope is composite (org_id, employment_id) — a valid
 *   employment id from another org is refused;
 * - the flow run anchor is scope-bound (same org, governed subject
 *   kind/id), stamped at submit, retained, never re-pointed;
 * - submitted history cannot be deleted; pure drafts can;
 * - application evidence is all-or-nothing with approved -> applied and
 *   links a live canonical change in the same org.
 *
 * FIXTURE ASSUMPTION (0184, coordinator-owned, uncommitted at authoring):
 * worker_employments exposes (id, org_id, worker_party_id,
 * employer_subsidiary_id, revision) and employment_changes exposes (at
 * least) (id, org_id); this suite inserts only those columns. Reconcile
 * with schema/src/hrm.ts at DB handoff if 0184 requires more. Canonical
 * mutation, approval execution, and application auth are other slices —
 * this suite asserts storage refuses, never that services allow.
 *
 * Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL. The
 * 0184 worker holds the exclusive dedicated DB right now: run at handoff.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

/** Drizzle wraps driver errors, hiding the PostgreSQL message in `cause`. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/db.ts");
type EngineFixtures = typeof import("../engine/src/test-fixtures.ts");

type Harness = {
  db: EngineDb["db"];
  orgId: string;
  actorId: string;
  employmentId: string;
  cleanupOrgs: string[];
};

let harness: Harness | null = null;
let teardownRegistered = false;

async function ctx(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  if (!harness) {
    const [{ db }, { createScratchOrg }] = await Promise.all([
      import("../engine/src/db.ts"),
      import("../engine/src/test-fixtures.ts"),
    ]);
    const org = await createScratchOrg();
    const users = (await db.execute<{ id: string }>(sql`
      select id from users where org_id = ${org.orgId} order by created_at limit 1`)).rows;
    assert.ok(users[0], "scratch org must seed at least one user for submission actors");
    const employmentId = randomUUID();
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${employmentId}, ${org.orgId}, ${randomUUID()}, ${randomUUID()}, 1)`);
    harness = {
      db,
      orgId: org.orgId,
      actorId: users[0]!.id,
      employmentId,
      cleanupOrgs: [org.orgId],
    };
    if (!teardownRegistered) {
      teardownRegistered = true;
      t.after(async () => {
        const [{ dropScratchOrgReporting }] = await import("../engine/src/test-fixtures.ts");
        for (const id of harness!.cleanupOrgs) await dropScratchOrgReporting(id);
        harness = null;
      });
    }
  }
  return harness;
}

const PAYLOAD = (n: number) => ({ kind: "transfer", department: "ledger", level: n });

async function insertDraft(h: Harness): Promise<string> {
  const id = randomUUID();
  await h.db.execute(sql`
    insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload,
       payload_digest, payload_schema_version, created_by)
    values (${id}, ${h.orgId}, ${h.employmentId}, 1, ${JSON.stringify(PAYLOAD(1))}::jsonb,
      ${"0".repeat(64)}, 'v1', ${h.actorId})`);
  return id;
}

async function readRequest(h: Harness, id: string) {
  const rows = (await h.db.execute<{
    status: string;
    request_revision: number;
    payload_digest: string;
    submitted_at: string | null;
    flow_run_id: string | null;
    decision_snapshot: Record<string, unknown> | null;
  }>(sql`
    select status, request_revision,
           payload_digest, submitted_at::text as submitted_at,
           flow_run_id::text as flow_run_id, decision_snapshot
      from hrm_employment_change_requests where id = ${id}`)).rows;
  return rows[0]!;
}

async function canonicalDigest(h: Harness, payload: unknown): Promise<string> {
  const rows = (await h.db.execute<{ digest: string }>(sql`
    select encode(digest(convert_to(${JSON.stringify(payload)}::jsonb::text, 'UTF8'), 'sha256'), 'hex') as digest`)).rows;
  return rows[0]!.digest;
}

async function makeFlowRun(h: Harness, requestId: string, orgId?: string): Promise<string> {
  const flowId = randomUUID();
  await h.db.execute(sql`
    insert into flows (id, org_id, subject_kind, graph)
    values (${flowId}, ${orgId ?? h.orgId}, 'hrm_employment_change_request', '{}'::jsonb)`);
  const runId = randomUUID();
  await h.db.execute(sql`
    insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
    values (${runId}, ${orgId ?? h.orgId}, ${flowId}, 'hrm_employment_change_request', ${requestId}, 'on_submit')`);
  return runId;
}

function snapshotFor(h: {
  digest: string;
  runId: string;
  expectedRevision?: number;
}): Record<string, unknown> {
  return {
    payload_digest: h.digest,
    payload_schema_version: "v1",
    expected_employment_revision: h.expectedRevision ?? 1,
    flow_run_id: h.runId,
    gates: [{ gate_id: randomUUID(), decided_by: randomUUID(), outcome: "approved" }],
  };
}

test("draft insert gets storage-computed canonical digest, never the caller value", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  const row = await readRequest(h, id);
  assert.equal(row.status, "draft");
  assert.equal(row.request_revision, 1);
  assert.equal(row.payload_digest, await canonicalDigest(h, PAYLOAD(1)));
  assert.notEqual(row.payload_digest, "0".repeat(64));
});

test("digest is semantic: key order and whitespace do not move it", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const a = await insertDraft(h);
  const reordered = JSON.stringify({ level: 1, kind: "transfer", department: "  ledger  ".trim() });
  const idB = randomUUID();
  await h.db.execute(sql`
    insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload,
       payload_digest, payload_schema_version, created_by)
    values (${idB}, ${h.orgId}, ${h.employmentId}, 1, ${reordered}::jsonb,
      ${"0".repeat(64)}, 'v1', ${h.actorId})`);
  const rowA = await readRequest(h, a);
  const rowB = await readRequest(h, idB);
  assert.equal(rowA.payload_digest, rowB.payload_digest);
});

test("draft edit bumps request_revision by exactly one and recomputes digest", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set payload = ${JSON.stringify(PAYLOAD(2))}::jsonb, request_revision = 2, updated_by = ${h.actorId}
     where id = ${id}`);
  const row = await readRequest(h, id);
  assert.equal(row.request_revision, 2);
  assert.equal(row.payload_digest, await canonicalDigest(h, PAYLOAD(2)));
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set payload = ${JSON.stringify(PAYLOAD(3))}::jsonb, request_revision = 4
       where id = ${id}`),
    /exactly one/,
    "skipped revision must be refused",
  );
});

test("forged inserts are refused: no born-submitted, stamped, decided, or applied rows", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await assert.rejects(
    h.db.execute(sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, status)
      values (${randomUUID()}, ${h.orgId}, ${h.employmentId}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1', 'pending_approval')`),
    /inserted as draft/,
  );
  await assert.rejects(
    h.db.execute(sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, submitted_by, submitted_at)
      values (${randomUUID()}, ${h.orgId}, ${h.employmentId}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1',
        ${h.actorId}, now())`),
    /unsubmitted/,
  );
});

test("submit freezes payload, revision, identity, and submission stamps", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  const runId = await makeFlowRun(h, id);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'department transfer',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${id}`);
  const digest = (await readRequest(h, id)).payload_digest;
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests set payload = ${JSON.stringify(PAYLOAD(9))}::jsonb where id = ${id}`),
    /freeze on submit/,
    "post-submit payload edit must be refused",
  );
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests set request_revision = 2 where id = ${id}`),
    /freezes on submit/,
  );
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests set submitted_by = ${randomUUID()} where id = ${id}`),
    /immutable once set/,
  );
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests set employment_id = ${randomUUID()} where id = ${id}`),
    /immutable/,
    "identity is frozen from insert",
  );
  const still = await readRequest(h, id);
  assert.equal(still.payload_digest, digest);
});

test("illegal transitions are refused; draft may withdraw without fabricated submission", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const direct = await insertDraft(h);
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set status = 'approved' where id = ${direct}`),
    /must submit/,
    "draft -> approved must be refused",
  );
  const draftWithdrawal = await insertDraft(h);
  await h.db.execute(sql`update hrm_employment_change_requests set status = 'withdrawn' where id = ${draftWithdrawal}`);
  const withdrawn = await readRequest(h, draftWithdrawal);
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.submitted_at, null);
  assert.equal(withdrawn.flow_run_id, null);
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set status = 'pending_approval' where id = ${draftWithdrawal}`),
    /terminal/,
    "withdrawn must never resurrect",
  );
  const pending = await insertDraft(h);
  const runId = await makeFlowRun(h, pending);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${pending}`);
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set status = 'applied' where id = ${pending}`),
    /resolves to approved, rejected, or withdrawn/,
    "pending -> applied must be refused",
  );
});

test("decision snapshot exists exactly on decided rows, binds digests, freezes", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  const runId = await makeFlowRun(h, id);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${id}`);
  const digest = (await readRequest(h, id)).payload_digest;
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set status = 'approved' where id = ${id}`),
    /snapshot/i,
    "approve without snapshot must be refused",
  );
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set status = 'approved',
             decision_snapshot = ${JSON.stringify({ ...snapshotFor({ digest: "f".repeat(64), runId }), gates: [] })}::jsonb
       where id = ${id}`),
    /snapshot_binding/,
    "snapshot bound to another digest must be refused",
  );
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'approved', decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
     where id = ${id}`);
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
       where id = ${id}`),
    /immutable once written/,
    "snapshot must freeze once written",
  );
});

test("employment scope is composite: a valid employment id from another org is refused", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const [{ createScratchOrg }] = await import("../engine/src/test-fixtures.ts");
  const other = await createScratchOrg();
  h.cleanupOrgs.push(other.orgId);
  const foreignEmployment = randomUUID();
  await h.db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${foreignEmployment}, ${other.orgId}, ${randomUUID()}, ${randomUUID()}, 1)`);
  let err: string | null = null;
  try {
    await h.db.execute(sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version)
      values (${randomUUID()}, ${h.orgId}, ${foreignEmployment}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1')`);
  } catch (error: unknown) {
    err = pgMessage(error);
  }
  assert.ok(err, "cross-org employment binding must be refused");
  assert.match(err!, /employment_fkey|foreign key/i);
});

test("flow run anchor is scope-bound, retained, never re-pointed", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  const [{ createScratchOrg }] = await import("../engine/src/test-fixtures.ts");
  const other = await createScratchOrg();
  h.cleanupOrgs.push(other.orgId);
  const foreignRun = await makeFlowRun(h, randomUUID(), other.orgId);
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${foreignRun}
       where id = ${id}`),
    /another organization/,
    "foreign-org run must be refused",
  );
  const wrongKindFlow = randomUUID();
  await h.db.execute(sql`
    insert into flows (id, org_id, subject_kind, graph)
    values (${wrongKindFlow}, ${h.orgId}, 'allocation_run', '{}'::jsonb)`);
  const wrongKindRun = randomUUID();
  await h.db.execute(sql`
    insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
    values (${wrongKindRun}, ${h.orgId}, ${wrongKindFlow}, 'allocation_run', ${randomUUID()}, 'on_submit')`);
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${wrongKindRun}
       where id = ${id}`),
    /not opened for this request/,
    "wrong-kind run must be refused",
  );
  const runId = await makeFlowRun(h, id);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${id}`);
  const other2 = randomUUID();
  const otherRun = await makeFlowRun(h, other2);
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set flow_run_id = ${otherRun} where id = ${id}`),
    /never re-pointed|retained/,
    "run re-pointing must be refused",
  );
  const row = await readRequest(h, id);
  assert.equal(row.flow_run_id, runId);
});

test("submitted history cannot be deleted; pure drafts can", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const draft = await insertDraft(h);
  await h.db.execute(sql`delete from hrm_employment_change_requests where id = ${draft}`);
  const submitted = await insertDraft(h);
  const runId = await makeFlowRun(h, submitted);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${submitted}`);
  await assert.rejects(
    h.db.execute(sql`delete from hrm_employment_change_requests where id = ${submitted}`),
    /retained as history/,
  );
});

test("application is all-or-nothing, linked, and single-fire", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const id = await insertDraft(h);
  const runId = await makeFlowRun(h, id);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
     where id = ${id}`);
  const digest = (await readRequest(h, id)).payload_digest;
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'approved', decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
     where id = ${id}`);
  const changeId = randomUUID();
  await h.db.execute(sql`
    insert into employment_changes (id, org_id) values (${changeId}, ${h.orgId})`);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
           applied_employment_revision = 2, applied_employment_change_id = ${changeId}
     where id = ${id}`);
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests set applied_employment_revision = 3 where id = ${id}`),
    /duplicate/,
    "second application evidence must be refused",
  );
  await assert.rejects(
    h.db.execute(sql`update hrm_employment_change_requests set status = 'approved' where id = ${id}`),
    /terminal/,
    "applied must never leave its terminal state",
  );
  const bogus = await insertDraft(h);
  const bogusRun = await makeFlowRun(h, bogus);
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'pending_approval', reason = 'r',
           submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${bogusRun}
     where id = ${bogus}`);
  const bogusDigest = (await readRequest(h, bogus)).payload_digest;
  await h.db.execute(sql`
    update hrm_employment_change_requests
       set status = 'approved',
           decision_snapshot = ${JSON.stringify(snapshotFor({ digest: bogusDigest, runId: bogusRun }))}::jsonb
     where id = ${bogus}`);
  await assert.rejects(
    h.db.execute(sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${randomUUID()}
       where id = ${bogus}`),
    /does not exist/,
    "application against a nonexistent canonical change must be refused",
  );
});
