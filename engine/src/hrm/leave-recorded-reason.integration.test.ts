import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  DB,
  linkPerson,
  seedEmployment,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { LeaveError } from "./leave-errors.ts";
import { createLeavePolicy, createLeaveType } from "./leave.ts";
import { recordAbsence } from "./attendance.ts";

/**
 * Recorded-absence basis (0659): a back-dated day or a day recorded for
 * another worker is refused without a non-blank reason, decided in the
 * engine from the org business day and the actor's own employments — never
 * only in the UI. The basis is persisted on the row and in the absence's
 * audit entry. Proofs read storage back, never the service return alone,
 * and every refusal asserts the writes that must NOT exist.
 */

const REASON_SPEC = {
  users: [
    {
      key: "managerId",
      name: "Reason Manager",
      handle: "reason_manager",
      permissions: ["hrm.leave.read", "hrm.leave.manage"],
      link: true,
    },
    {
      key: "employeeId",
      name: "Reason Employee",
      handle: "reason_employee",
      permissions: ["hrm.leave.request"],
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

async function absenceCount(orgId: string, employmentId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`
    select count(*)::int as n from hrm_absences where org_id = ${orgId} and employment_id = ${employmentId}
  `,
    "objects",
  );
  return rows[0]!.n;
}

async function auditCount(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'hrm_absences' and action = 'absence_recorded'
  `,
    "objects",
  );
  return rows[0]!.n;
}

test(
  "a back-dated recording without a reason refuses and writes nothing",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(REASON_SPEC),
      async (h) => {
        const workerParty = await linkPerson(h.org.orgId, h.employeeId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: workerParty,
        });
        const type = await seedVac(h.org.orgId, h.managerId);
        try {
          await recordAbsence({
            orgId: h.org.orgId,
            actorId: h.managerId,
            employmentId,
            onDate: "2026-08-03",
            hours: "8",
            leaveTypeId: type.id,
          });
          assert.fail("a back-dated recording without a basis must refuse");
        } catch (error) {
          assert.ok(error instanceof LeaveError);
          assert.match((error as Error).message, /back-dated.*basis|basis.*back-dated/);
        }
        assert.equal(
          await absenceCount(h.org.orgId, employmentId),
          0,
          "a refused recording leaves no rows behind",
        );
        assert.equal(await auditCount(h.org.orgId), 0, "a refused recording writes no audit entry");
      },
    );
  },
);

test(
  "a back-dated recording with a reason saves the basis on the row and in audit",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(REASON_SPEC),
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
        assert.equal(recorded.reason, "approved verbally by the owner");
        const row = (
          await db.execute<{ reason: string | null }>(
            sql`
      select reason from hrm_absences where id = ${recorded.id}
    `,
            "objects",
          )
        )[0]!;
        assert.equal(
          row.reason,
          "approved verbally by the owner",
          "the basis is persisted on the record",
        );
        const audit = await db.execute<{ reason: string | null; actor: string }>(
          sql`
      select changes->'after'->>'reason' as reason, actor_id::text as actor from audit_log
       where org_id = ${h.org.orgId} and table_name = 'hrm_absences' and row_id = ${recorded.id} and action = 'absence_recorded'
    `,
          "objects",
        );
        assert.equal(audit.length, 1, "the recording writes exactly one audit entry");
        assert.equal(
          audit[0]!.reason,
          "approved verbally by the owner",
          "the audit entry carries the same basis",
        );
        assert.equal(audit[0]!.actor, h.managerId);
      },
    );
  },
);

test(
  "a future recording for another worker needs the basis; the manager's own future day does not",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(REASON_SPEC),
      async (h) => {
        const workerParty = await linkPerson(h.org.orgId, h.employeeId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: workerParty,
        });
        const managerParty = await linkPerson(h.org.orgId, h.managerId);
        const own = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: managerParty,
        });
        const type = await seedVac(h.org.orgId, h.managerId);
        try {
          await recordAbsence({
            orgId: h.org.orgId,
            actorId: h.managerId,
            employmentId,
            onDate: "2027-01-15",
            hours: "8",
            leaveTypeId: type.id,
          });
          assert.fail("recording for another worker without a basis must refuse");
        } catch (error) {
          assert.ok(error instanceof LeaveError);
          assert.match((error as Error).message, /another worker.*basis|basis.*another worker/);
        }
        assert.equal(
          await absenceCount(h.org.orgId, employmentId),
          0,
          "a refused recording leaves no rows behind",
        );
        const recorded = await recordAbsence({
          orgId: h.org.orgId,
          actorId: h.managerId,
          employmentId: own.employmentId,
          onDate: "2027-01-15",
          hours: "8",
          leaveTypeId: type.id,
        });
        assert.equal(recorded.reason, null, "a current own-employment recording needs no basis");
        const row = (
          await db.execute<{ reason: string | null }>(
            sql`
      select reason from hrm_absences where id = ${recorded.id}
    `,
            "objects",
          )
        )[0]!;
        assert.equal(row.reason, null);
      },
    );
  },
);

test(
  "a blank reason never satisfies the basis, even where none is required",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(REASON_SPEC),
      async (h) => {
        const managerParty = await linkPerson(h.org.orgId, h.managerId);
        const own = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: managerParty,
        });
        const type = await seedVac(h.org.orgId, h.managerId);
        try {
          await recordAbsence({
            orgId: h.org.orgId,
            actorId: h.managerId,
            employmentId: own.employmentId,
            onDate: "2027-01-15",
            hours: "8",
            leaveTypeId: type.id,
            reason: "   ",
          });
          assert.fail("a blank reason must refuse");
        } catch (error) {
          assert.ok(error instanceof LeaveError);
          assert.match((error as Error).message, /basis/);
        }
        assert.equal(
          await absenceCount(h.org.orgId, own.employmentId),
          0,
          "a refused recording leaves no rows behind",
        );
      },
    );
  },
);
