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
 * - submit is atomic (stamps + run + reason, with a committing positive
 *   control) and freezes identity, payload, expected revision, revision,
 *   and submission stamps;
 * - the transition machine (draft -> pending_approval -> approved /
 *   rejected / withdrawn, approved -> applied; draft -> withdrawn without
 *   fabricated submission) with terminal states terminal;
 * - decision snapshots bind under two-valued presence-plus-typeof pins
 *   (revision by integral value: 1.0 approves, 1.5 and "1" refuse) and
 *   freeze once written;
 * - employment scope is composite (org_id, employment_id) — a valid
 *   employment id from another org is refused;
 * - the flow run anchor is scope-bound (same org, governed subject
 *   kind/id), stamped at submit, retained, never re-pointed;
 * - submitted history cannot be deleted; pure drafts can;
 * - RLS restricts by tenant identity under a proven-restricted role, with
 *   positive controls each way;
 * - application evidence is all-or-nothing with approved -> applied and
 *   proves same org + same employment + exact canonical revision.
 *
 * ROLLBACK CONTAINMENT. Every test body runs inside `isolated()`: one
 * transaction that always rolls back, so this suite commits ZERO rows to
 * its own table. That is load-bearing, not tidy: the no_delete trigger
 * honors no bypass GUC (by coordinator order there is no production
 * trigger bypass), while suite teardown (dropScratchOrgReporting) deletes
 * org-owned rows under openbooks.amend/sandbox_wipe/bypass_rls. A
 * committed submitted row would make the file-level `after()` hook throw.
 * Shared fixture rows (scratch org, users, two employments) stay committed
 * and leave through the standard teardown path like every other suite.
 *
 * SAVEPOINT DISCIPLINE. A refused statement aborts its transaction: every
 * later command on the same transaction fails with 25P02 until rollback,
 * which would mask every assertion after the first refusal in a test.
 * Every expected refusal therefore goes through `refuses()`, which wraps
 * the single statement in its own savepoint and asserts the genuine guard
 * message — never the 25P02 echo of an earlier abort.
 *
 * FIXTURES (final 0184 shape, coordinator thr_jhgkkrcm8j): worker_employments
 * inserts (id, org_id, worker_party_id, employer_subsidiary_id, revision)
 * — every other column is nullable or defaulted, and UNIQUE(org_id, id)
 * backs the composite FK. employment_changes inserts (id, org_id,
 * employment_id, revision, change_kind 'created', prior_snapshot '{}',
 * reason, recorded_by): recorded_source defaults to 'user',
 * recorded_source_ref stays NULL, closed_versions defaults to '[]', and
 * change_txid is trigger-stamped so it is OMITTED, never supplied.
 * Party/subsidiary legs reuse real scratch-org rows (customerId,
 * subsidiaryId) so the fixtures hold whether or not 0184 declares those
 * FKs. Canonical mutation, approval execution, and application auth are
 * other slices — this suite asserts storage refuses, never that services
 * allow or authenticate.
 *
 * Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL. Run
 * on the coordinated dedicated DB at handoff — never the schema-worker
 * DB concurrently, never production.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql, type SQL } from "drizzle-orm";

/** Drizzle wraps driver errors, hiding the PostgreSQL message in `cause`. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/db.ts");
type Tx = Parameters<Parameters<EngineDb["db"]["transaction"]>[0]>[0];

type Harness = {
  db: EngineDb["db"];
  /** Current executor: the shared db, or the test's rollback transaction. */
  run: EngineDb["db"] | Tx;
  orgId: string;
  actorId: string;
  employmentId: string;
  secondEmploymentId: string;
  cleanupOrgs: string[];
};

let harness: Harness | null = null;

// Suite-level teardown: every scratch org leased by any test in this file
// is released exactly once, no matter which test built the harness first.
// With rollback containment there are no committed request rows to fight
// the immutable-evidence triggers on the way out.
after(async () => {
  if (!harness) return;
  const [{ dropScratchOrgReporting }] = await import("../engine/src/test-fixtures.ts");
  for (const id of harness.cleanupOrgs) await dropScratchOrgReporting(id);
  harness = null;
});

async function ctx(_t?: unknown): Promise<Harness> {
  if (!harness) {
    const [{ db }, { createScratchOrg, createScratchUser }] = await Promise.all([
      import("../engine/src/db.ts"),
      import("../engine/src/test-fixtures.ts"),
    ]);
    const org = await createScratchOrg();
    // Inspect (never assume) every seed this suite joins to: the submission
    // actor must be a real user row, and the party/subsidiary legs must be
    // real seeded rows — random UUIDs would trip 0184 FKs before any guard
    // under test is reached, turning every refusal into a fixture error.
    assert.ok(org.customerId, "scratch org must seed a party for the worker leg");
    assert.ok(org.vendorId, "scratch org must seed a second party for the worker leg");
    assert.ok(org.subsidiaryId, "scratch org must seed a subsidiary for the employer leg");
    // A scratch org seeds no users: the submission actor is created here as a
    // real user row (role assignment included) rather than assumed.
    const actorId = await createScratchUser(org.orgId, "HRM request actor", "hrm_request_actor");
    const users = (await db.execute<{ id: string }>(sql`
      select id from users where id = ${actorId} and org_id = ${org.orgId}`)).rows;
    assert.ok(users[0], "submission actor must be a real user row in the scratch org");
    const employmentId = randomUUID();
    const secondEmploymentId = randomUUID();
    for (const [id, party] of [[employmentId, org.customerId], [secondEmploymentId, org.vendorId]] as const) {
      await db.execute(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
        values (${id}, ${org.orgId}, ${party}, ${org.subsidiaryId}, 1)`);
    }
    harness = {
      db,
      run: db,
      orgId: org.orgId,
      actorId: users[0]!.id,
      employmentId,
      secondEmploymentId,
      cleanupOrgs: [org.orgId],
    };
  }
  return harness;
}

/** Sentinel: thrown to roll the test transaction back after assertions. */
class IsolatedRollback extends Error {}

/**
 * Run `work` on a transaction that always rolls back, restoring the shared
 * executor afterwards. Tests run sequentially in this file, so the
 * temporary `h.run` swap cannot leak across tests. Real refusals propagate;
 * only the sentinel is swallowed.
 */
async function isolated(h: Harness, work: () => Promise<void>): Promise<void> {
  try {
    await h.db.transaction(async (tx) => {
      const prev = h.run;
      h.run = tx;
      try {
        await work();
      } finally {
        h.run = prev;
      }
      throw new IsolatedRollback();
    });
  } catch (error) {
    if (error instanceof IsolatedRollback) return;
    throw error;
  }
}

/**
 * Assert one statement is refused with the guard's own message. The
 * statement runs inside its own savepoint: without it the refusal would
 * abort the test transaction and every later assertion would see only
 * 25P02 (in_failed_sql_transaction), masking the behavior under test. A
 * statement that succeeds is itself the failure.
 */
async function refuses(h: Harness, stmt: SQL, re: RegExp, msg?: string): Promise<void> {
  await h.run.execute(sql`savepoint expect_refusal`);
  try {
    await h.run.execute(stmt);
  } catch (error: unknown) {
    await h.run.execute(sql`rollback to savepoint expect_refusal`);
    await h.run.execute(sql`release savepoint expect_refusal`);
    assert.match(pgMessage(error), re, msg);
    return;
  }
  await h.run.execute(sql`release savepoint expect_refusal`);
  assert.fail(`expected refusal did not fire${msg ? `: ${msg}` : ""}`);
}

const PAYLOAD = (n: number) => ({ kind: "transfer", department: "ledger", level: n });

async function insertDraft(h: Harness): Promise<string> {
  const id = randomUUID();
  await h.run.execute(sql`
    insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload,
       payload_digest, payload_schema_version, created_by)
    values (${id}, ${h.orgId}, ${h.employmentId}, 1, ${JSON.stringify(PAYLOAD(1))}::jsonb,
      ${"0".repeat(64)}, 'v1', ${h.actorId})`);
  return id;
}

async function readRequest(h: Harness, id: string) {
  const rows = (await h.run.execute<{
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
  const rows = (await h.run.execute<{ digest: string }>(sql`
    select encode(digest(convert_to(${JSON.stringify(payload)}::jsonb::text, 'UTF8'), 'sha256'), 'hex') as digest`)).rows;
  return rows[0]!.digest;
}

async function makeFlowRun(h: Harness, requestId: string, orgId?: string): Promise<string> {
  const flowId = randomUUID();
  await h.run.execute(sql`
    insert into flows (id, org_id, subject_kind, graph)
    values (${flowId}, ${orgId ?? h.orgId}, 'hrm_employment_change_request', '{}'::jsonb)`);
  const runId = randomUUID();
  await h.run.execute(sql`
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

async function insertCanonicalChange(
  h: Harness,
  employmentId: string,
  revision: number,
): Promise<string> {
  const id = randomUUID();
  await h.run.execute(sql`
    insert into employment_changes
      (id, org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_by)
    values (${id}, ${h.orgId}, ${employmentId}, ${revision}, 'created', '{}'::jsonb,
      'governed application evidence', ${h.actorId})`);
  return id;
}

test("draft insert gets storage-computed canonical digest, never the caller value", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const row = await readRequest(h, id);
    assert.equal(row.status, "draft");
    assert.equal(row.request_revision, 1);
    assert.equal(row.payload_digest, await canonicalDigest(h, PAYLOAD(1)));
    assert.notEqual(row.payload_digest, "0".repeat(64));
  });
});

test("digest is semantic: key order and whitespace do not move it", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const a = await insertDraft(h);
    const reordered = JSON.stringify({ level: 1, kind: "transfer", department: "  ledger  ".trim() });
    const idB = randomUUID();
    await h.run.execute(sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, created_by)
      values (${idB}, ${h.orgId}, ${h.employmentId}, 1, ${reordered}::jsonb,
        ${"0".repeat(64)}, 'v1', ${h.actorId})`);
    const rowA = await readRequest(h, a);
    const rowB = await readRequest(h, idB);
    assert.equal(rowA.payload_digest, rowB.payload_digest);
  });
});

test("draft edit bumps request_revision by exactly one and recomputes digest", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set payload = ${JSON.stringify(PAYLOAD(2))}::jsonb, request_revision = 2, updated_by = ${h.actorId}
       where id = ${id}`);
    const row = await readRequest(h, id);
    assert.equal(row.request_revision, 2);
    assert.equal(row.payload_digest, await canonicalDigest(h, PAYLOAD(2)));
    await refuses(h, sql`
      update hrm_employment_change_requests
         set payload = ${JSON.stringify(PAYLOAD(3))}::jsonb, request_revision = 4
       where id = ${id}`, /exactly one/, "skipped revision must be refused");
  });
});

test("forged inserts are refused: no born-submitted, stamped, decided, or applied rows", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    await refuses(h, sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, status)
      values (${randomUUID()}, ${h.orgId}, ${h.employmentId}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1', 'pending_approval')`,
      /inserted as draft/);
    await refuses(h, sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, submitted_by, submitted_at)
      values (${randomUUID()}, ${h.orgId}, ${h.employmentId}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1',
        ${h.actorId}, now())`,
      /unsubmitted/);
  });
});

test("submit freezes payload, revision, identity, and submission stamps", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'department transfer',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const digest = (await readRequest(h, id)).payload_digest;
    await refuses(h, sql`
      update hrm_employment_change_requests set payload = ${JSON.stringify(PAYLOAD(9))}::jsonb where id = ${id}`,
      /freeze on submit/, "post-submit payload edit must be refused");
    await refuses(h, sql`
      update hrm_employment_change_requests set request_revision = 2 where id = ${id}`,
      /freezes on submit/);
    await refuses(h, sql`
      update hrm_employment_change_requests set submitted_by = ${randomUUID()} where id = ${id}`,
      /immutable once set/);
    await refuses(h, sql`
      update hrm_employment_change_requests set employment_id = ${randomUUID()} where id = ${id}`,
      /immutable/, "identity is frozen from insert");
    const still = await readRequest(h, id);
    assert.equal(still.payload_digest, digest);
  });
});

test("illegal transitions are refused; draft may withdraw without fabricated submission", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const direct = await insertDraft(h);
    await refuses(h, sql`update hrm_employment_change_requests set status = 'approved' where id = ${direct}`,
      /must submit/, "draft -> approved must be refused");
    const draftWithdrawal = await insertDraft(h);
    await h.run.execute(sql`update hrm_employment_change_requests set status = 'withdrawn' where id = ${draftWithdrawal}`);
    const withdrawn = await readRequest(h, draftWithdrawal);
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.submitted_at, null);
    assert.equal(withdrawn.flow_run_id, null);
    await refuses(h, sql`update hrm_employment_change_requests set status = 'pending_approval' where id = ${draftWithdrawal}`,
      /terminal/, "withdrawn must never resurrect");
    const pending = await insertDraft(h);
    const runId = await makeFlowRun(h, pending);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${pending}`);
    await refuses(h, sql`update hrm_employment_change_requests set status = 'applied' where id = ${pending}`,
      /resolves to approved, rejected, or withdrawn/, "pending -> applied must be refused");
  });
});

test("decision snapshot exists exactly on decided rows, binds digests, freezes", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const digest = (await readRequest(h, id)).payload_digest;
    await refuses(h, sql`update hrm_employment_change_requests set status = 'approved' where id = ${id}`,
      /snapshot/i, "approve without snapshot must be refused");
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'approved',
             decision_snapshot = ${JSON.stringify({ ...snapshotFor({ digest: "f".repeat(64), runId }), gates: [] })}::jsonb
       where id = ${id}`,
      /snapshot_binding/, "snapshot bound to another digest must be refused");
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'approved', decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
       where id = ${id}`);
    await refuses(h, sql`
      update hrm_employment_change_requests
         set decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
       where id = ${id}`,
      /immutable once written/, "snapshot must freeze once written");
  });
});

test("employment scope is composite: a valid employment id from another org is refused", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const [{ createScratchOrg }] = await import("../engine/src/test-fixtures.ts");
  const other = await createScratchOrg();
  h.cleanupOrgs.push(other.orgId);
  await isolated(h, async () => {
    const foreignEmployment = randomUUID();
    await h.run.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${foreignEmployment}, ${other.orgId}, ${other.customerId}, ${other.subsidiaryId}, 1)`);
    await refuses(h, sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version)
      values (${randomUUID()}, ${h.orgId}, ${foreignEmployment}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1')`,
      /employment_fkey|foreign key/i, "cross-org employment binding must be refused");
  });
});

test("flow run anchor is scope-bound, retained, never re-pointed", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const [{ createScratchOrg }] = await import("../engine/src/test-fixtures.ts");
  const other = await createScratchOrg();
  h.cleanupOrgs.push(other.orgId);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const foreignRun = await makeFlowRun(h, randomUUID(), other.orgId);
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${foreignRun}
       where id = ${id}`,
      /another organization/, "foreign-org run must be refused");
    const wrongKindFlow = randomUUID();
    await h.run.execute(sql`
      insert into flows (id, org_id, subject_kind, graph)
      values (${wrongKindFlow}, ${h.orgId}, 'allocation_run', '{}'::jsonb)`);
    const wrongKindRun = randomUUID();
    await h.run.execute(sql`
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
      values (${wrongKindRun}, ${h.orgId}, ${wrongKindFlow}, 'allocation_run', ${randomUUID()}, 'on_submit')`);
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${wrongKindRun}
       where id = ${id}`,
      /not opened for this request/, "wrong-kind run must be refused");
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const otherRun = await makeFlowRun(h, randomUUID());
    await refuses(h, sql`update hrm_employment_change_requests set flow_run_id = ${otherRun} where id = ${id}`,
      /never re-pointed|retained/, "run re-pointing must be refused");
    const row = await readRequest(h, id);
    assert.equal(row.flow_run_id, runId);
  });
});

test("submitted history cannot be deleted; pure drafts can", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const draft = await insertDraft(h);
    await h.run.execute(sql`delete from hrm_employment_change_requests where id = ${draft}`);
    const submitted = await insertDraft(h);
    const runId = await makeFlowRun(h, submitted);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${submitted}`);
    await refuses(h, sql`delete from hrm_employment_change_requests where id = ${submitted}`,
      /retained as history/);
  });
});

test("submit demands atomic evidence: bare flip refused, complete submit accepted", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    await refuses(h, sql`update hrm_employment_change_requests set status = 'pending_approval' where id = ${id}`,
      /atomically/, "draft -> pending_approval without submission evidence must be refused");
    const refused = await readRequest(h, id);
    assert.equal(refused.status, "draft");
    // Positive control: the same transition with stamps, run, and reason
    // commits — the refusal above is about missing evidence, not the flip.
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'department transfer',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const submitted = await readRequest(h, id);
    assert.equal(submitted.status, "pending_approval");
    assert.equal(submitted.submitted_at === null, false);
    assert.equal(submitted.flow_run_id, runId);
  });
});

test("row id and created_at freeze from insert", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    await refuses(h, sql`update hrm_employment_change_requests set id = ${randomUUID()} where id = ${id}`,
      /immutable/, "row id must freeze");
    await refuses(h, sql`update hrm_employment_change_requests set created_at = now() - interval '1 day' where id = ${id}`,
      /immutable/, "created_at must freeze");
  });
});

test("snapshot binding is two-valued: presence plus typeof pins refuse null, missing, wrong-type, and mismatch", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const digest = (await readRequest(h, id)).payload_digest;
    const good = snapshotFor({ digest, runId });
    const withoutDigest = { ...good };
    delete withoutDigest.payload_digest;
    const withoutGates = { ...good };
    delete withoutGates.gates;
    // Every variant below must evaluate the binding CHECK to FALSE (never
    // UNKNOWN): a missing key fails `?`, a present JSON null fails its
    // typeof pin, a wrong scalar type fails its typeof pin, and a wrong
    // value fails the equality against two non-null sides.
    const variants: Array<[string, Record<string, unknown>]> = [
      ["json-null digest", { ...good, payload_digest: null }],
      ["missing digest key", withoutDigest],
      ["missing gates key", withoutGates],
      ["gates not array", { ...good, gates: { gate_id: randomUUID() } }],
      ["string revision", { ...good, expected_employment_revision: "1" }],
      ["non-integral revision", { ...good, expected_employment_revision: 1.5 }],
      ["wrong revision", { ...good, expected_employment_revision: 2 }],
      ["wrong flow run", { ...good, flow_run_id: randomUUID() }],
      ["json-null flow run", { ...good, flow_run_id: null }],
    ];
    for (const [name, snapshot] of variants) {
      await refuses(h, sql`
        update hrm_employment_change_requests
           set status = 'approved', decision_snapshot = ${JSON.stringify(snapshot)}::jsonb
         where id = ${id}`,
        /snapshot_binding/, `${name} must be refused by the binding CHECK`);
    }
    const still = await readRequest(h, id);
    assert.equal(still.status, "pending_approval");
    assert.equal(still.decision_snapshot, null);
    // Revision binds by INTEGRAL VALUE, not representation: JSON 1.0 denotes
    // the same counter as JSON 1 and must approve. JSON.stringify drops the
    // ".0", so the .0 form is spliced into the raw text deliberately.
    const floatForm = JSON.stringify(good).replace(
      '"expected_employment_revision":1,',
      '"expected_employment_revision":1.0,',
    );
    assert.ok(floatForm.includes("1.0"), "float revision form must be present in the probe JSON");
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'approved', decision_snapshot = ${floatForm}::jsonb
       where id = ${id}`);
    const approved = await readRequest(h, id);
    assert.equal(approved.status, "approved");
  });
});

test("history FKs are restrictive except org cascade", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const rows = (await h.run.execute<{ conname: string; confdeltype: string }>(sql`
      select c.conname, c.confdeltype
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'hrm_employment_change_requests' and c.contype = 'f'`)).rows;
    const byName = new Map(rows.map((r) => [r.conname, r.confdeltype]));
    assert.equal(byName.get("hrm_employment_change_requests_org_id_fkey"), "c");
    for (const name of [
      "hrm_employment_change_requests_employment_fkey",
      "hrm_employment_change_requests_flow_run_fkey",
      "hrm_employment_change_requests_applied_change_fkey",
      "hrm_employment_change_requests_submitted_by_fkey",
      "hrm_employment_change_requests_applied_by_fkey",
      "hrm_employment_change_requests_created_by_fkey",
      "hrm_employment_change_requests_updated_by_fkey",
    ]) {
      assert.ok(
        byName.get(name) === "r" || byName.get(name) === "a",
        `${name} must be restrictive (RESTRICT/NO ACTION), got ${byName.get(name)}`,
      );
    }
  });
});

test("RLS restricts by identity under a proven-restricted role", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  const [{ createScratchOrg }] = await import("../engine/src/test-fixtures.ts");
  const other = await createScratchOrg();
  h.cleanupOrgs.push(other.orgId);
  await isolated(h, async () => {
    // Fixture rows are seeded as the owner (the harness login): the
    // restricted role below receives only a test-local SELECT grant, so it
    // can prove isolation without ever writing.
    const otherEmployment = randomUUID();
    await h.run.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${otherEmployment}, ${other.orgId}, ${other.customerId}, ${other.subsidiaryId}, 1)`);
    const otherUsers = (await h.run.execute<{ id: string }>(sql`
      select id from users where org_id = ${other.orgId} order by created_at limit 1`)).rows;
    assert.ok(otherUsers[0], "second scratch org must seed a user");
    const ownId = await insertDraft(h);
    const otherId = randomUUID();
    await h.run.execute(sql`
      insert into hrm_employment_change_requests
        (id, org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, created_by)
      values (${otherId}, ${other.orgId}, ${otherEmployment}, 1,
        ${JSON.stringify(PAYLOAD(1))}::jsonb, ${"0".repeat(64)}, 'v1', ${otherUsers[0]!.id})`);
    // Owner-side precondition: the bootstrap-provided restricted role must
    // exist and be genuinely constrained. Fail here with the role named
    // instead of misreading counts later. Never CREATE ROLE here — global
    // role creation is outside this slice.
    const role = (await h.run.execute<{ r: string; s: boolean; b: boolean }>(sql`
      select rolname as r, rolsuper as s, rolbypassrls as b from pg_roles
       where rolname = 'openbooks_app'`)).rows[0];
    assert.ok(role, "bootstrap must provide the restricted openbooks_app role");
    assert.equal(role.s, false, "openbooks_app must not be a superuser");
    assert.equal(role.b, false, "openbooks_app must not have BYPASSRLS");
    // Test-local read grant as owner: the new table carries no standing
    // grant to the restricted role, so without this every count below would
    // be 0 from missing privilege — a vacuous pass. Rolls back with the
    // isolated transaction.
    await h.run.execute(sql`grant select on hrm_employment_change_requests to openbooks_app`);
    // Fixture setup as owner ends here: the assertions below run AS the
    // restricted role with bypass OFF under an explicit tenant, in a
    // savepoint with transaction-local GUCs so no scope leaks to siblings.
    // Each side carries a positive control — invisibility is proved to be
    // identity-based, never an empty table or a missing grant.
    await h.run.transaction(async (tx) => {
      await tx.execute(sql`set local role openbooks_app`);
      try {
        // Load-bearing proof AFTER the switch: a superuser or BYPASSRLS
        // role skips policies entirely (FORCE included), which would make
        // the invisibility assertions below vacuous. Asserting before the
        // switch proved only the owner login, never the asserting role.
        const who = (await tx.execute<{ u: string; s: boolean; b: boolean }>(sql`
          select current_user as u,
                 (select rolsuper from pg_roles where rolname = current_user) as s,
                 (select rolbypassrls from pg_roles where rolname = current_user) as b`)).rows[0]!;
        assert.equal(who.u, "openbooks_app", "RLS proof must run as the restricted role");
        assert.equal(who.s, false, `RLS proof needs a non-superuser role, got ${who.u}`);
        assert.equal(who.b, false, `RLS proof needs a role without BYPASSRLS, got ${who.u}`);
        const scopedCount = async (orgId: string, id: string): Promise<number> => {
          await tx.execute(sql`select set_config('app.bypass_rls', 'off', true)`);
          await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
          const rows = (await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from hrm_employment_change_requests where id = ${id}`)).rows;
          return rows[0]!.n;
        };
        assert.equal(await scopedCount(h.orgId, ownId), 1, "own request visible in own scope");
        assert.equal(await scopedCount(h.orgId, otherId), 0, "foreign request hidden in own scope");
        assert.equal(await scopedCount(other.orgId, otherId), 1, "foreign request visible in its own scope");
        assert.equal(await scopedCount(other.orgId, ownId), 0, "own request hidden in foreign scope");
      } finally {
        // Restore the owner session role before the savepoint releases, so
        // outer owner cleanup never runs as the restricted role — even when
        // an assertion above throws. The outer isolated() rollback is the
        // final backstop.
        await tx.execute(sql`reset role`);
      }
    });
  });
});

test("application is all-or-nothing, linked, and single-fire", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    const id = await insertDraft(h);
    const runId = await makeFlowRun(h, id);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
       where id = ${id}`);
    const digest = (await readRequest(h, id)).payload_digest;
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'approved', decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
       where id = ${id}`);
    const changeId = await insertCanonicalChange(h, h.employmentId, 2);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${changeId}
       where id = ${id}`);
    await refuses(h, sql`
      update hrm_employment_change_requests set applied_employment_revision = 3 where id = ${id}`,
      /duplicate/, "second application evidence must be refused");
    await refuses(h, sql`update hrm_employment_change_requests set status = 'approved' where id = ${id}`,
      /terminal/, "applied must never leave its terminal state");
    const bogus = await insertDraft(h);
    const bogusRun = await makeFlowRun(h, bogus);
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'pending_approval', reason = 'r',
             submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${bogusRun}
       where id = ${bogus}`);
    const bogusDigest = (await readRequest(h, bogus)).payload_digest;
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'approved',
             decision_snapshot = ${JSON.stringify(snapshotFor({ digest: bogusDigest, runId: bogusRun }))}::jsonb
       where id = ${bogus}`);
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${randomUUID()}
       where id = ${bogus}`,
      /does not exist/, "application against a nonexistent canonical change must be refused");
  });
});

test("application proves same org, same employment, and exact revision", { skip: !DB, timeout: 120_000 }, async (t) => {
  const h = await ctx(t);
  await isolated(h, async () => {
    async function approvedRequest(): Promise<{ id: string; runId: string; digest: string }> {
      const id = await insertDraft(h);
      const runId = await makeFlowRun(h, id);
      await h.run.execute(sql`
        update hrm_employment_change_requests
           set status = 'pending_approval', reason = 'r',
               submitted_by = ${h.actorId}, submitted_at = now(), flow_run_id = ${runId}
         where id = ${id}`);
      const digest = (await readRequest(h, id)).payload_digest;
      await h.run.execute(sql`
        update hrm_employment_change_requests
           set status = 'approved',
               decision_snapshot = ${JSON.stringify(snapshotFor({ digest, runId }))}::jsonb
         where id = ${id}`);
      return { id, runId, digest };
    }
    const otherEmploymentChange = await insertCanonicalChange(h, h.secondEmploymentId, 2);
    const wrongRevisionChange = await insertCanonicalChange(h, h.employmentId, 99);
    const first = await approvedRequest();
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${otherEmploymentChange}
       where id = ${first.id}`,
      /another employment/, "application against another employment's change must be refused");
    const second = await approvedRequest();
    await refuses(h, sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${wrongRevisionChange}
       where id = ${second.id}`,
      /not the applied revision/, "application with a mismatched canonical revision must be refused");
    const rightChange = await insertCanonicalChange(h, h.employmentId, 2);
    const third = await approvedRequest();
    await h.run.execute(sql`
      update hrm_employment_change_requests
         set status = 'applied', applied_at = now(), applied_by = ${h.actorId},
             applied_employment_revision = 2, applied_employment_change_id = ${rightChange}
       where id = ${third.id}`);
    const applied = await readRequest(h, third.id);
    assert.equal(applied.status, "applied");
  });
});
