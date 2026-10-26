import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  setupHarness,
  withHarness,
  linkPerson,
  seedEmployment,
  DB,
} from "../testing/hrm-harness.ts";
import { LeaveError } from "./leave-errors.ts";
import { createLeavePolicy, createLeaveType } from "./leave.ts";
import { leaveEmploymentBalances, timeBalanceAsOf } from "./leave-read.ts";

/**
 * Leave targeting and service-tier integration (DB partition): employment
 * and classification pins matched at balance time through the real reads,
 * per-event tier accrual end to end, the unknown-service-start flag, the
 * create validations, and concurrent same-scope creates serializing on
 * the (org, leave type) advisory lock with the loser refused by name.
 *
 * Proofs read storage back, never the service return alone; every refusal
 * asserts the writes that must NOT exist.
 */

const TARGETING_SPEC = {
  users: [
    {
      key: "managerId",
      name: "Targeting Manager",
      handle: "targeting_manager",
      permissions: ["hrm.leave.manage"],
      link: true,
    },
  ],
} as const;

async function seedType(orgId: string, actorId: string, code = "VAC") {
  return createLeaveType({
    orgId,
    actorId,
    code,
    name: "Vacation",
    paid: true,
    valueCrossing: "none",
  });
}

async function seedPolicy(
  orgId: string,
  actorId: string,
  leaveTypeId: string,
  overrides: Record<string, unknown> = {},
) {
  return createLeavePolicy({
    orgId,
    actorId,
    leaveTypeId,
    appliesTo: { employer_subsidiary_id: null, department_id: null },
    accrualRule: { kind: "per_year", hours: "120" },
    carryoverRule: { kind: "none" },
    minimumNoticeDays: 0,
    effectiveFrom: "2026-01-01",
    ...overrides,
  });
}

async function seedClassification(orgId: string, code: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`
    insert into hrm_work_classifications (org_id, code, name, trade)
    values (${orgId}, ${code}, ${code}, 'trade') returning id`,
      "objects",
    )
  )[0]!.id;
}

async function assignClassification(
  orgId: string,
  employmentId: string,
  classificationId: string,
  from: string,
  to: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into hrm_employment_classifications (org_id, employment_id, classification_id, effective_from, effective_to)
    values (${orgId}, ${employmentId}, ${classificationId}, ${from}, ${to})`);
}

async function policyCount(orgId: string, leaveTypeId: string): Promise<number> {
  return (
    (
      await db.execute<{ n: number }>(
        sql`
    select count(*)::int as n from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active`,
        "objects",
      )
    )[0]?.n ?? 0
  );
}

test("an employment not listed on a pinned policy is not matched", { skip: !DB }, async () => {
  await withHarness(
    () => setupHarness(TARGETING_SPEC),
    async (h) => {
      const partyA = await linkPerson(h.org.orgId, h.managerId, "Worker A");
      const partyB = await linkPerson(h.org.orgId, h.managerId, "Worker B");
      const a = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
        workerPartyId: partyA,
        from: "2020-01-01",
      });
      const b = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
        workerPartyId: partyB,
        from: "2020-01-01",
      });
      const type = await seedType(h.org.orgId, h.managerId);
      await seedPolicy(h.org.orgId, h.managerId, type.id, {
        appliesTo: {
          employer_subsidiary_id: null,
          department_id: null,
          employment_ids: [a.employmentId],
        },
      });
      const matched = await timeBalanceAsOf(db, h.org.orgId, a.employmentId, type.id, "2026-06-01");
      assert.equal(matched.policyId !== null, true);
      assert.equal(matched.balance, "120");
      const unmatched = await timeBalanceAsOf(
        db,
        h.org.orgId,
        b.employmentId,
        type.id,
        "2026-06-01",
      );
      assert.equal(unmatched.policyId, null);
      assert.equal(unmatched.balance, null);
    },
  );
});

test(
  "a classification held for only part of the period governs only that part",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const party = await linkPerson(h.org.orgId, h.managerId, "Classified Worker");
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: party,
          from: "2020-01-01",
        });
        const cls = await seedClassification(h.org.orgId, "JOURNEY");
        // Held January through March only (inclusive ends, the construction convention).
        await assignClassification(h.org.orgId, employmentId, cls, "2026-01-01", "2026-03-31");
        const type = await seedType(h.org.orgId, h.managerId);
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          appliesTo: {
            employer_subsidiary_id: null,
            department_id: null,
            classification_ids: [cls],
          },
          accrualRule: { kind: "per_year", hours: "200" },
          effectiveFrom: "2026-01-01",
        });
        // March: the classification is held, so the pinned policy governs
        // (200). June: the held window has ended and nothing else covers the
        // worker, so the balance reads uncovered instead of borrowing a rate.
        const march = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-03-15");
        assert.equal(march.balance, "200");
        const june = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-01");
        assert.equal(june.policyId, null);
        assert.equal(june.balance, null);
      },
    );
  },
);

test(
  "a pinned policy overlaps the general policy and resolves to the pinned worker",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const partyA = await linkPerson(h.org.orgId, h.managerId, "Pinned A");
        const partyB = await linkPerson(h.org.orgId, h.managerId, "General B");
        const a = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: partyA,
          from: "2020-01-01",
        });
        const b = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: partyB,
          from: "2020-01-01",
        });
        const type = await seedType(h.org.orgId, h.managerId);
        // Same type, scope, and dates: the general policy and the pinned
        // policy coexist (the storage guard only excludes wildcard pairs)
        // and specificity resolves to the pinned worker.
        await seedPolicy(h.org.orgId, h.managerId, type.id, { effectiveFrom: "2026-01-01" });
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          appliesTo: {
            employer_subsidiary_id: null,
            department_id: null,
            employment_ids: [a.employmentId],
          },
          accrualRule: { kind: "per_year", hours: "200" },
          effectiveFrom: "2026-01-01",
        });
        assert.equal(
          await policyCount(h.org.orgId, type.id),
          2,
          "general and pinned windows coexist",
        );
        const pinned = await timeBalanceAsOf(
          db,
          h.org.orgId,
          a.employmentId,
          type.id,
          "2026-06-01",
        );
        assert.equal(pinned.balance, "200");
        const general = await timeBalanceAsOf(
          db,
          h.org.orgId,
          b.employmentId,
          type.id,
          "2026-06-01",
        );
        assert.equal(general.balance, "120");
      },
    );
  },
);

test(
  "a targeted successor replaces the org-wide rule for its workers only",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const partyA = await linkPerson(h.org.orgId, h.managerId, "Successor A");
        const partyB = await linkPerson(h.org.orgId, h.managerId, "Successor B");
        const a = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: partyA,
          from: "2020-01-01",
        });
        const b = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: partyB,
          from: "2020-01-01",
        });
        const type = await seedType(h.org.orgId, h.managerId);
        // Same (type, subsidiary, department) windows stay exclusive in
        // storage: the successor starts where the predecessor ends.
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-06-30",
        });
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          appliesTo: {
            employer_subsidiary_id: null,
            department_id: null,
            employment_ids: [a.employmentId],
          },
          accrualRule: { kind: "per_year", hours: "200" },
          effectiveFrom: "2026-07-01",
        });
        const marchA = await timeBalanceAsOf(
          db,
          h.org.orgId,
          a.employmentId,
          type.id,
          "2026-03-15",
        );
        assert.equal(marchA.balance, "120");
        const septA = await timeBalanceAsOf(db, h.org.orgId, a.employmentId, type.id, "2026-09-01");
        assert.equal(septA.balance, "200");
        // The unlisted worker's predecessor has ended and the successor does
        // not name them: uncovered, never the successor's rate.
        const septB = await timeBalanceAsOf(db, h.org.orgId, b.employmentId, type.id, "2026-09-01");
        assert.equal(septB.policyId, null);
        assert.equal(septB.balance, null);
      },
    );
  },
);

test(
  "service tiers accrue per event across the anniversary and reproduce for past dates",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const party = await linkPerson(h.org.orgId, h.managerId, "Tiered Worker");
        // Fifth anniversary on 2026-06-15.
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: party,
          from: "2021-06-15",
        });
        const type = await seedType(h.org.orgId, h.managerId);
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          accrualRule: { kind: "per_year", hours: "80", tiers: [{ after_years: 5, hours: "120" }] },
        });
        const before = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-14");
        assert.equal(before.balance, "80");
        assert.equal(before.serviceStartUnknown, false);
        const on = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-15");
        assert.equal(on.balance, "120");
        // Reproducible: the same past as-of always prices the same.
        const again = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-14");
        assert.equal(again.balance, "80");
      },
    );
  },
);

test(
  "unknown service start accrues base hours and says so on the balance",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const party = await linkPerson(h.org.orgId, h.managerId, "Dateless Worker");
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: party,
          withVersion: false,
        });
        const type = await seedType(h.org.orgId, h.managerId);
        await seedPolicy(h.org.orgId, h.managerId, type.id, {
          accrualRule: { kind: "per_year", hours: "80", tiers: [{ after_years: 5, hours: "120" }] },
        });
        const read = await timeBalanceAsOf(db, h.org.orgId, employmentId, type.id, "2026-06-01");
        assert.equal(read.balance, "80");
        assert.equal(read.serviceStartUnknown, true);
        const rows = await leaveEmploymentBalances(db, h.org.orgId, employmentId, "2026-06-01");
        assert.equal(rows.find((row) => row.leaveTypeId === type.id)?.serviceStartUnknown, true);
        // An untiered policy never raises the flag, even with no start date.
        const plain = await seedType(h.org.orgId, h.managerId, "SICK");
        await seedPolicy(h.org.orgId, h.managerId, plain.id);
        const plainRead = await timeBalanceAsOf(
          db,
          h.org.orgId,
          employmentId,
          plain.id,
          "2026-06-01",
        );
        assert.equal(plainRead.serviceStartUnknown, false);
      },
    );
  },
);

test(
  "create validates targeting shape, org membership, and tier order",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const party = await linkPerson(h.org.orgId, h.managerId, "Validated Worker");
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          workerPartyId: party,
          from: "2020-01-01",
        });
        const cls = await seedClassification(h.org.orgId, "APPRENTICE");
        const type = await seedType(h.org.orgId, h.managerId);
        const base = {
          orgId: h.org.orgId,
          actorId: h.managerId,
          leaveTypeId: type.id,
          carryoverRule: { kind: "none" },
          minimumNoticeDays: 0,
          effectiveFrom: "2026-01-01",
        } as const;
        const before = await policyCount(h.org.orgId, type.id);
        // Malformed uuid in the target list.
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            appliesTo: {
              employer_subsidiary_id: null,
              department_id: null,
              employment_ids: ["not-a-uuid"],
            },
          }),
          (error: unknown) =>
            error instanceof LeaveError && /employment_ids holds uuids/.test(error.message),
        );
        // Empty target list.
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            appliesTo: { employer_subsidiary_id: null, department_id: null, employment_ids: [] },
          }),
          (error: unknown) => error instanceof LeaveError && /non-empty list/.test(error.message),
        );
        // Well-formed but outside this organization.
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            appliesTo: {
              employer_subsidiary_id: null,
              department_id: null,
              employment_ids: ["00000000-0000-4000-8000-000000000000"],
            },
          }),
          (error: unknown) =>
            error instanceof LeaveError && /not found in this organization/.test(error.message),
        );
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            appliesTo: {
              employer_subsidiary_id: null,
              department_id: null,
              classification_ids: ["00000000-0000-4000-8000-000000000000"],
            },
          }),
          (error: unknown) =>
            error instanceof LeaveError && /not found in this organization/.test(error.message),
        );
        // Descending tiers.
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            accrualRule: {
              kind: "per_year",
              hours: "80",
              tiers: [
                { after_years: 5, hours: "120" },
                { after_years: 3, hours: "100" },
              ],
            },
          }),
          (error: unknown) => error instanceof LeaveError && /ascends strictly/.test(error.message),
        );
        // Tiers on a kind that carries no hours.
        await assert.rejects(
          seedPolicy(h.org.orgId, h.managerId, type.id, {
            accrualRule: { kind: "none", tiers: [{ after_years: 5, hours: "120" }] },
          }),
          (error: unknown) => error instanceof LeaveError && /nothing to lift/.test(error.message),
        );
        // A valid targeted + tiered policy stores.
        const stored = await createLeavePolicy({
          ...base,
          appliesTo: {
            employer_subsidiary_id: null,
            department_id: null,
            employment_ids: [employmentId],
            classification_ids: [cls],
          },
          accrualRule: { kind: "per_year", hours: "80", tiers: [{ after_years: 5, hours: "120" }] },
        });
        assert.ok(stored.id);
        assert.equal(
          await policyCount(h.org.orgId, type.id),
          before + 1,
          "only the valid policy is stored",
        );
      },
    );
  },
);

test(
  "two concurrent same-scope creates serialize and the second is refused by name",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(TARGETING_SPEC),
      async (h) => {
        const type = await seedType(h.org.orgId, h.managerId);
        const body = (from: string) => ({
          orgId: h.org.orgId,
          actorId: h.managerId,
          leaveTypeId: type.id,
          appliesTo: { employer_subsidiary_id: null, department_id: null },
          accrualRule: { kind: "per_year", hours: "120" },
          carryoverRule: { kind: "none" },
          minimumNoticeDays: 0,
          effectiveFrom: from,
        });
        const [first, second] = await Promise.allSettled([
          createLeavePolicy(body("2026-01-01")),
          createLeavePolicy(body("2026-06-01")),
        ]);
        const won = [first, second].find((outcome) => outcome.status === "fulfilled");
        const lost = [first, second].find((outcome) => outcome.status === "rejected");
        assert.ok(won?.status === "fulfilled", "one create wins");
        assert.ok(lost?.status === "rejected", "the other is refused");
        const refusal = (lost as PromiseRejectedResult).reason;
        assert.ok(refusal instanceof LeaveError, `expected a LeaveError, got ${String(refusal)}`);
        assert.match(refusal.message, /policy [0-9a-f-]{36} already covers/);
        assert.equal(
          await policyCount(h.org.orgId, type.id),
          1,
          "the refused create leaves no second window behind",
        );
      },
    );
  },
);
