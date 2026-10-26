import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { loadWageTimeEntries, sumWageHoursByEmployee } from "./wage-hours.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedPayrollPerson,
  seedPayrollProfile,
  seedPayrollSchedule,
  seedPayrollTime,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";

/**
 * The Scope tab previews exactly the read Calculate prices (S4). The shared
 * wage-hours read counts approved in-period time this run will price, and
 * nothing else: entries another run already claimed, non-wage time types,
 * unapproved entries, and out-of-period entries are invisible to both.
 */
async function seedScope(orgId: string, subsidiaryId: string, actorId: string, scheduleId: string) {
  const parties: { partyId: string; hours: string }[] = [];
  for (const [index, hours] of ["67.5", "40", "40"].entries()) {
    const partyId = randomUUID();
    await seedPayrollPerson(orgId, partyId, `Wage Emp ${index + 1}`, { subsidiaryId });
    const employmentId = await seedWorkerEmployment(orgId, partyId, subsidiaryId);
    await seedPayrollProfile(orgId, partyId, employmentId, scheduleId, actorId, {
      country: "CA",
      province: "ON",
      payBasis: "hourly",
    });
    await seedPayrollTime(orgId, partyId, actorId, {
      workedOn: "2026-07-15",
      hours,
      status: "approved",
      costingBasis: "actual",
      billingStatus: "unbilled",
    });
    parties.push({ partyId, hours });
  }
  return parties;
}

test(
  "scope preview matches the calculation wage-hours read",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const scheduleId = randomUUID();
      await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
        name: "Biweekly",
        frequency: "biweekly",
        periodsPerYear: 26,
        anchorPeriodEnd: "2026-07-31",
        payDateOffsetDays: 5,
      });
      const docId = randomUUID();
      const parties = await seedScope(org.orgId, org.subsidiaryId, actorId, scheduleId);
      const rows = await loadWageTimeEntries(db, {
        orgId: org.orgId,
        employeePartyIds: parties.map((p) => p.partyId),
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        documentId: docId,
      });
      assert.deepEqual(
        sumWageHoursByEmployee(rows),
        new Map(parties.map((p) => [p.partyId, `${Number(p.hours).toFixed(4)}`])),
      );
      // Calc-style Date bounds (node-pg parses date columns into Dates) read identically.
      const dated = await loadWageTimeEntries(db, {
        orgId: org.orgId,
        employeePartyIds: parties.map((p) => p.partyId),
        periodStart: new Date(Date.UTC(2026, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 6, 31)),
        documentId: docId,
      });
      assert.deepEqual(sumWageHoursByEmployee(dated), sumWageHoursByEmployee(rows));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "claimed, non-wage, unapproved, and out-of-period time is invisible to both",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const scheduleId = randomUUID();
      await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
        name: "Biweekly",
        frequency: "biweekly",
        periodsPerYear: 26,
        anchorPeriodEnd: "2026-07-31",
        payDateOffsetDays: 5,
      });
      const docId = randomUUID();
      const otherDocId = randomUUID();
      const parties = await seedScope(org.orgId, org.subsidiaryId, actorId, scheduleId);
      const [first] = parties;
      const ptoType = randomUUID();
      await db.execute(sql`insert into time_types (id, org_id, name, classification, exclude_from_wages, created_by, updated_by)
      values (${ptoType}, ${org.orgId}, 'PTO', 'other', true, ${actorId}, ${actorId})`);
      // Claimed by another run: this run will never price it.
      await seedPayrollTime(org.orgId, first!.partyId, actorId, {
        workedOn: "2026-07-16",
        hours: "8",
        status: "approved",
        costingBasis: "actual",
        billingStatus: "unbilled",
      });
      await db.execute(sql`update time_entries set payroll_batch_ref = ${otherDocId}
       where org_id = ${org.orgId} and employee_party_id = ${first!.partyId} and worked_on = '2026-07-16'`);
      // Non-wage time type, unapproved entry, and out-of-period entry.
      await seedPayrollTime(org.orgId, first!.partyId, actorId, {
        workedOn: "2026-07-17",
        hours: "8",
        status: "approved",
        costingBasis: "actual",
        billingStatus: "unbilled",
        timeTypeId: ptoType,
      });
      await seedPayrollTime(org.orgId, first!.partyId, actorId, {
        workedOn: "2026-07-18",
        hours: "8",
        status: "submitted",
        costingBasis: "actual",
        billingStatus: "unbilled",
      });
      await seedPayrollTime(org.orgId, first!.partyId, actorId, {
        workedOn: "2026-08-01",
        hours: "8",
        status: "approved",
        costingBasis: "actual",
        billingStatus: "unbilled",
      });
      const totals = sumWageHoursByEmployee(
        await loadWageTimeEntries(db, {
          orgId: org.orgId,
          employeePartyIds: parties.map((p) => p.partyId),
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          documentId: docId,
        }),
      );
      assert.deepEqual(
        totals,
        new Map(parties.map((p) => [p.partyId, `${Number(p.hours).toFixed(4)}`])),
      );
      // Time this run claimed itself still prices.
      await db.execute(sql`update time_entries set payroll_batch_ref = ${docId}
       where org_id = ${org.orgId} and employee_party_id = ${first!.partyId} and worked_on = '2026-07-16'`);
      const reclaimed = sumWageHoursByEmployee(
        await loadWageTimeEntries(db, {
          orgId: org.orgId,
          employeePartyIds: [first!.partyId],
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          documentId: docId,
        }),
      );
      assert.equal(reclaimed.get(first!.partyId), (Number(first!.hours) + 8).toFixed(4));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("no employees means no query and no hours", async () => {
  assert.deepEqual(
    await loadWageTimeEntries(db, {
      orgId: randomUUID(),
      employeePartyIds: [],
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      documentId: randomUUID(),
    }),
    [],
  );
  assert.deepEqual(sumWageHoursByEmployee([]), new Map());
});
