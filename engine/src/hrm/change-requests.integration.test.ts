import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  createChangeRequestDraft,
  getChangeRequest,
  HrmChangeRequestError,
  listChangeRequests,
  submitChangeRequest,
  updateChangeRequestPayload,
  withdrawChangeRequest,
} from "./change-requests.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { decideGate, GateError, ReleaseError } from "../flows/gates.ts";

/**
 * Slice A DB coverage (integration partition): governed employment
 * change-request lifecycle over real 0184 rows — create/submit/decide/apply
 * per kind, stale-revision refusal with zero partial effects, release-throw
 * rollback (gate still pending, request still pending_approval), terminal
 * withdrawals refused, identity-separation refusals, RLS cross-org
 * invisibility, and a concurrent two-session apply where exactly one wins.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone: the digest is recomputed with the canonical SQL expression,
 * closures are matched against to_jsonb before-images, and every refusal
 * asserts the writes that must NOT exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  submitterId: string;
  approver1Id: string;
  approver2Id: string;
  outsiderId: string;
};

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  const submitterId = await createScratchUser(org.orgId, "HRM Submitter", "hrm_author");
  const approver1Id = await createScratchUser(org.orgId, "HRM Approver One", "hrm_decider");
  const approver2Id = await createScratchUser(org.orgId, "HRM Approver Two", "hrm_decider_two");
  const outsiderId = await createScratchUser(org.orgId, "HRM Outsider", "hrm_viewer");
  await grantPermissions(org.orgId, submitterId, ["hrm.employment.read", "hrm.employment.manage"]);
  await grantPermissions(org.orgId, approver1Id, ["hrm.employment.read", "hrm.employment.approve"]);
  await grantPermissions(org.orgId, approver2Id, ["hrm.employment.read", "hrm.employment.approve"]);
  await linkPerson(org.orgId, submitterId);
  await linkPerson(org.orgId, approver1Id);
  await linkPerson(org.orgId, approver2Id);
  await linkPerson(org.orgId, outsiderId);
  return { org, submitterId, approver1Id, approver2Id, outsiderId };
}

/** A reserved employment identity: stable row at revision 1, no versions. */
async function seedReservedEmployment(orgId: string, subsidiaryId: string): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Hired Worker', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  return { employmentId, workerPartyId };
}

/** Append one live version (test-only canonical writer, same shape as apply). */
async function addLiveVersion(
  orgId: string,
  employmentId: string,
  args: { status: string; from: string; to?: string | null },
): Promise<{ id: string; versionNo: number }> {
  const maxRow = (await db.execute<{ n: number }>(sql`
    select coalesce(max(version_no), 0)::int as n from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
  `)).rows[0];
  const versionNo = (maxRow?.n ?? 0) + 1;
  // One transaction like the service: the deferred evidence guards prove at
  // commit, so the close, the successor, and the event must commit together
  // (a per-statement commit would fire the reverse proof before the close).
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
    const now = (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now;
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
       order by version_no
    `)).rows;
    const newRevision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0]!.revision + 1;
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${newRevision},
              'corrected', '{}'::jsonb, 'test seed',
              'system', 'slice-a-seed',
              ${JSON.stringify(prior.map((row) => ({
                table: "worker_employment_versions",
                identity: employmentId,
                version_no: row.version_no,
                row_id: row.id,
                before: row.before,
              })))}::jsonb)
      returning id
    `)).rows[0]!.id;
    for (const row of prior) {
      await tx.execute(sql`
        update worker_employment_versions
           set recorded_until = ${now}, superseded_by = ${versionNo}, closed_by_change_id = ${changeId}
         where id = ${row.id}
      `);
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${args.status},
              ${args.from}::date, ${args.to ?? null}::date, ${now})
      returning id
    `)).rows[0]!.id;
    await tx.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}
    `);
    return inserted;
  });
  return { id, versionNo };
}

async function seedFlow(orgId: string, approverId: string): Promise<void> {
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
    assignees: [{ type: "user", userId: approverId }],
    mode: "any",
  });
}

async function gateOf(requestId: string): Promise<{ id: string; status: string; runId: string }> {
  const rows = (await db.execute<{ id: string; status: string; runId: string }>(sql`
    select id, status, run_id as "runId" from flow_gates
     where subject_id = ${requestId} order by created_at
  `)).rows;
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return rows[0]!;
}

async function requestStatus(requestId: string): Promise<string> {
  const rows = (await db.execute<{ status: string }>(sql`
    select status from hrm_employment_change_requests where id = ${requestId}
  `)).rows;
  return rows[0]!.status;
}

/** Storage-computed digest, recomputed with the canonical SQL expression. */
async function canonicalDigest(requestId: string): Promise<string> {
  const rows = (await db.execute<{ stored: string; computed: string }>(sql`
    select payload_digest as stored,
           encode(digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex') as computed
      from hrm_employment_change_requests where id = ${requestId}
  `)).rows;
  assert.equal(rows[0]!.stored, rows[0]!.computed, "the stored digest equals the canonical recomputation");
  return rows[0]!.stored;
}

async function changeRows(employmentId: string): Promise<Array<{ id: string; revision: number; kind: string; closed: unknown }>> {
  const rows = (await db.execute<{ id: string; revision: number; kind: string; closed: unknown }>(sql`
    select id, revision, change_kind as kind, closed_versions as closed
      from employment_changes where employment_id = ${employmentId} order by revision
  `)).rows;
  return rows;
}

async function decisionAuditCount(gateId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where table_name = 'flow_gates' and row_id = ${gateId} and action = 'update'
  `)).rows;
  return rows[0]?.n ?? 0;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

test("hire happy path: draft → submit → decide → applied with real 0184 rows", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.expectedEmploymentRevision, 1);
    assert.match(draft.payloadDigest, /^[0-9a-f]{64}$/);

    const submitted = await submitChangeRequest({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      requestId: draft.id,
      reason: "backfill the September cohort",
    });
    assert.equal(submitted.status, "pending_approval");
    assert.ok(submitted.flowRunId);
    assert.equal(submitted.payloadDigest, draft.payloadDigest, "submit freezes the digest");
    await canonicalDigest(draft.id);

    const gate = await gateOf(draft.id);
    const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: h.approver1Id });
    assert.equal(decided.ok, true);
    assert.equal(decided.resumed, "approve");

    assert.equal(await requestStatus(draft.id), "applied");
    const applied = await getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id });
    assert.equal(applied.appliedEmploymentRevision, 2);
    assert.ok(applied.appliedEmploymentChangeId);
    assert.equal(applied.appliedBy, h.approver1Id);
    // Decision snapshot pins the bound digests plus the decided native gate.
    const snapshot = applied.decisionSnapshot!;
    assert.equal(snapshot.payload_digest, applied.payloadDigest);
    assert.equal(snapshot.payload_schema_version, "1");
    assert.equal(snapshot.expected_employment_revision, 1);
    assert.equal(snapshot.flow_run_id, applied.flowRunId);
    const gates = snapshot.gates as Array<Record<string, unknown>>;
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.decided_by, h.approver1Id);
    assert.equal(gates[0]!.decision, "approved");
    await canonicalDigest(draft.id);

    const versions = (await db.execute<{ version_no: number; status: string; recorded_until: Date | null }>(sql`
      select version_no, status, recorded_until from worker_employment_versions
       where employment_id = ${employmentId} order by version_no
    `)).rows;
    assert.deepEqual(versions.map((v) => [v.version_no, v.status, v.recorded_until]), [[1, "active", null]]);
    const changes = await changeRows(employmentId);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.kind, "created");
    assert.equal(changes[0]!.revision, 2);
    assert.equal(applied.appliedEmploymentChangeId, changes[0]!.id);
    const revision = (await db.execute<{ revision: number }>(sql`
      select revision from worker_employments where id = ${employmentId}
    `)).rows[0]!.revision;
    assert.equal(revision, 2);
    assert.equal(await decisionAuditCount(gate.id), 1);
  });
});

test("status change closes the live version with its exact before-image", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const first = await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "status_change", status: "on_leave", effectiveFrom: "2026-01-01" },
    });
    assert.equal(draft.expectedEmploymentRevision, 2);
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "parental leave" });
    const gate = await gateOf(draft.id);
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.approver1Id });
    assert.equal(await requestStatus(draft.id), "applied");

    const versions = (await db.execute<{ version_no: number; status: string; superseded_by: number | null }>(sql`
      select version_no, status, superseded_by from worker_employment_versions
       where employment_id = ${employmentId} order by version_no
    `)).rows;
    assert.deepEqual(versions.map((v) => [v.version_no, v.status, v.superseded_by]), [
      [1, "active", 2],
      [2, "on_leave", null],
    ]);
    // Seamless recorded handoff: successor recorded_at equals the close.
    const stamps = (await db.execute<{ a: string; b: string }>(sql`
      select c.recorded_until::text as a, s.recorded_at::text as b
        from worker_employment_versions c
        join worker_employment_versions s
          on s.employment_id = c.employment_id and s.version_no = c.superseded_by
       where c.id = ${first.id}
    `)).rows[0]!;
    assert.equal(stamps.a, stamps.b);

    const changes = await changeRows(employmentId);
    const applied = changes.find((c) => c.kind === "status_changed")!;
    assert.ok(applied);
    const closed = applied.closed as Array<Record<string, unknown>>;
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.table, "worker_employment_versions");
    assert.equal(closed[0]!.identity, employmentId);
    assert.equal(closed[0]!.version_no, 1);
    assert.equal(closed[0]!.row_id, first.id);
    assert.equal((closed[0]!.before as { id: string }).id, first.id);
    assert.equal((closed[0]!.before as { status: string }).status, "active");
  });
});

test("assignment issue then supersede, with department and location refs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });
    const deptId = randomUUID();
    await db.execute(sql`
      insert into departments (id, org_id, name) values (${deptId}, ${h.org.orgId}, 'Engineering')
    `);

    const issue = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: {
        kind: "assignment_change",
        assignmentKey: "primary",
        jobTitle: "Engineer",
        departmentId: deptId,
        locationId: h.org.locationId,
        fte: "1.0000",
        isPrimary: true,
        effectiveFrom: "2026-01-01",
      },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: issue.id, reason: "staff the team" });
    await decideGate({ gateId: (await gateOf(issue.id)).id, decision: "approved", userId: h.approver1Id });
    assert.equal(await requestStatus(issue.id), "applied");

    const supersede = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "assignment_change", assignmentKey: "primary", fte: "0.8000" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: supersede.id, reason: "part-time" });
    await decideGate({ gateId: (await gateOf(supersede.id)).id, decision: "approved", userId: h.approver1Id });
    assert.equal(await requestStatus(supersede.id), "applied");

    const versions = (await db.execute<{ version_no: number; fte: string; superseded_by: number | null }>(sql`
      select av.version_no, av.fte::text as fte, av.superseded_by
        from employment_assignment_versions av
        join employment_assignments a on a.id = av.assignment_id
       where a.employment_id = ${employmentId} and a.assignment_key = 'primary'
       order by av.version_no
    `)).rows;
    assert.deepEqual(versions.map((v) => [v.version_no, v.fte, v.superseded_by]), [
      [1, "1.0000", 2],
      [2, "0.8000", null],
    ]);
    assert.equal(versions.length, 2);
    const changes = await changeRows(employmentId);
    assert.deepEqual(changes.map((c) => c.kind), ["corrected", "assignment_issued", "assignment_superseded"]);
  });
});

test("termination applies and a second termination is refused", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "termination", effectiveDate: "2026-10-31" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "resigned" });
    await decideGate({ gateId: (await gateOf(draft.id)).id, decision: "approved", userId: h.approver1Id });
    assert.equal(await requestStatus(draft.id), "applied");
    const live = (await db.execute<{ status: string }>(sql`
      select status from worker_employment_versions
       where employment_id = ${employmentId} and recorded_until is null
    `)).rows;
    assert.deepEqual(live.map((v) => v.status), ["terminated"]);

    await assert.rejects(
      createChangeRequestDraft({
        orgId: h.org.orgId,
        actorId: h.submitterId,
        employmentId,
        payload: { kind: "termination", effectiveDate: "2026-11-30" },
      }),
      (e: unknown) => e instanceof HrmChangeRequestError && /already terminated/.test(e.message),
    );
  });
});

test("manager repoint closes the reporting line in the same aggregate event", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });
    const managerA = (await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId)).employmentId;
    const managerB = (await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId)).employmentId;

    const first = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: {
        kind: "assignment_change",
        assignmentKey: "primary",
        fte: "1",
        effectiveFrom: "2026-01-01",
        managerEmploymentId: managerA,
      },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: first.id, reason: "join team A" });
    await decideGate({ gateId: (await gateOf(first.id)).id, decision: "approved", userId: h.approver1Id });

    const repoint = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: {
        kind: "assignment_change",
        assignmentKey: "primary",
        fte: "1",
        managerEmploymentId: managerB,
      },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: repoint.id, reason: "move to team B" });
    await decideGate({ gateId: (await gateOf(repoint.id)).id, decision: "approved", userId: h.approver1Id });
    assert.equal(await requestStatus(repoint.id), "applied");

    const lines = (await db.execute<{ version_no: number; manager: string; closed: boolean }>(sql`
      select version_no, manager_employment_id as manager, recorded_until is not null as closed
        from reporting_relationships
       where employment_id = ${employmentId} and kind = 'line' order by version_no
    `)).rows;
    assert.deepEqual(lines.map((l) => [l.version_no, l.manager, l.closed]), [
      [1, managerA, true],
      [2, managerB, false],
    ]);
    assert.equal(lines[0]!.manager, managerA);
    // Both closures share the one aggregate event of the repoint.
    const applied = await getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: repoint.id });
    const changes = await changeRows(employmentId);
    const event = changes.find((c) => c.id === applied.appliedEmploymentChangeId)!;
    const tables = (event.closed as Array<{ table: string }>).map((e) => e.table).sort();
    assert.deepEqual(tables, ["employment_assignment_versions", "reporting_relationships"]);
  });
});

test("stale revision is refused at apply with nothing written", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "status_change", status: "suspended", effectiveFrom: "2026-01-01" },
    });
    assert.equal(draft.expectedEmploymentRevision, 2);
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "investigation" });
    const gate = await gateOf(draft.id);

    // A concurrent governed write lands first: the proposal is now stale.
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-02-01" });

    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.approver1Id }),
      (e: unknown) => {
        assert.ok(e instanceof ReleaseError, `expected ReleaseError, got ${String(e)}`);
        assert.match(e.message, /expected revision 2, live revision 3/);
        assert.match(e.message, /was not recorded/);
        assert.match(e.message, /retry your decision/);
        return true;
      },
    );
    // The attempt recorded nothing: gate pending, request pending, no
    // versions, no change event, no decision evidence.
    assert.equal((await gateOf(draft.id)).status, "pending");
    assert.equal(await requestStatus(draft.id), "pending_approval");
    assert.equal(await decisionAuditCount(gate.id), 0);
    assert.deepEqual((await changeRows(employmentId)).map((c) => c.kind), ["corrected", "corrected"]);
    const suspended = (await db.execute(sql`
      select 1 as one from worker_employment_versions
       where employment_id = ${employmentId} and status = 'suspended'
    `)).rows;
    assert.equal(suspended.length, 0);
    const snapshot = (await db.execute<{ s: unknown }>(sql`
      select decision_snapshot as s from hrm_employment_change_requests where id = ${draft.id}
    `)).rows[0]!.s;
    assert.equal(snapshot, null);
  });
});

test("a hire raced by a landed version rolls the whole decision back", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    const gate = await gateOf(draft.id);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-09-01" });

    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.approver1Id }),
      (e: unknown) => e instanceof ReleaseError,
    );
    assert.equal((await gateOf(draft.id)).status, "pending");
    assert.equal(await requestStatus(draft.id), "pending_approval");
    assert.equal(await decisionAuditCount(gate.id), 0);
    // Exactly the raced seed version exists — the rolled-back hire wrote no
    // second version and no 'created' event.
    const versions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from worker_employment_versions where employment_id = ${employmentId}
    `)).rows[0]!.n;
    assert.equal(versions, 1);
    assert.ok(!(await changeRows(employmentId)).some((c) => c.kind === "created"));
  });
});

test("withdrawal rules: draft and pending withdraw, terminals refuse", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);

    const draftOnly = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    const withdrawnDraft = await withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draftOnly.id, reason: "superseded" });
    assert.equal(withdrawnDraft.status, "withdrawn");
    assert.equal(withdrawnDraft.submittedBy, null, "a draft withdrawn before submission fabricates no stamps");

    const pending = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: pending.id, reason: "hire" });
    const pendingGate = await gateOf(pending.id);
    await assert.rejects(
      withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: pending.id, reason: "   " }),
      (e: unknown) => e instanceof HrmChangeRequestError,
      "a blank withdrawal reason is refused",
    );
    const withdrawnPending = await withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: pending.id, reason: "hiring freeze" });
    const withdrawalAudit = (await db.execute<{ changes: { event: string; reason: string; cancelledFlowRunId: string | null; before: { status: string } } }>(sql`
      select changes from audit_log
       where org_id = ${h.org.orgId} and table_name = 'hrm_employment_change_requests'
         and row_id = ${pending.id} and changes->>'event' = 'withdrawn'`)).rows;
    assert.equal(withdrawalAudit.length, 1, "withdrawal leaves exactly one audit row");
    assert.equal(withdrawalAudit[0]!.changes.reason, "hiring freeze");
    assert.equal(withdrawalAudit[0]!.changes.before.status, "pending_approval");
    assert.equal(withdrawalAudit[0]!.changes.cancelledFlowRunId, withdrawnPending.flowRunId, "the revoked run is named");
    assert.equal(withdrawnPending.status, "withdrawn");
    assert.ok(withdrawnPending.flowRunId, "the run is retained as evidence");
    const cancelledGate = (await db.execute<{ status: string }>(sql`
      select status from flow_gates where id = ${pendingGate.id}
    `)).rows[0]!.status;
    assert.equal(cancelledGate, "cancelled", "withdrawal cancels the dangling gate");

    // Terminal states never resurrect through withdraw.
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-09-01" });
    const toApprove = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "status_change", status: "suspended", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: toApprove.id, reason: "suspend" });
    await decideGate({ gateId: (await gateOf(toApprove.id)).id, decision: "approved", userId: h.approver1Id });
    await assert.rejects(
      withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: toApprove.id, reason: "test" }),
      (e: unknown) => e instanceof HrmChangeRequestError && /terminal/.test(e.message),
    );

    const toReject = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "status_change", status: "on_leave", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: toReject.id, reason: "leave" });
    await decideGate({ gateId: (await gateOf(toReject.id)).id, decision: "rejected", userId: h.approver1Id, comment: "no cover" });
    assert.equal(await requestStatus(toReject.id), "rejected");
    await assert.rejects(
      withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: toReject.id, reason: "test" }),
      (e: unknown) => e instanceof HrmChangeRequestError && /terminal/.test(e.message),
    );
  });
});

test("rejection writes the snapshot and no canonical rows", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });

    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "status_change", status: "suspended", effectiveFrom: "2026-01-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "suspend" });
    const gate = await gateOf(draft.id);
    const res = await decideGate({ gateId: gate.id, decision: "rejected", userId: h.approver1Id, comment: "appeal first" });
    assert.equal(res.ok, true);
    assert.equal(res.resumed, "reject");
    const rejected = await getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id });
    assert.equal(rejected.status, "rejected");
    assert.equal((rejected.decisionSnapshot!.gates as Array<{ decision: string }>)[0]!.decision, "rejected");
    assert.deepEqual((await changeRows(employmentId)).map((c) => c.kind), ["corrected"]);
  });
});

test("identity separation: the submitter cannot decide their own submission", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // The submitter is a routed approver here, so the refusal comes from
    // separation of duties — not from missing gate assignment.
    await seedFlow(h.org.orgId, h.submitterId);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    const gate = await gateOf(draft.id);
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.submitterId }),
      (e: unknown) => e instanceof GateError && /own submission/.test(e.message),
    );
    assert.equal((await gateOf(draft.id)).status, "pending");
    assert.equal(await requestStatus(draft.id), "pending_approval");
  });
});

test("identity separation: an approver with no linked person is refused with the remedy", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const unlinkedId = await createScratchUser(h.org.orgId, "HRM Ghost", "hrm_ghost");
    await grantPermissions(h.org.orgId, unlinkedId, ["hrm.employment.read", "hrm.employment.approve"]);
    await seedFlow(h.org.orgId, unlinkedId);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    const gate = await gateOf(draft.id);
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: unlinkedId }),
      (e: unknown) => {
        assert.ok(e instanceof ReleaseError, `expected ReleaseError, got ${String(e)}`);
        assert.match(e.message, /no linked person/);
        assert.match(e.message, /Admin → Users → Link person/);
        return true;
      },
    );
    assert.equal(await requestStatus(draft.id), "pending_approval");
    assert.equal(await decisionAuditCount(gate.id), 0);
  });
});

test("identity separation: the affected worker cannot approve their own change", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId, workerPartyId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    // The decider IS the subject worker behind a different login.
    await db.execute(sql`update users set party_id = ${workerPartyId} where id = ${h.approver2Id}`);
    await seedFlow(h.org.orgId, h.approver2Id);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    const gate = await gateOf(draft.id);
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.approver2Id }),
      (e: unknown) => {
        assert.ok(e instanceof ReleaseError, `expected ReleaseError, got ${String(e)}`);
        assert.match(e.message, /affected worker cannot approve/);
        return true;
      },
    );
    assert.equal(await requestStatus(draft.id), "pending_approval");
  });
});

test("submit without a configured flow is refused, never auto-approved", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await assert.rejects(
      submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" }),
      (e: unknown) => {
        assert.ok(e instanceof HrmChangeRequestError && e.code === "NO_FLOW");
        assert.match(e.message, /configure a flow/);
        return true;
      },
    );
    assert.equal(await requestStatus(draft.id), "draft", "a refused submit leaves the draft untouched");
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from flow_runs
       where subject_id = ${draft.id} and status <> 'cancelled'
    `)).rows[0]!.n;
    assert.equal(runs, 0);
  });
});

test("draft edits bump the revision and move the digest; submit freezes both", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "offered", effectiveFrom: "2026-09-01" },
    });
    assert.equal(draft.requestRevision, 1);
    const edited = await updateChangeRequestPayload({
      orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    assert.equal(edited.requestRevision, 2);
    assert.notEqual(edited.payloadDigest, draft.payloadDigest);
    await canonicalDigest(draft.id);
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    await assert.rejects(
      updateChangeRequestPayload({
        orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id,
        payload: { kind: "hire", status: "active", effectiveFrom: "2026-10-01" },
      }),
      (e: unknown) => e instanceof HrmChangeRequestError && /frozen/.test(e.message),
    );
  });
});

// OM-19: the drawer re-sends the stored payload on submit-for-approval
// without touching a field. That re-send used to bump request_revision on a
// touch-only row, the 0185 guard refused it, and the PATCH 500'd — so the
// submit POST never ran and the request sat at Draft revision 1. An
// unchanged canonical payload is now a touch: no write, no bump, and the
// submit that follows lands.
test("an unchanged draft edit is a touch: no revision bump, submit still works", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const payload = { kind: "hire", status: "offered", effectiveFrom: "2026-09-01" };
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload, action: "other", reasonCode: "correction",
    });
    assert.equal(draft.requestRevision, 1);
    const touched = await updateChangeRequestPayload({
      orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, payload,
    });
    assert.equal(touched.requestRevision, 1, "an unchanged edit never moves the revision");
    assert.equal(touched.payloadDigest, draft.payloadDigest, "an unchanged edit never rewrites the digest");
    const stored = await getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id });
    assert.equal(stored.requestRevision, 1, "read back from storage: still revision 1");
    const submitted = await submitChangeRequest({
      orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id,
      reason: "annual correction", action: "other", reasonCode: "correction",
    });
    assert.equal(submitted.status, "pending_approval", "the submit lands after the untouched save");
    assert.equal(await requestStatus(draft.id), "pending_approval");
  });
});

test("reads are org-scoped and employment-gated", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    // A user with no employment permission sees nothing, by refusal.
    await assert.rejects(
      getChangeRequest({ orgId: h.org.orgId, actorId: h.outsiderId, requestId: draft.id }),
      (e: unknown) => e instanceof Error,
    );
    await assert.rejects(
      listChangeRequests({ orgId: h.org.orgId, actorId: h.outsiderId }),
      (e: unknown) => e instanceof Error,
    );
    // An authorized reader lists and reads.
    const listed = await listChangeRequests({ orgId: h.org.orgId, actorId: h.submitterId, employmentId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, draft.id);
    // The driver hands timestamptz back as TEXT here; the DTO promises Date,
    // and the change-request queue called toISOString on a submitted row's
    // submittedAt and crashed. Once submitted, every timestamp is a Date.
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: draft.id, reason: "hire" });
    const submitted = (await listChangeRequests({ orgId: h.org.orgId, actorId: h.submitterId, employmentId }))[0]!;
    assert.ok(submitted.submittedAt instanceof Date && !Number.isNaN(submitted.submittedAt.getTime()), "submittedAt is a Date");
    assert.ok(submitted.createdAt instanceof Date, "createdAt is a Date");
    assert.ok(submitted.updatedAt instanceof Date, "updatedAt is a Date");
    assert.doesNotThrow(() => submitted.submittedAt!.toISOString());
    // Unknown ids and foreign orgs report uniformly not-found.
    await assert.rejects(
      getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: randomUUID() }),
      (e: unknown) => e instanceof HrmChangeRequestError && e.code === "NOT_FOUND",
    );
    const foreign = await createScratchOrg();
    try {
      await assert.rejects(
        getChangeRequest({ orgId: foreign.orgId, actorId: h.submitterId, requestId: draft.id }),
        (e: unknown) => e instanceof HrmChangeRequestError && e.code === "NOT_FOUND",
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

test("RLS hides one org's requests from another org's session", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    const foreign = await createScratchOrg();
    try {
      // Raw constrained sessions (no test bypass): the policy itself is the
      // oracle here, not the service's org predicate.
      const url = process.env.OPENBOOKS_RUNTIME_DB_URL || process.env.OPENBOOKS_DB_URL!;
      const countAs = async (orgId: string): Promise<number> => {
        const client = new Client({ connectionString: url });
        await client.connect();
        try {
          await client.query("select set_config('app.current_org', $1, false)", [orgId]);
          const res = await client.query("select count(*)::int as n from hrm_employment_change_requests where id = $1", [draft.id]);
          return res.rows[0].n as number;
        } finally {
          await client.end();
        }
      };
      assert.equal(await countAs(h.org.orgId), 1);
      assert.equal(await countAs(foreign.orgId), 0, "a foreign org session sees zero rows");
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

test("concurrent two-session apply: exactly one wins", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approver1Id);
    const { employmentId } = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01" });

    const first = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "status_change", status: "suspended", effectiveFrom: "2026-01-01" },
    });
    const second = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.submitterId, employmentId,
      payload: { kind: "status_change", status: "on_leave", effectiveFrom: "2026-01-01" },
    });
    assert.equal(first.expectedEmploymentRevision, second.expectedEmploymentRevision);
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: first.id, reason: "A" });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: second.id, reason: "B" });
    const gateA = await gateOf(first.id);
    const gateB = await gateOf(second.id);

    const outcomes = await Promise.allSettled([
      decideGate({ gateId: gateA.id, decision: "approved", userId: h.approver1Id }),
      decideGate({ gateId: gateB.id, decision: "approved", userId: h.approver1Id }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one decision lands");
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]!.reason instanceof ReleaseError && /expected revision/.test(String(rejected[0]!.reason)),
      `the loser is refused stale, got ${String(rejected[0]!.reason)}`,
    );

    const statuses = [await requestStatus(first.id), await requestStatus(second.id)].sort();
    assert.deepEqual(statuses, ["applied", "pending_approval"]);
    const appliedId = (await requestStatus(first.id)) === "applied" ? first.id : second.id;
    const applied = await getChangeRequest({ orgId: h.org.orgId, actorId: h.submitterId, requestId: appliedId });
    assert.equal(applied.appliedEmploymentRevision, 3);
    const revisions = (await db.execute<{ revision: number }>(sql`
      select revision from employment_changes
       where employment_id = ${employmentId} and revision = 3
    `)).rows;
    assert.equal(revisions.length, 1, "exactly one canonical event claims the new revision");
    // The loser retried after the fact still loses: its proposal is stale.
    const loserGate = appliedId === first.id ? gateB : gateA;
    await assert.rejects(
      decideGate({ gateId: loserGate.id, decision: "approved", userId: h.approver1Id }),
      (e: unknown) => e instanceof ReleaseError && /expected revision/.test(e.message),
    );
  });
});


