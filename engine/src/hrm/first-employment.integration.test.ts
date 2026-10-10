import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedActiveEmployment,
} from "../testing/fixtures.ts";
import {
  DB,
  gateOf,
  refusalOf,
  setupHarness,
  withHarness,
  seedEmployment,
  seedFlow,
} from "../testing/hrm-harness.ts";
import { findEmploymentsByParty } from "./employment-read.ts";
import { listOwnLeaveEmploymentOptions } from "./leave-read.ts";
import { HrmChangeRequestError, withdrawChangeRequest } from "./change-requests.ts";
import { decideGate } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";
import { proposeFirstEmployment } from "./first-employment.ts";

// Gate releases run through the installed engine seams; without this the
// approval gates strand on a not-registered refusal instead of releasing.
installEngineSeams();

/**
 * First-employment (Hire) DB coverage (integration partition): a fresh
 * company's first hire for an employee party with no employment — the
 * reserved identity plus a hire through the native change-request
 * service, audited and effective-dated.
 *
 * Proofs are read back from storage, never from the service's return
 * values alone: the first effective version, the created change event,
 * the aggregate revision, the decision snapshot, and the identity audit
 * row. Refusals assert the writes that must NOT exist. The Me/leave path
 * is proven through the native reads the drawers use: the party's
 * employment list and the worker's own leave-employment options.
 */

const FIRST_EMPLOYMENT_SPEC = {
  features: ["hrm"],
  users: [
    { key: "hrId", name: "HR Hiring Manager", handle: "hr_hire", permissions: ["hrm.employment.read", "hrm.employment.manage"], link: true },
    { key: "approverId", name: "HR Hire Approver", handle: "hr_hire_approver", permissions: ["hrm.employment.read", "hrm.employment.approve"], link: true },
    { key: "workerId", name: "New Worker Login", handle: "new_worker", permissions: ["hrm.leave.request"] },
  ],
} as const;

/** An active person party holding the employee role — the roster side of a hire, without any employment. */
async function seedEmployeeParty(orgId: string, displayName: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${displayName}, true, '{}'::jsonb)
  `);
  await seedActiveEmployment(orgId, partyId, "2026-01-01");
  return partyId;
}

/** Bind a login to the hired person, as Admin → Users → Link person does. */
async function linkWorkerLogin(orgId: string, userId: string, partyId: string): Promise<void> {
  const updated = (await db.execute(sql`
    update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId} returning id
  `)).rows;
  assert.equal(updated.length, 1, "the worker login links to the hired person");
}

async function employmentCount(orgId: string, partyId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
  `)).rows;
  return rows[0]?.n ?? 0;
}

async function hireRequestCount(orgId: string, partyId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_employment_change_requests r
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
     where r.org_id = ${orgId} and e.worker_party_id = ${partyId}
  `)).rows;
  return rows[0]?.n ?? 0;
}

async function liveVersions(employmentId: string): Promise<Array<{ no: number; status: string }>> {
  const rows = (await db.execute<{ no: number; status: string }>(sql`
    select version_no as no, status from worker_employment_versions
     where employment_id = ${employmentId} and recorded_until is null order by version_no
  `)).rows;
  return rows;
}

/** A flow with the apply-without-approval outcome: the governed direct path. */
async function seedDirectHirePolicy(orgId: string): Promise<string> {
  const id = randomUUID();
  const graph = { schemaVersion: 1, ungatedOutcome: "apply", nodes: [{ id: "submit", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } }], edges: [] };
  await db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph) values (${id}, ${orgId}, 'Direct hires', 'hrm_employment_change_request', true, ${JSON.stringify(graph)}::jsonb)`);
  return id;
}

async function identityAuditCount(orgId: string, employmentId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'worker_employments' and row_id = ${employmentId} and action = 'insert'
  `)).rows;
  return rows[0]?.n ?? 0;
}

test("first hire under an apply-without-approval flow applies at once with an automatic snapshot", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(FIRST_EMPLOYMENT_SPEC), async (h) => {
    const flowId = await seedDirectHirePolicy(h.org.orgId);
    const partyId = await seedEmployeeParty(h.org.orgId, "First Hire");
    await linkWorkerLogin(h.org.orgId, h.workerId, partyId);

    // Before the hire the native reads agree there is nothing to attach to.
    assert.deepEqual(await findEmploymentsByParty({ orgId: h.org.orgId, actorId: h.hrId, workerPartyId: partyId }), []);
    assert.deepEqual(await listOwnLeaveEmploymentOptions({ orgId: h.org.orgId, actorId: h.workerId }), []);

    const hire = await proposeFirstEmployment({
      orgId: h.org.orgId,
      actorId: h.hrId,
      workerPartyId: partyId,
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "founding engineer joins as the first employee",
    });
    assert.equal(hire.status, "applied");
    assert.equal(hire.applied, true);
    assert.equal(hire.workerPartyId, partyId);

    // The first effective version is readable through storage, not just the return value.
    assert.deepEqual(await liveVersions(hire.employmentId), [{ no: 1, status: "active" }]);
    const changes = (await db.execute<{ kind: string; revision: number }>(sql`
      select change_kind as kind, revision from employment_changes where employment_id = ${hire.employmentId}
    `)).rows;
    assert.deepEqual(changes, [{ kind: "created", revision: 2 }]);
    const revision = (await db.execute<{ revision: number }>(sql`
      select revision from worker_employments where id = ${hire.employmentId}
    `)).rows[0]!.revision;
    assert.equal(revision, 2);
    // Direct application stays evidenced: the automatic snapshot pins the
    // permitting flow, plus the identity audit row with actor and reason.
    const snapshot = (await db.execute<{ snapshot: { mode: string; gates: unknown[]; policy: { flowId: string } } }>(sql`
      select decision_snapshot as snapshot from hrm_employment_change_requests where id = ${hire.changeRequestId}
    `)).rows[0]!.snapshot;
    assert.equal(snapshot.mode, "automatic");
    assert.deepEqual(snapshot.gates, []);
    assert.equal(snapshot.policy.flowId, flowId);
    assert.equal(await identityAuditCount(h.org.orgId, hire.employmentId), 1);

    // The Me/leave path is now available through the native reads.
    assert.deepEqual(await findEmploymentsByParty({ orgId: h.org.orgId, actorId: h.hrId, workerPartyId: partyId }), [hire.employmentId]);
    const options = await listOwnLeaveEmploymentOptions({ orgId: h.org.orgId, actorId: h.workerId });
    assert.deepEqual(options.map((option) => option.employmentId), [hire.employmentId]);
  });
});

test("first hire with no configured flow refuses NO_FLOW and stores nothing", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(FIRST_EMPLOYMENT_SPEC), async (h) => {
    const partyId = await seedEmployeeParty(h.org.orgId, "Flowless Hire");

    // The lifecycle admits no ungated application: the refusal names the
    // remedy (configure the flow, then hire) and the single transaction
    // rolls the reserved identity and the draft back with it.
    const refused = await refusalOf(
      proposeFirstEmployment({
        orgId: h.org.orgId,
        actorId: h.hrId,
        workerPartyId: partyId,
        employerSubsidiaryId: h.org.subsidiaryId,
        effectiveFrom: "2026-09-01",
        reason: "hire without any flow configured",
      }),
      HrmChangeRequestError,
    );
    assert.equal(refused.code, "NO_FLOW");
    assert.match(refused.message, /approval flow|apply-without-approval/);
    assert.equal(await employmentCount(h.org.orgId, partyId), 0, "a refused hire stores no identity");
    assert.equal(await hireRequestCount(h.org.orgId, partyId), 0, "a refused hire files no request");

    // Once the flow exists the same hire succeeds — nothing to clean up first.
    await seedFlow(h.org.orgId, h.approverId);
    const hire = await proposeFirstEmployment({
      orgId: h.org.orgId,
      actorId: h.hrId,
      workerPartyId: partyId,
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "hire after configuring the approval flow",
    });
    assert.equal(hire.status, "pending_approval");
    assert.equal(await employmentCount(h.org.orgId, partyId), 1);
  });
});

test("first hire with a configured flow waits for approval, then applies the same first version", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(FIRST_EMPLOYMENT_SPEC), async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const partyId = await seedEmployeeParty(h.org.orgId, "Gated Hire");
    await linkWorkerLogin(h.org.orgId, h.workerId, partyId);

    const hire = await proposeFirstEmployment({
      orgId: h.org.orgId,
      actorId: h.hrId,
      workerPartyId: partyId,
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "second engineer joins under the approval flow",
    });
    assert.equal(hire.status, "pending_approval");
    assert.equal(hire.applied, false);
    // Nothing effective yet: the employment answers no as-of read.
    assert.deepEqual(await liveVersions(hire.employmentId), []);

    const gate = await gateOf(hire.changeRequestId);
    const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: h.approverId });
    assert.equal(decided.ok, true);
    assert.deepEqual(await liveVersions(hire.employmentId), [{ no: 1, status: "active" }]);

    const options = await listOwnLeaveEmploymentOptions({ orgId: h.org.orgId, actorId: h.workerId });
    assert.deepEqual(options.map((option) => option.employmentId), [hire.employmentId]);
  });
});

test("a withdrawn gated hire retries onto the same reserved identity", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(FIRST_EMPLOYMENT_SPEC), async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const partyId = await seedEmployeeParty(h.org.orgId, "Retried Hire");

    const first = await proposeFirstEmployment({
      orgId: h.org.orgId,
      actorId: h.hrId,
      workerPartyId: partyId,
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "filed against the wrong start date",
    });
    assert.equal(first.status, "pending_approval");

    // A second proposal while the first is open refuses instead of doubling the queue.
    const doubled = await refusalOf(
      proposeFirstEmployment({
        orgId: h.org.orgId,
        actorId: h.hrId,
        workerPartyId: partyId,
        employerSubsidiaryId: h.org.subsidiaryId,
        effectiveFrom: "2026-09-01",
        reason: "accidental double file",
      }),
      HrmChangeRequestError,
    );
    assert.equal(doubled.code, "BAD_STATE");
    assert.match(doubled.message, /already open/);

    await withdrawChangeRequest({ orgId: h.org.orgId, actorId: h.hrId, requestId: first.changeRequestId, reason: "wrong start date" });

    const retry = await proposeFirstEmployment({
      orgId: h.org.orgId,
      actorId: h.hrId,
      workerPartyId: partyId,
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-10-01",
      reason: "refiled with the corrected start date",
    });
    assert.equal(retry.employmentId, first.employmentId, "the retry reuses the reserved identity");
    assert.equal(await employmentCount(h.org.orgId, partyId), 1);
  });
});

test("first hire refusals name the field and write nothing", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(FIRST_EMPLOYMENT_SPEC), async (h) => {
    const hire = (overrides: Record<string, unknown>) =>
      proposeFirstEmployment({
        orgId: h.org.orgId,
        actorId: h.hrId,
        workerPartyId: overrides.workerPartyId as string,
        employerSubsidiaryId: (overrides.employerSubsidiaryId ?? h.org.subsidiaryId) as string,
        effectiveFrom: (overrides.effectiveFrom ?? "2026-09-01") as string,
        reason: (overrides.reason ?? "a reason") as string,
      });

    // A person who already holds an active employment cannot be hired again.
    const employed = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Already Employed" });
    await seedActiveEmployment(h.org.orgId, employed.workerPartyId, "2026-01-01");
    const duplicate = await refusalOf(hire({ workerPartyId: employed.workerPartyId }), HrmChangeRequestError);
    assert.equal(duplicate.code, "BAD_STATE");
    assert.match(duplicate.message, /already has an active employment/);

    // Missing required fields refuse up front, before any identity exists.
    const partyId = await seedEmployeeParty(h.org.orgId, "Untouchable");
    const blankReason = await refusalOf(
      hire({ workerPartyId: partyId, reason: "   " }),
      HrmChangeRequestError,
    );
    assert.equal(blankReason.code, "INVALID_PAYLOAD");
    assert.match(blankReason.message, /reason/);
    const badDate = await refusalOf(
      hire({ workerPartyId: partyId, effectiveFrom: "2026-13-40" }),
      HrmChangeRequestError,
    );
    assert.equal(badDate.code, "INVALID_PAYLOAD");
    assert.match(badDate.message, /effectiveFrom/);
    const terminated = await refusalOf(
      proposeFirstEmployment({
        orgId: h.org.orgId,
        actorId: h.hrId,
        workerPartyId: partyId,
        employerSubsidiaryId: h.org.subsidiaryId,
        status: "terminated",
        effectiveFrom: "2026-09-01",
        reason: "cannot hire terminated",
      }),
      HrmChangeRequestError,
    );
    assert.equal(terminated.code, "INVALID_PAYLOAD");
    const unknownEntity = await refusalOf(
      hire({ workerPartyId: partyId, employerSubsidiaryId: randomUUID() }),
      HrmChangeRequestError,
    );
    assert.equal(unknownEntity.code, "INVALID_PAYLOAD");
    assert.match(unknownEntity.message, /legal entity/);
    const unknownPerson = await refusalOf(hire({ workerPartyId: randomUUID() }), HrmChangeRequestError);
    assert.equal(unknownPerson.code, "NOT_FOUND");

    // A person without the employee role is roster, not staff.
    const stranger = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${stranger}, ${h.org.orgId}, 'person', 'No Role', true, '{}'::jsonb)
    `);
    const noRole = await refusalOf(hire({ workerPartyId: stranger }), HrmChangeRequestError);
    assert.equal(noRole.code, "REFUSED");
    assert.match(noRole.message, /employee role/);

    assert.equal(await employmentCount(h.org.orgId, partyId), 0, "refused hires store no identity");
    assert.equal(await hireRequestCount(h.org.orgId, partyId), 0, "refused hires file no request");
  });
});

test("first hire is org-isolated: another org's party and entity refuse", { skip: !DB }, async () => {
  const first = await createScratchOrg();
  const second = await createScratchOrg();
  try {
    const partyId = await seedEmployeeParty(first.orgId, "Cross Org");
    const crossParty = await refusalOf(
      proposeFirstEmployment({
        orgId: second.orgId,
        actorId: "00000000-0000-0000-0000-000000000000",
        workerPartyId: partyId,
        employerSubsidiaryId: second.subsidiaryId,
        effectiveFrom: "2026-09-01",
        reason: "cross-org hire",
      }),
      HrmChangeRequestError,
    );
    assert.equal(crossParty.code, "NOT_FOUND");
    assert.equal(await employmentCount(second.orgId, partyId), 0);
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});
