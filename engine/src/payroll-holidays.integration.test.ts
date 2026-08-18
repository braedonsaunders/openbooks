import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { resolveStatutoryHolidayPay } from "./payroll-holidays.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * The British Columbia defect, end to end against the database.
 *
 * `engine/src/payroll-holidays.test.ts` proves the arithmetic with no database
 * at all. What it cannot prove is the half that reads the tenant: that "days on
 * which the employee worked OR EARNED WAGES" is actually assembled from
 * committed stubs, the observed calendar and the work schedule, and not from
 * `time_entries` alone as it was.
 *
 * The scenario is the one that was wrong in production terms: an employee on
 * PAID VACATION for the whole fortnight before Canada Day. The leave is drawn
 * from an entitlement bank and paid on the stub, so there is not one
 * `time_entries` row in the thirty days before the holiday — and BC ESA s. 44
 * refused them statutory holiday pay for it.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  employeeId: string;
  vacationComponentId: string;
  holidayComponentId: string;
  premiumComponentId: string;
  /** The run being calculated — excluded from its own lookback. */
  currentRunId: string;
}

/**
 * A BC employee, hired long ago, paid twice in June 2026 with money and no
 * hours: 2026-06-01 → 06-14 and 06-15 → 06-28, $2,000 of vacation pay each.
 * Monday-to-Friday, eight hours, so the two periods carry twenty working days.
 */
async function seedPaidVacationBeforeCanadaDay(options: {
  workSchedule?: boolean;
} = {}): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-06-28', 3, true,
            ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Robin Vacationer', true,
            ${org.subsidiaryId}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2024-01-01', true, ${actorId}, ${actorId})`);

  const component = async (code: string, systemKey: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                  created_by, updated_by)
      values (${id}, ${org.orgId}, ${code}, ${code}, 'earning', ${systemKey}, 'fixed_amount',
              true, ${actorId}, ${actorId})`);
    return id;
  };
  const vacationComponentId = await component("VACPAY", "vacation_payout");
  const holidayComponentId = await component("STATHOL", "stat_holiday");
  const premiumComponentId = await component("STATPREM", "stat_holiday_premium");

  // Two committed periods, each paid and each carrying NO hours: the shape a
  // salary or a bank-paid absence leaves behind.
  //
  // The document is 'approved' rather than 'posted' deliberately. What the
  // evidence query keys off is `pay_runs.run_status = 'committed'` — it never
  // reads documents.status — and a 'posted' document must also carry
  // posted_entry_id and posting_period_id (documents_posted_period_required),
  // which would mean seeding a journal entry this test does not exercise.
  const committed = async (periodStart: string, periodEnd: string, payDate: string) => {
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                             currency, status, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${payDate}, 'CAD', 'approved', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_status, calculated_at, created_by, updated_by)
      values (${documentId}, ${org.orgId}, ${scheduleId}, ${periodStart}, ${periodEnd}, ${payDate},
              2026, 'committed', now(), ${actorId}, ${actorId})`);
    const stubId = randomUUID();
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross,
                             created_by, updated_by)
      values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, 'BC', 26, ${payDate}, 2026,
              'CAD', '2000.00', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, amount,
                                  sequence, created_by, updated_by)
      values (${org.orgId}, ${stubId}, ${vacationComponentId}, 'earning', 'Vacation payout',
              null, '2000.00', 40, ${actorId}, ${actorId})`);
    return documentId;
  };
  await committed("2026-06-01", "2026-06-14", "2026-06-17");
  await committed("2026-06-15", "2026-06-28", "2026-07-01");

  if (options.workSchedule !== false) {
    const workScheduleId = randomUUID();
    await db.execute(sql`
      insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days,
                                  cycle_anchor, effective_from, is_active, created_by, updated_by)
      values (${workScheduleId}, ${org.orgId}, 'Full time', ${employeeId}, 'cycle', 7,
              '2026-01-04', '2020-01-01', true, ${actorId}, ${actorId})`);
    for (const dayIndex of [1, 2, 3, 4, 5]) {
      await db.execute(sql`
        insert into work_schedule_days (org_id, schedule_id, day_index, hours,
                                        created_by, updated_by)
        values (${org.orgId}, ${workScheduleId}, ${dayIndex}, '8', ${actorId}, ${actorId})`);
    }
  }

  // The run Canada Day falls in. Nothing is committed on it; it is only the
  // document the lookback must exclude.
  const currentRunId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${currentRunId}, 'pay_run', ${`PAY-${currentRunId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-15', 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, created_by, updated_by)
    values (${currentRunId}, ${org.orgId}, ${scheduleId}, '2026-06-29', '2026-07-12', '2026-07-15',
            2026, 'calculated', ${actorId}, ${actorId})`);

  return {
    orgId: org.orgId, actorId, employeeId, vacationComponentId,
    holidayComponentId, premiumComponentId, currentRunId,
  };
}

const holidayInput = (fx: Fixture) => ({
  orgId: fx.orgId,
  employeePartyId: fx.employeeId,
  employeeName: "Robin Vacationer",
  jurisdiction: "CA-BC",
  periodStart: "2026-06-29",
  periodEnd: "2026-07-12",
  holidayComponentId: fx.holidayComponentId,
  premiumComponentId: fx.premiumComponentId,
  excludeDocumentId: fx.currentRunId,
  hourlyRate: "30.00",
});

test(
  "BC: an employee on paid vacation, with no time entries at all, is paid for Canada Day",
  { skip: !DB },
  async () => {
    const fx = await seedPaidVacationBeforeCanadaDay();
    try {
      // The measure this engine used to count, asserted directly so the "would
      // not have qualified before" half is a fact and not a claim: there is not
      // one approved timesheet day in the thirty before the holiday, so the old
      // 15-of-30 numerator was zero and the day was refused outright.
      const timesheetDays = (await db.execute(sql`
        select count(distinct worked_on)::int as days
          from time_entries
         where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}
           and status = 'approved' and hours > 0
           and worked_on between '2026-06-01' and '2026-06-30'
      `)) as unknown as { rows: { days: number }[] };
      assert.equal(Number(timesheetDays.rows[0]?.days ?? 0), 0);

      const lines = await resolveStatutoryHolidayPay(db, holidayInput(fx));
      const holidayPay = lines.find((line) => line.componentId === fx.holidayComponentId);
      assert.ok(holidayPay, "Canada Day is paid");
      // $4,000 of vacation pay in the 30 days (BC includes it: s. 45(1)) over
      // the twenty days on which wages were earned — the twenty working days of
      // June 1–5, 8–12, 15–19 and 22–26.
      assert.equal(holidayPay.amount, "200.0000");
      assert.match(holidayPay.basis, /÷ 20 days worked or earned wages/);
      assert.equal(holidayPay.holidayDate, "2026-07-01");
      // Not worked, so no premium line.
      assert.equal(lines.some((line) => line.componentId === fx.premiumComponentId), false);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "BC: the same employee with no work schedule refuses instead of guessing a week",
  { skip: !DB },
  async () => {
    // Nothing in the data says which days of a paid fortnight were working
    // days. Five-over-seven would put an invented denominator into a divisor,
    // so it stops and names the employee and the recording that fixes it.
    const fx = await seedPaidVacationBeforeCanadaDay({ workSchedule: false });
    try {
      await assert.rejects(
        resolveStatutoryHolidayPay(db, holidayInput(fx)),
        /Robin Vacationer[\s\S]*WORKED OR EARNED WAGES/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
