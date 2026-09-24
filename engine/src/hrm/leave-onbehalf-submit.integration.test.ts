import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
} from "../testing/fixtures.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import {
  createLeavePolicy,
  createLeaveType,
  fileLeaveRequest,
  submitLeaveRequest,
  withdrawLeaveRequest,
} from "./leave.ts";

/**
 * OM-11 regression: leave filed on behalf of an employee could not be
 * submitted. Every request transition inferred on-behalf-ness from
 * created_by (filer !== actor), so a manager who filed for their report
 * created a draft they themselves could not submit — submit fell into
 * the self-service path and refused 403 against the report's employment.
 *
 * Transitions now authorize by TARGET: the actor is the request's own
 * employee (self-service), or holds hrm.leave.manage over the target
 * employment in scope (on-behalf). created_by never decides the path —
 * it stays what it is, the audit trail of who parked the draft beside
 * the subject employment_id. Proofs run the service through filing to
 * submission (a seeded approval flow gates submit).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function scopeRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function seedEmployment(orgId: string, subsidiaryId: string, workerPartyId: string): Promise<string> {
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())`);
  return employmentId;
}

test("OM-11: a manager-created on-behalf draft submits; scope still refuses", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const quinnId = await createScratchUser(org.orgId, "Quinn Vidal", "om11_quinn");
    const anaId = await createScratchUser(org.orgId, "Ana Manager", "om11_ana");
    const approverId = await createScratchUser(org.orgId, "Leave Approver", "om11_approver");
    const scopedOutId = await createScratchUser(org.orgId, "Scoped Out", "om11_scoped_out");
    const strangerId = await createScratchUser(org.orgId, "Stranger", "om11_stranger");
    await grantPermissions(org.orgId, quinnId, ["hrm.leave.request"]);
    await grantPermissions(org.orgId, anaId, ["hrm.leave.read", "hrm.leave.manage"]);
    await grantPermissions(org.orgId, approverId, ["hrm.leave.read", "hrm.leave.approve"]);
    await grantPermissions(org.orgId, scopedOutId, ["hrm.leave.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    // Ana manages A in scope; the scoped-out manager holds the grant for B only.
    await scopeRole(org.orgId, "om11_ana", [org.subsidiaryId]);
    await scopeRole(org.orgId, "om11_scoped_out", [subB]);
    const quinnParty = await linkPerson(org.orgId, quinnId);
    const quinnEmployment = await seedEmployment(org.orgId, org.subsidiaryId, quinnParty);
    const type = await createLeaveType({
      orgId: org.orgId, actorId: anaId, code: "PPL-VAC", name: "Vacation",
      paid: true, valueCrossing: "none",
    });
    await createLeavePolicy({
      orgId: org.orgId, actorId: anaId, leaveTypeId: type.id,
      appliesTo: { employer_subsidiary_id: null, department_id: null },
      accrualRule: { kind: "per_year", hours: "120" },
      carryoverRule: { kind: "none" },
      minimumNoticeDays: 0,
      effectiveFrom: "2020-01-01",
    });
    await seedApprovalFlow(org.orgId, {
      subjectKind: HRM_LEAVE_REQUEST_SUBJECT_KIND,
      assignees: [{ type: "user", userId: approverId }],
      mode: "any",
    });

    // THE defect: Ana files for Quinn (works), then submits her own
    // draft — pre-fix this refused 403 'self-service only' because the
    // filer and the actor were the same person.
    const behalf = await fileLeaveRequest({
      orgId: org.orgId, actorId: anaId, employmentId: quinnEmployment,
      leaveTypeId: type.id, startsOn: "2026-10-05", endsOn: "2026-10-05",
      hours: "8", reason: "Quinn asked in person", onBehalf: true,
    });
    assert.equal(behalf.status, "draft");
    const submitted = await submitLeaveRequest({ orgId: org.orgId, actorId: anaId, requestId: behalf.id });
    assert.equal(submitted.status, "submitted");
    assert.ok(submitted.flowInstanceId, "submission opens the approval run");

    // Self-service still submits its own draft.
    const self = await fileLeaveRequest({
      orgId: org.orgId, actorId: quinnId, employmentId: quinnEmployment,
      leaveTypeId: type.id, startsOn: "2026-10-06", endsOn: "2026-10-06", hours: "8",
    });
    assert.equal(
      (await submitLeaveRequest({ orgId: org.orgId, actorId: quinnId, requestId: self.id })).status,
      "submitted",
    );

    // The subject submits a manager-created draft for themselves — the
    // filer never decided the path.
    const forQuinn = await fileLeaveRequest({
      orgId: org.orgId, actorId: anaId, employmentId: quinnEmployment,
      leaveTypeId: type.id, startsOn: "2026-10-07", endsOn: "2026-10-07",
      hours: "8", reason: "Quinn asked in person", onBehalf: true,
    });
    assert.equal(
      (await submitLeaveRequest({ orgId: org.orgId, actorId: quinnId, requestId: forQuinn.id })).status,
      "submitted",
    );

    // Withdrawal follows the same target rule: Ana withdraws the
    // still-draft on-behalf request.
    const toWithdraw = await fileLeaveRequest({
      orgId: org.orgId, actorId: anaId, employmentId: quinnEmployment,
      leaveTypeId: type.id, startsOn: "2026-10-08", endsOn: "2026-10-08",
      hours: "8", reason: "dates moved", onBehalf: true,
    });
    assert.equal(
      (await withdrawLeaveRequest({
        orgId: org.orgId, actorId: anaId, requestId: toWithdraw.id, reason: "dates moved",
      })).status,
      "withdrawn",
    );

    // A manager whose lens covers B but not Quinn's A employment is
    // refused uniformly — no submission, no state change.
    const probe = await fileLeaveRequest({
      orgId: org.orgId, actorId: anaId, employmentId: quinnEmployment,
      leaveTypeId: type.id, startsOn: "2026-10-09", endsOn: "2026-10-09",
      hours: "8", reason: "probe", onBehalf: true,
    });
    const refused = await submitLeaveRequest({
      orgId: org.orgId, actorId: scopedOutId, requestId: probe.id,
    }).then(
      () => { throw new Error("expected a refusal, the submit succeeded"); },
      (e: unknown) => e,
    );
    assert.ok(
      refused instanceof HrmAuthorizationError,
      `expected HrmAuthorizationError, got ${String(refused)}`,
    );
    assert.match((refused as Error).message, /not visible in this organization and legal-entity scope/);

    // A stranger with no grant at all is refused by grant name.
    const grantRefused = await submitLeaveRequest({
      orgId: org.orgId, actorId: strangerId, requestId: probe.id,
    }).then(
      () => { throw new Error("expected a refusal, the submit succeeded"); },
      (e: unknown) => e,
    );
    assert.ok(grantRefused instanceof HrmAuthorizationError);
    assert.match((grantRefused as Error).message, /hrm\.leave\.manage/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
