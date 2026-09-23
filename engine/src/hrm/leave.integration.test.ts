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
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { decideGate } from "../flows/gates.ts";
import { LeaveError } from "./leave-errors.ts";
import {
  cancelLeaveRequest,
  createLeavePolicy,
  createLeaveType,
  fileLeaveRequest,
  recordLeaveAttachment,
  submitLeaveRequest,
  withdrawLeaveRequest,
} from "./leave.ts";
import {
  getLeaveRequest,
  listOrgLeaveRequests,
  myLeaveRequests,
  timeBalanceAsOf,
} from "./leave-read.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { recordAbsence } from "./attendance.ts";
import {
  consumeLeavePayrollInputs,
  leavePayrollInputProblems,
  releaseLeavePayrollInputs,
  strandedLeavePayrollInputs,
} from "./leave-payroll-inputs.ts";

/**
 * HR-5 DB coverage (integration partition — run by the integrator at gate;
 * skips without OPENBOOKS_DB_URL): migration 0194 tables plus RLS, every
 * named refusal through the real code path, approve atomicity (absences
 * plus payroll inputs or nothing), the consume/release/problems/stranded
 * API including the void-AFTER-consume ordering, the RLS second-org case,
 * and the self-service scope.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone; every refusal asserts the writes that must NOT exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  employeeId: string;
  managerId: string;
  approverId: string;
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

async function linkPerson(orgId: string, userId: string, partyId?: string): Promise<string> {
  const id = partyId ?? randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const employeeId = await createScratchUser(org.orgId, "Leave Employee", "leave_employee");
  const managerId = await createScratchUser(org.orgId, "Leave Manager", "leave_manager");
  const approverId = await createScratchUser(org.orgId, "Leave Approver", "leave_approver");
  const outsiderId = await createScratchUser(org.orgId, "Leave Outsider", "leave_outsider");
  await grantPermissions(org.orgId, employeeId, ["hrm.leave.request"]);
  await grantPermissions(org.orgId, managerId, ["hrm.leave.read", "hrm.leave.manage"]);
  await grantPermissions(org.orgId, approverId, ["hrm.leave.read", "hrm.leave.approve"]);
  await linkPerson(org.orgId, managerId);
  await linkPerson(org.orgId, approverId);
  await linkPerson(org.orgId, outsiderId);
  return { org, employeeId, managerId, approverId, outsiderId };
}

/** Worker employment with one live version (no closures, no evidence rows). */
async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: { workerPartyId?: string; status?: string; from?: string; to?: string | null } = {},
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', 'Leave Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, ${opts.to ?? null}::date, now())
  `);
  return { employmentId, workerPartyId };
}

async function seedType(orgId: string, actorId: string, overrides: Record<string, unknown> = {}) {
  return createLeaveType({
    orgId,
    actorId,
    code: "VAC",
    name: "Vacation",
    paid: true,
    valueCrossing: "payout",
    ...overrides,
  });
}

async function seedPolicy(orgId: string, actorId: string, leaveTypeId: string, overrides: Record<string, unknown> = {}) {
  return createLeavePolicy({
    orgId,
    actorId,
    leaveTypeId,
    appliesTo: { employer_subsidiary_id: null, department_id: null },
    accrualRule: { kind: "per_year", hours: "120" },
    carryoverRule: { kind: "none" },
    minimumNoticeDays: 0,
    effectiveFrom: "2020-01-01",
    ...overrides,
  });
}

async function seedFlow(orgId: string, approverId: string): Promise<void> {
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_LEAVE_REQUEST_SUBJECT_KIND,
    assignees: [{ type: "user", userId: approverId }],
    mode: "any",
  });
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function gateOf(requestId: string): Promise<{ id: string; status: string }> {
  const rows = (await db.execute<{ id: string; status: string }>(sql`
    select id, status from flow_gates where subject_id = ${requestId} order by created_at
  `)).rows;
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return rows[0]!;
}

async function absencesOf(requestId: string): Promise<Array<{ on_date: string; hours: string; reversal_of: string | null }>> {
  const rows = (await db.execute<{ on_date: string; hours: string; reversal_of: string | null }>(sql`
    select on_date::text as on_date, hours::text as hours, reversal_of
      from hrm_absences where leave_request_id = ${requestId} or reversal_of in (
        select id from hrm_absences where leave_request_id = ${requestId}
      ) order by on_date
  `)).rows;
  return rows;
}

async function inputsOf(requestId: string): Promise<Array<{ absence_date: string; hours: string; status: string; consumed_by: string | null; kind: string; party: string }>> {
  const rows = (await db.execute<{
    absence_date: string; hours: string; status: string; consumed_by: string | null; kind: string; party: string;
  }>(sql`
    select absence_date::text as absence_date, hours::text as hours, status,
           consumed_by_run_document_id::text as consumed_by, kind,
           employee_party_id::text as party
      from hrm_payroll_inputs where source_leave_request_id = ${requestId} order by absence_date
  `)).rows;
  return rows;
}

async function assertLeaveRefusal(fn: () => Promise<unknown>, pattern: RegExp, absent: () => Promise<number>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof LeaveError, `expected a LeaveError, got ${String(error)}`);
    assert.match((error as Error).message, pattern);
    assert.equal(await absent(), 0, "a refused write leaves no rows behind");
    return error as Error;
  }
  assert.fail("expected the call to refuse");
}

test("0194 tables exist under org_isolation RLS with no amount column on inputs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    for (const table of ["hrm_leave_types", "hrm_leave_policies", "hrm_leave_requests", "hrm_absences", "hrm_payroll_inputs"]) {
      const policy = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_policies
         where schemaname = 'public' and tablename = ${table} and policyname = 'org_isolation'
      `)).rows[0]?.n ?? 0;
      assert.equal(policy, 1, `${table} carries the org_isolation policy`);
    }
    const amount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'public' and table_name = 'hrm_payroll_inputs' and column_name = 'amount'
    `)).rows[0]?.n ?? 0;
    assert.equal(amount, 0, "hrm_payroll_inputs carries no amount column: HR sends hours, the run resolves the rate");
    void h;
  });
});

test("org leave queue batches visible requests and refuses actors without the read grant", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId,
      actorId: h.employeeId,
      employmentId,
      leaveTypeId: type.id,
      startsOn: "2026-09-01",
      endsOn: "2026-09-01",
      hours: "8",
    });

    const visible = await listOrgLeaveRequests(db, h.org.orgId, h.managerId, { limit: 1 });
    assert.deepEqual(visible.requests.map((row) => row.id), [draft.id]);
    assert.equal(visible.truncated, false);
    await assert.rejects(
      listOrgLeaveRequests(db, h.org.orgId, h.outsiderId, { limit: 1 }),
      (error: unknown) => error instanceof HrmAuthorizationError && /hrm\.leave\.read/.test(error.message),
    );
  });
});

test("happy path: file → submit → decide → approved writes absences plus pending inputs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);

    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-03", hours: "24", reason: "rest",
    });
    assert.equal(draft.status, "draft");
    const submitted = await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    assert.equal(submitted.status, "submitted");
    assert.ok(submitted.flowInstanceId);

    const gate = await gateOf(draft.id);
    const decided = await decideGate({
      gateId: gate.id, decision: "approved", userId: h.approverId, comment: "approved — enjoy the break",
    });
    assert.equal(decided.ok, true);

    const read = await getLeaveRequest({ orgId: h.org.orgId, actorId: h.managerId, requestId: draft.id });
    assert.equal(read.status, "approved");
    assert.equal(read.decidedBy, h.approverId);

    const absences = await absencesOf(draft.id);
    assert.equal(absences.length, 3, "one absence row per day");
    assert.deepEqual(absences.map((a) => a.on_date), ["2026-09-01", "2026-09-02", "2026-09-03"]);
    // hours is numeric(9,2) in storage, so the text read carries the scale.
    assert.deepEqual(absences.map((a) => a.hours), ["8.00", "8.00", "8.00"]);

    const inputs = await inputsOf(draft.id);
    assert.equal(inputs.length, 3, "one pay-run input per absence day");
    for (const input of inputs) {
      assert.equal(input.status, "pending");
      assert.equal(input.kind, "payout");
      assert.equal(input.party, workerParty, "the ledger-read key is the employment's worker party");
    }

    const balance = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-09-04");
    assert.equal(balance.taken, "24");
    assert.equal(balance.balance, "96");
  });
});

test("submit refused outside live employment, with no rows written", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    // Version starts after the requested range: no live day.
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty, from: "2026-10-01" });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId, actorId: h.employeeId, employmentId,
        leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-02", hours: "16",
      }),
      /outside live employment/,
      async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_leave_requests where org_id = ${h.org.orgId}`)).rows[0]!.n,
    );
  });
});

test("submit refused on approved overlap and on insufficient time balance", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);

    const first = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-02", hours: "16",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: first.id });
    await decideGate({
      gateId: (await gateOf(first.id)).id, decision: "approved", userId: h.approverId,
      comment: "approved — enjoy the break",
    });

    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId, actorId: h.employeeId, employmentId,
        leaveTypeId: type.id, startsOn: "2026-09-02", endsOn: "2026-09-03", hours: "16",
      }),
      /overlaps approved request/,
      async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_leave_requests where org_id = ${h.org.orgId} and status = 'draft'`)).rows[0]!.n,
    );
    // 120 earned, 16 taken: 200 hours do not fit.
    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId, actorId: h.employeeId, employmentId,
        leaveTypeId: type.id, startsOn: "2026-11-01", endsOn: "2026-11-30", hours: "200",
      }),
      /time balance is .* but the request needs/,
      async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_leave_requests where org_id = ${h.org.orgId} and status = 'draft'`)).rows[0]!.n,
    );
  });
});

test("short notice refused to the worker, filed by the manager with a reason", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty, from: "2020-01-01" });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, { minimumNoticeDays: 30 });
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    void today;
    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId, actorId: h.employeeId, employmentId,
        leaveTypeId: type.id, startsOn: soon, endsOn: soon, hours: "8",
      }),
      /needs 30 days notice/,
      async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_leave_requests where org_id = ${h.org.orgId}`)).rows[0]!.n,
    );
    const managed = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.managerId, employmentId,
      leaveTypeId: type.id, startsOn: soon, endsOn: soon, hours: "8",
      reason: "family emergency cover", onBehalf: true,
    });
    assert.equal(managed.status, "draft");
  });
});

test("requires_attachment refused at submit until evidence is recorded", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none", requiresAttachment: true });
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    await assertLeaveRefusal(
      () => submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id }),
      /requires an attachment/,
      async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_leave_requests where id = ${draft.id} and status = 'submitted'`)).rows[0]!.n,
    );
    await recordLeaveAttachment({
      orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id, attachmentId: randomUUID(),
    });
    await seedFlow(h.org.orgId, h.approverId);
    const submitted = await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    assert.equal(submitted.status, "submitted");
  });
});

/** Minimal pay run plus stub, mirroring the payroll-context seed precedent. */
async function seedRun(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  partyId: string,
  opts: { runStatus: "calculated" | "committed"; docStatus: string; periodStart: string; periodEnd: string; number: string },
): Promise<string> {
  const scheduleId = randomUUID();
  // pay_schedules names are unique per org: one harness seeds several runs.
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${orgId}, ${`Biweekly ${opts.number}`}, 'biweekly', 26, '2026-06-28', 3, true, ${actorId}, ${actorId})`);
  const runId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${orgId}, ${runId}, 'pay_run', ${opts.number}, ${subsidiaryId}, ${opts.periodEnd}, 'CAD', ${opts.docStatus}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, created_by, updated_by)
    values (${runId}, ${orgId}, ${scheduleId}, ${opts.periodStart}, ${opts.periodEnd}, ${opts.periodEnd},
            2026, ${opts.runStatus}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province, periods_per_year,
                           pay_date, tax_year, currency_code, gross, created_by, updated_by)
    values (${orgId}, ${runId}, ${partyId}, 'BC', 26, ${opts.periodEnd}, 2026, 'CAD', '2000.00', ${actorId}, ${actorId})`);
  return runId;
}

async function approveThroughGate(orgId: string, approverId: string, requestId: string): Promise<void> {
  const gate = await gateOf(requestId);
  const decided = await decideGate({
    gateId: gate.id, decision: "approved", userId: approverId, comment: "approved — enjoy the break",
  });
  assert.equal(decided.ok, true);
}

async function rejectThroughGate(orgId: string, approverId: string, requestId: string): Promise<void> {
  const gate = await gateOf(requestId);
  const decided = await decideGate({
    gateId: gate.id, decision: "rejected", userId: approverId, comment: "rejected — cover needed that week",
  });
  assert.equal(decided.ok, true);
}

test("approval refused with the retro remedy when a committed run covers the day — and writes nothing", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-02", endsOn: "2026-09-02", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    // The run commits between submit and decide: history the approval must not rewrite.
    // Committed with the document approved-but-unposted (commitPayRun accepts
    // draft and approved documents; posting follows with its own journal
    // entry): posted would trip the unrelated documents_posted_period_required
    // CHECK, while the refusal under test keys on run_status alone.
    await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "committed", docStatus: "approved",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", number: "PAY-RETRO-1",
    });
    const gate = await gateOf(draft.id);
    let refusal: unknown = null;
    try {
      await decideGate({
        gateId: gate.id, decision: "approved", userId: h.approverId, comment: "approved — enjoy the break",
      });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, "the decision refuses");
    assert.match(String((refusal as Error)?.message ?? refusal), /retro/);
    const status = (await db.execute<{ status: string }>(sql`select status from hrm_leave_requests where id = ${draft.id}`)).rows[0]!.status;
    assert.equal(status, "submitted", "the throw rolled the decision back; the gate stays pending");
    assert.equal((await absencesOf(draft.id)).length, 0, "no absence without the decision");
    assert.equal((await inputsOf(draft.id)).length, 0, "no input without the decision");
  });
});

test("cancel voids pending inputs and reverses absences; committed consumption refuses", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);

    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-02", hours: "16",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    await approveThroughGate(h.org.orgId, h.approverId, draft.id);

    // An uncommitted run consumes, then the request cancels: void keeps the link.
    const runId = await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "calculated", docStatus: "draft",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", number: "PAY-OPEN-1",
    });
    const consumed = await consumeLeavePayrollInputs(db, {
      orgId: h.org.orgId, runDocumentId: runId,
      periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
    });
    assert.equal(consumed.length, 2);

    const cancelled = await cancelLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id, reason: "plans changed",
    });
    assert.equal(cancelled.status, "cancelled");
    const inputs = await inputsOf(draft.id);
    assert.ok(inputs.every((input) => input.status === "voided"), "pending and uncommitted-consumed rows flip to voided");
    assert.ok(inputs.every((input) => input.consumed_by === runId), "voiding never clears the run link");
    const absences = await absencesOf(draft.id);
    const net = absences.reduce((sum, row) => sum + Number(row.hours), 0);
    assert.equal(net, 0, "reversing rows net the days to zero without updating them");

    // The commit gate sees the stale calculation through the voided link.
    const problem = await leavePayrollInputProblems(db, {
      orgId: h.org.orgId, runDocumentId: runId,
      periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
    });
    assert.ok(problem, "a void after consume is a named refusal, not silence");
    assert.equal(problem!.code, "VOIDED_AFTER_CONSUME");
    assert.match(problem!.message, /recalculate/);

    // A second request, consumed by a COMMITTED run, cannot cancel.
    const second = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-10-01", endsOn: "2026-10-01", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: second.id });
    await approveThroughGate(h.org.orgId, h.approverId, second.id);
    // Approved-but-unposted like above: the cancel refusal keys on the
    // committed run_status, not on document posting.
    const committedId = await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "committed", docStatus: "approved",
      periodStart: "2026-10-01", periodEnd: "2026-10-15", number: "PAY-SHUT-1",
    });
    await consumeLeavePayrollInputs(db, {
      orgId: h.org.orgId, runDocumentId: committedId,
      periodStart: "2026-10-01", periodEnd: "2026-10-15", employeePartyIds: [workerParty],
    });
    try {
      await cancelLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: second.id, reason: "too late" });
      assert.fail("cancelling paid history must refuse");
    } catch (error) {
      assert.ok(error instanceof LeaveError);
      assert.match((error as Error).message, /retro/);
    }
    const still = (await db.execute<{ status: string }>(sql`select status from hrm_leave_requests where id = ${second.id}`)).rows[0]!.status;
    assert.equal(still, "approved", "the refused cancellation changes nothing");
  });
});

test("withdraw ends drafts and in-flight approvals; the gate cannot release after", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id);

    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    const withdrawn = await withdrawLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id, reason: "no longer needed",
    });
    assert.equal(withdrawn.status, "withdrawn");

    const second = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-10-01", endsOn: "2026-10-01", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: second.id });
    const gate = await gateOf(second.id);
    await withdrawLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, requestId: second.id, reason: "dates wrong",
    });
    const gateStatus = (await db.execute<{ status: string }>(sql`select status from flow_gates where id = ${gate.id}`)).rows[0]!.status;
    assert.equal(gateStatus, "cancelled", "no dangling gate can later release the request");
  });
});

test("consume is idempotent per run, refuses foreign runs and stale parties; release counts", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-02", hours: "16",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    await approveThroughGate(h.org.orgId, h.approverId, draft.id);

    const runA = await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "calculated", docStatus: "draft",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", number: "PAY-A-1",
    });
    const first = await consumeLeavePayrollInputs(db, {
      orgId: h.org.orgId, runDocumentId: runA,
      periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
    });
    assert.equal(first.length, 2);
    // Recalculate is safe to repeat: same rows, same run.
    const again = await consumeLeavePayrollInputs(db, {
      orgId: h.org.orgId, runDocumentId: runA,
      periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
    });
    assert.deepEqual(again.map((row) => row.id).sort(), first.map((row) => row.id).sort());

    // Another run's rows are never absorbed.
    const runB = await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "calculated", docStatus: "draft",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", number: "PAY-B-1",
    });
    try {
      await consumeLeavePayrollInputs(db, {
        orgId: h.org.orgId, runDocumentId: runB,
        periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
      });
      assert.fail("a foreign run's rows must never be absorbed");
    } catch (error) {
      assert.ok(error instanceof LeaveError);
      assert.match((error as Error).message, new RegExp(runA));
    }

    // Stranded lists rows a live-but-uncommitted run still holds.
    const stranded = await strandedLeavePayrollInputs(db, h.org.orgId);
    assert.equal(stranded.length, 2);

    // Release returns the count; a second release is a legitimate zero.
    assert.equal(await releaseLeavePayrollInputs(db, { orgId: h.org.orgId, runDocumentId: runA }), 2);
    assert.equal(await releaseLeavePayrollInputs(db, { orgId: h.org.orgId, runDocumentId: runA }), 0);
    assert.equal((await strandedLeavePayrollInputs(db, h.org.orgId)).length, 0);

    // A stale party (simulating a merged worker the request predates) refuses by name.
    // A bare party row, never linked to a login: the point is the mismatch, not the person.
    const stranger = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${stranger}, ${h.org.orgId}, 'person', 'Stranger', true, '{}'::jsonb)
    `);
    await db.execute(sql`
      update hrm_payroll_inputs set employee_party_id = ${stranger}
       where org_id = ${h.org.orgId} and source_leave_request_id = ${draft.id} and status = 'pending'
    `);
    try {
      await consumeLeavePayrollInputs(db, {
        orgId: h.org.orgId, runDocumentId: runA,
        periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [stranger],
      });
      assert.fail("a stale party must refuse by name");
    } catch (error) {
      assert.ok(error instanceof LeaveError);
      assert.match((error as Error).message, /now points at party/);
    }
  });
});

test("commit gate refuses pending rows until the run consumes them", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    await approveThroughGate(h.org.orgId, h.approverId, draft.id);
    const runId = await seedRun(h.org.orgId, h.managerId, h.org.subsidiaryId, workerParty, {
      runStatus: "calculated", docStatus: "draft",
      periodStart: "2026-09-01", periodEnd: "2026-09-15", number: "PAY-G-1",
    });
    const scope = {
      orgId: h.org.orgId, runDocumentId: runId,
      periodStart: "2026-09-01", periodEnd: "2026-09-15", employeePartyIds: [workerParty],
    };
    const pending = await leavePayrollInputProblems(db, scope);
    assert.ok(pending, "an unconsumed day blocks the commit");
    assert.equal(pending!.code, "PENDING_INPUTS");
    assert.match(pending!.message, /recalculate/);
    await consumeLeavePayrollInputs(db, scope);
    assert.equal(await leavePayrollInputProblems(db, scope), null, "a fully consumed period gates clean");
  });
});

test("RLS: a foreign org session sees zero leave rows", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
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
          const res = await client.query("select count(*)::int as n from hrm_leave_requests where id = $1", [draft.id]);
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

test("self-service scope: an employee reads only their own requests", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const partyA = await linkPerson(h.org.orgId, h.employeeId);
    const empA = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: partyA });
    const employeeB = await createScratchUser(h.org.orgId, "Leave Employee Two", "leave_employee_two");
    const partyB = await linkPerson(h.org.orgId, employeeB);
    const empB = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: partyB });
    await grantPermissions(h.org.orgId, employeeB, ["hrm.leave.request"]);
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id);

    const mine = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId: empA.employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    const theirs = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: employeeB, employmentId: empB.employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-02", endsOn: "2026-09-02", hours: "8",
    });
    const inboxB = await myLeaveRequests({ orgId: h.org.orgId, actorId: employeeB });
    assert.deepEqual(inboxB.map((row) => row.id), [theirs.id], "another employee's request never lists");
    const inboxA = await myLeaveRequests({ orgId: h.org.orgId, actorId: h.employeeId });
    assert.deepEqual(inboxA.map((row) => row.id), [mine.id]);
    try {
      await getLeaveRequest({ orgId: h.org.orgId, actorId: employeeB, requestId: mine.id });
      assert.fail("reading another worker's request must refuse");
    } catch (error) {
      assert.match(String((error as Error)?.message ?? error), /own employment|requires the hrm\.leave\.read/);
    }
    // Filing against another employment refuses even with the request grant.
    try {
      await fileLeaveRequest({
        orgId: h.org.orgId, actorId: employeeB, employmentId: empA.employmentId,
        leaveTypeId: type.id, startsOn: "2026-09-05", endsOn: "2026-09-05", hours: "8",
      });
      assert.fail("filing against another employment must refuse");
    } catch (error) {
      assert.match(String((error as Error)?.message ?? error), /own employment/);
    }
  });
});

test("rejected requests decide with a reason and write no absences or inputs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: draft.id });
    await rejectThroughGate(h.org.orgId, h.approverId, draft.id);
    const read = await getLeaveRequest({ orgId: h.org.orgId, actorId: h.managerId, requestId: draft.id });
    assert.equal(read.status, "rejected");
    assert.equal(read.decisionReason, "rejected — cover needed that week");
    assert.equal((await absencesOf(draft.id)).length, 0, "a rejection writes no absence");
    assert.equal((await inputsOf(draft.id)).length, 0, "a rejection writes no pay input");
  });
});

test("after-the-fact recording writes the absence record and never a pay input", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId);
    await seedPolicy(h.org.orgId, h.managerId, type.id);
    const recorded = await recordAbsence({
      orgId: h.org.orgId, actorId: h.managerId, employmentId,
      onDate: "2026-08-15", hours: "8", leaveTypeId: type.id,
    });
    assert.equal(recorded.source, "recorded");
    const rows = (await db.execute<{ source: string }>(sql`
      select source from hrm_absences where id = ${recorded.id}
    `)).rows;
    assert.equal(rows[0]!.source, "recorded");
    assert.equal((await inputsOf(recorded.id)).length, 0, "recorded rows raise no pay-run input: value crosses only through approval");
    try {
      await recordAbsence({
        orgId: h.org.orgId, actorId: h.managerId, employmentId,
        onDate: "2026-08-15", hours: "4", leaveTypeId: type.id,
      });
      assert.fail("double-recording a day must refuse");
    } catch (error) {
      assert.ok(error instanceof LeaveError);
      assert.match((error as Error).message, /already recorded/);
    }
  });
});

test("mid-year policy change accrues per segment, never the current rule backdated", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_period", hours: "8", periods_per_year: 12 },
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_period", hours: "16", periods_per_year: 12 },
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
    });
    const december = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-12-31");
    // 6 × 8 + 6 × 16: pricing the December rule from January would read 192.
    assert.equal(december.earned, "144");
    assert.equal(december.balance, "144");
    assert.equal(december.policyId !== null, true);
  });
});

test("same-scope overlapping policies refuse by name; other scopes and adjacent windows stay legal", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "120" },
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    });
    await assertLeaveRefusal(
      () => seedPolicy(h.org.orgId, h.managerId, type.id, {
        accrualRule: { kind: "per_year", hours: "80" },
        effectiveFrom: "2026-06-01",
        effectiveTo: null,
      }),
      /already covers this leave type and scope/,
      async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_leave_policies
         where org_id = ${h.org.orgId} and leave_type_id = ${type.id}
           and (accrual_rule->>'hours') = '80'
      `)).rows[0]?.n ?? 0,
    );
    // Adjacent windows share no day and stay legal.
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "80" },
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
    });
    // The same window pinned to a department is a different scope.
    const departmentId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${h.org.orgId}, 'Crew')`);
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      appliesTo: { employer_subsidiary_id: null, department_id: departmentId },
      accrualRule: { kind: "per_year", hours: "40" },
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    });
    // Storage arbitrates what the service never sees: a raw overlapping
    // insert dies on the exclusion, never as a second readable window.
    try {
      await db.execute(sql`
        insert into hrm_leave_policies (org_id, leave_type_id, effective_from, effective_to)
        values (${h.org.orgId}, ${type.id}, '2026-03-01', '2026-04-01')
      `);
      assert.fail("a raw overlapping insert must die on the exclusion");
    } catch (error) {
      // db.execute wraps the PG error: the exclusion code rides on cause.
      const pgCode = (error as { code?: string }).code
        ?? (error as { cause?: { code?: string } }).cause?.code;
      assert.equal(pgCode, "23P01");
    }
    const windows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_leave_policies
       where org_id = ${h.org.orgId} and leave_type_id = ${type.id} and is_active
    `)).rows[0]?.n ?? 0;
    assert.equal(windows, 3, "only the three legal windows exist: two adjacent org-wide plus the department pin");
  });
});

/** Primary assignment pinning the employment to a department from 2020 on. */
async function seedDepartmentAssignment(orgId: string, employmentId: string, departmentId: string): Promise<void> {
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Crew Hand', ${departmentId}, 1, true, '2020-01-01')
  `);
}

/** Civil date n days after today (UTC) — notice tests stay relative, never stale. */
function daysFromNow(n: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

test("a department-only policy covers its department worker at file time", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const departmentId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${h.org.orgId}, 'Crew')`);
    await seedDepartmentAssignment(h.org.orgId, employmentId, departmentId);
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    // No org-wide policy at all: the department pin is the only coverage.
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      appliesTo: { employer_subsidiary_id: null, department_id: departmentId },
      accrualRule: { kind: "per_year", hours: "40" },
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    // The null-department gate read this worker as uncovered and refused.
    const draft = await fileLeaveRequest({
      orgId: h.org.orgId,
      actorId: h.employeeId,
      employmentId,
      leaveTypeId: type.id,
      startsOn: "2026-09-01",
      endsOn: "2026-09-01",
      hours: "8",
    });
    assert.equal(draft.status, "draft");
  });
});

test("org-wide unlimited never launders a department cap at file time", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const departmentId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${h.org.orgId}, 'Crew')`);
    await seedDepartmentAssignment(h.org.orgId, employmentId, departmentId);
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "unlimited" },
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      appliesTo: { employer_subsidiary_id: null, department_id: departmentId },
      accrualRule: { kind: "per_year", hours: "8" },
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    // 40 hours against an 8-hour department cap refuses; the null-department
    // gate early-returned on org-wide unlimited and filed it.
    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId,
        actorId: h.employeeId,
        employmentId,
        leaveTypeId: type.id,
        startsOn: "2026-09-01",
        endsOn: "2026-09-05",
        hours: "40",
      }),
      /policy time balance is 8 hours but the request needs 40/,
      async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_leave_requests
         where org_id = ${h.org.orgId} and employment_id = ${employmentId}
      `)).rows[0]?.n ?? 0,
    );
    const within = await fileLeaveRequest({
      orgId: h.org.orgId,
      actorId: h.employeeId,
      employmentId,
      leaveTypeId: type.id,
      startsOn: "2026-09-01",
      endsOn: "2026-09-01",
      hours: "8",
    });
    assert.equal(within.status, "draft");
  });
});

test("a department minimum notice binds its workers at file time", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const departmentId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${h.org.orgId}, 'Crew')`);
    await seedDepartmentAssignment(h.org.orgId, employmentId, departmentId);
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "120" },
      minimumNoticeDays: 0,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      appliesTo: { employer_subsidiary_id: null, department_id: departmentId },
      accrualRule: { kind: "per_year", hours: "120" },
      minimumNoticeDays: 5,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    // Three days notice against a five-day department rule refuses; the
    // null-department gate read the org-wide zero and filed it.
    await assertLeaveRefusal(
      () => fileLeaveRequest({
        orgId: h.org.orgId,
        actorId: h.employeeId,
        employmentId,
        leaveTypeId: type.id,
        startsOn: daysFromNow(3),
        endsOn: daysFromNow(3),
        hours: "8",
      }),
      /needs 5 days notice/,
      async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_leave_requests
         where org_id = ${h.org.orgId} and employment_id = ${employmentId}
      `)).rows[0]?.n ?? 0,
    );
  });
});

test("concurrent approvals cannot spend one entitlement twice", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "8" },
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    // Two 8-hour requests on different days against an 8-hour grant: both
    // file and submit cleanly (nothing is spent until approval), then both
    // approve at once. Row locks are per request, so only the entitlement
    // lock plus the approval-time recheck can stop the double spend.
    const first = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-01", endsOn: "2026-09-01", hours: "8",
    });
    const second = await fileLeaveRequest({
      orgId: h.org.orgId, actorId: h.employeeId, employmentId,
      leaveTypeId: type.id, startsOn: "2026-09-02", endsOn: "2026-09-02", hours: "8",
    });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: first.id });
    await submitLeaveRequest({ orgId: h.org.orgId, actorId: h.employeeId, requestId: second.id });
    const gate1 = await gateOf(first.id);
    const gate2 = await gateOf(second.id);
    const outcomes = await Promise.allSettled([
      decideGate({ gateId: gate1.id, decision: "approved", userId: h.approverId, comment: "first concurrent approval" }),
      decideGate({ gateId: gate2.id, decision: "approved", userId: h.approverId, comment: "second concurrent approval" }),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one concurrent approval lands");
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1, "the loser refuses instead of overspending");
    const loser = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    const message = String(loser.reason?.message ?? "");
    assert.match(message, /policy time balance is 0 hours but the request needs 8/);
    assert.doesNotMatch(message, /23P01|exclusion|SQLSTATE/i);
    const firstRead = await getLeaveRequest({ orgId: h.org.orgId, actorId: h.managerId, requestId: first.id });
    const secondRead = await getLeaveRequest({ orgId: h.org.orgId, actorId: h.managerId, requestId: second.id });
    assert.deepEqual(
      [firstRead.status, secondRead.status].sort(),
      ["approved", "submitted"],
      "the winner approves, the loser stays submitted with its gate pending",
    );
    const taken = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-12-31");
    assert.equal(taken.taken, "8", "one entitlement spent once");
    assert.equal(taken.balance, "0", "no negative balance from the lost race");
  });
});

test("carryover is earned under the prior-year policy, not the successor", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const workerParty = await linkPerson(h.org.orgId, h.employeeId);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: workerParty });
    const type = await seedType(h.org.orgId, h.managerId, { valueCrossing: "none" });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "40" },
      carryoverRule: { kind: "carry_all" },
      effectiveFrom: "2020-01-01",
      effectiveTo: "2025-12-31",
    });
    await seedPolicy(h.org.orgId, h.managerId, type.id, {
      accrualRule: { kind: "per_year", hours: "120" },
      carryoverRule: { kind: "none" },
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    });
    const june = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-01");
    // Prior-year 40 unused carries under the 2025 rule; the 2026 successor
    // reaching back would carry zero and drop the entitlement.
    assert.equal(june.earned, "120");
    assert.equal(june.carried, "40");
    assert.equal(june.balance, "160");
  });
});
