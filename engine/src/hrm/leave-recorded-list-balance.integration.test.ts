import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "../platform/db.ts";
import {
  DB,
  linkPerson,
  seedEmployment,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { LeaveError } from "./leave-errors.ts";
import { createLeavePolicy, createLeaveType, fileLeaveRequest } from "./leave.ts";
import { leaveBalancesForEmployment, listOrgLeaveRequests } from "./leave-read.ts";
import { getAbsence, recordAbsence } from "./attendance.ts";

/**
 * Recorded-absence visibility and balances: manager-recorded days ride the
 * native org list source (one query, one scope — never a second list) with
 * status 'recorded', open through the absence detail read, and price into
 * the per-employee balances that reuse the entitlement engine. Proofs read
 * storage back alongside the service returns.
 */

const VISIBILITY_SPEC = {
  users: [
    {
      key: "managerId",
      name: "Visibility Manager",
      handle: "visibility_manager",
      permissions: ["hrm.leave.read", "hrm.leave.manage"],
      link: true,
    },
    {
      key: "employeeId",
      name: "Visibility Employee",
      handle: "visibility_employee",
      permissions: ["hrm.leave.request"],
    },
    { key: "outsiderId", name: "Visibility Outsider", handle: "visibility_outsider", link: true },
    {
      key: "manageOnlyId",
      name: "Manage Only",
      handle: "visibility_manage_only",
      permissions: ["hrm.leave.manage"],
      link: true,
    },
  ],
} as const;

async function seedVac(orgId: string, actorId: string) {
  const type = await createLeaveType({
    orgId,
    actorId,
    code: "VAC",
    name: "Vacation",
    paid: true,
    valueCrossing: "none",
  });
  await createLeavePolicy({
    orgId,
    actorId,
    leaveTypeId: type.id,
    appliesTo: { employer_subsidiary_id: null, department_id: null },
    accrualRule: { kind: "per_year", hours: "120" },
    carryoverRule: { kind: "none" },
    minimumNoticeDays: 0,
    effectiveFrom: "2020-01-01",
  });
  return type;
}

test(
  "the org list carries recorded days with their basis beside requests",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(VISIBILITY_SPEC),
      async (h) => {
        const workerParty = await linkPerson(h.org.orgId, h.employeeId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: workerParty,
        });
        const type = await seedVac(h.org.orgId, h.managerId);
        const recorded = await recordAbsence({
          orgId: h.org.orgId,
          actorId: h.managerId,
          employmentId,
          onDate: "2026-08-03",
          hours: "8",
          leaveTypeId: type.id,
          reason: "approved verbally by the owner",
        });
        const draft = await fileLeaveRequest({
          orgId: h.org.orgId,
          actorId: h.employeeId,
          employmentId,
          leaveTypeId: type.id,
          startsOn: "2026-09-05",
          endsOn: "2026-09-06",
          hours: "16",
        });

        const listed = await listOrgLeaveRequests(db, h.org.orgId, h.managerId, {});
        assert.equal(listed.truncated, false);
        // Newest start first across both shapes: the September draft, then August.
        assert.deepEqual(
          listed.requests.map((row) => row.id),
          [draft.id, recorded.id],
        );
        const day = listed.requests[1]!;
        assert.equal(day.source, "recorded");
        assert.equal(day.status, "recorded");
        assert.equal(day.absenceId, recorded.id);
        assert.equal(day.startsOn, "2026-08-03");
        assert.equal(day.endsOn, "2026-08-03");
        assert.equal(day.hours, "8.00", "storage text shape, exactly as request rows read");
        assert.equal(day.reason, "approved verbally by the owner");
        assert.equal(day.decidedBy, null);
        assert.equal(listed.requests[0]!.source, "request");
        assert.equal(listed.requests[0]!.absenceId, null);

        const only = await listOrgLeaveRequests(db, h.org.orgId, h.managerId, {
          status: "recorded",
        });
        assert.deepEqual(
          only.requests.map((row) => row.id),
          [recorded.id],
        );
        const drafts = await listOrgLeaveRequests(db, h.org.orgId, h.managerId, {
          status: "draft",
        });
        assert.deepEqual(
          drafts.requests.map((row) => row.id),
          [draft.id],
        );
      },
    );
  },
);

test("the absence detail opens a recorded day and refuses strangers", { skip: !DB }, async () => {
  await withHarness(
    () => setupHarness(VISIBILITY_SPEC),
    async (h) => {
      const workerParty = await linkPerson(h.org.orgId, h.employeeId);
      const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
        workerPartyId: workerParty,
      });
      const type = await seedVac(h.org.orgId, h.managerId);
      const recorded = await recordAbsence({
        orgId: h.org.orgId,
        actorId: h.managerId,
        employmentId,
        onDate: "2026-08-03",
        hours: "8",
        leaveTypeId: type.id,
        reason: "approved verbally by the owner",
      });
      const detail = await getAbsence({
        orgId: h.org.orgId,
        actorId: h.managerId,
        absenceId: recorded.id,
      });
      assert.equal(detail.onDate, "2026-08-03");
      assert.equal(detail.hours, "8.00");
      assert.equal(detail.leaveTypeCode, "VAC");
      assert.equal(detail.source, "recorded");
      assert.equal(detail.reason, "approved verbally by the owner");
      assert.equal(detail.leaveRequestId, null);
      await assert.rejects(
        getAbsence({ orgId: h.org.orgId, actorId: h.managerId, absenceId: randomUUID() }),
        (error: unknown) => error instanceof LeaveError && /not found/.test(error.message),
      );
      await assert.rejects(
        getAbsence({ orgId: h.org.orgId, actorId: h.outsiderId, absenceId: recorded.id }),
        (error: unknown) => error instanceof HrmAuthorizationError,
      );
    },
  );
});

test(
  "balances reuse the entitlement engine with exact taken, pending and remaining",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(VISIBILITY_SPEC),
      async (h) => {
        const workerParty = await linkPerson(h.org.orgId, h.employeeId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: workerParty,
        });
        const type = await seedVac(h.org.orgId, h.managerId);
        await recordAbsence({
          orgId: h.org.orgId,
          actorId: h.managerId,
          employmentId,
          onDate: "2026-08-03",
          hours: "8",
          leaveTypeId: type.id,
          reason: "approved verbally by the owner",
        });
        await fileLeaveRequest({
          orgId: h.org.orgId,
          actorId: h.employeeId,
          employmentId,
          leaveTypeId: type.id,
          startsOn: "2026-09-05",
          endsOn: "2026-09-06",
          hours: "16",
        });
        const balances = await leaveBalancesForEmployment(
          db,
          h.org.orgId,
          h.managerId,
          employmentId,
          "2026-10-01",
        );
        assert.equal(balances.length, 1);
        const vac = balances[0]!;
        assert.equal(vac.code, "VAC");
        assert.equal(
          vac.entitlement,
          "120",
          "the annual grant vests in full to the segment holding asOf",
        );
        assert.equal(
          vac.taken,
          "8",
          "the recorded day prices taken through the same absence read the gate uses",
        );
        assert.equal(vac.pending, "16", "the undecided draft claims pending");
        assert.equal(vac.remaining, "96", "exact decimals, never floats");
        assert.equal(vac.unlimited, false);
        // The gate matches the time-balance gate: a stranger reads nothing.
        await assert.rejects(
          leaveBalancesForEmployment(db, h.org.orgId, h.outsiderId, employmentId, "2026-10-01"),
          (error: unknown) => error instanceof HrmAuthorizationError,
        );
        // A refused asOf never masquerades as a zero balance.
        await assert.rejects(
          leaveBalancesForEmployment(db, h.org.orgId, h.managerId, employmentId, "not-a-date"),
          (error: unknown) => error instanceof LeaveError && /asOf/.test(error.message),
        );
        // A manage-only recorder reads the same balances through the manage
        // grant, so the record form can always show the effect before saving.
        const managed = await leaveBalancesForEmployment(
          db,
          h.org.orgId,
          h.manageOnlyId,
          employmentId,
          "2026-10-01",
        );
        assert.equal(managed[0]!.remaining, "96");
      },
    );
  },
);
