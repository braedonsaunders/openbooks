import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import { resolveStatutoryHolidayPay } from "./holidays.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";

/** End-to-end coverage for paid-leave evidence and effective-dated employer facts. */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  employeeId: string;
  vacationComponentId: string;
  holidayComponentId: string;
  premiumComponentId: string;
  /** The run being calculated — excluded from its own lookback. */
  currentRunId: string;
}

/**
 * A BC employee with June vacation pay and no hours recorded.
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
  const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);

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

  // Two paid committed periods carry no hours, as with salary or bank-paid
  // absence. Approved documents avoid unrelated posted-journal setup.
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
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross,
                             created_by, updated_by)
      values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, ${employmentId}, 'BC', 26, ${payDate}, 2026,
              'CAD', ${periodStart === "2026-05-25" ? "1000.00" : "2000.00"}, ${actorId}, ${actorId})`);
    const insertLine = (amount: string, from: string | null, to: string | null) => db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, amount,
                                  earned_from, earned_to, sequence, created_by, updated_by)
      values (${org.orgId}, ${stubId}, ${vacationComponentId}, 'earning', 'Vacation payout',
              null, ${amount}, ${from}, ${to}, 40, ${actorId}, ${actorId})`);
    if (periodStart === "2026-05-25") {
      await insertLine("100.00", "2026-05-25", "2026-05-31");
      // Day-resolved like the engine's own producers emit: the $900 June
      // week counts its 5 weekdays as earned days in the lookback.
      for (const [day, amount] of [["2026-06-01", "180.00"], ["2026-06-02", "180.00"],
           ["2026-06-03", "180.00"], ["2026-06-04", "180.00"], ["2026-06-05", "180.00"]]) {
        await insertLine(amount, day, day);
      }
    } else await insertLine("2000.00", null, null);
    return documentId;
  };
  await committed("2026-05-25", "2026-06-07", "2026-06-10");
  await committed("2026-06-08", "2026-06-21", "2026-06-24");

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
    orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, employeeId, vacationComponentId,
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
      // The old 15-of-30 test counted no approved work days and refused this
      // employee, despite $4,000 of paid vacation in the lookback.
      const timesheetDays = (await db.execute<{ days: number }>(sql`
        select count(distinct worked_on)::int as days
          from time_entries
         where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}
           and status = 'approved' and hours > 0
           and worked_on between '2026-06-01' and '2026-06-30'
      `));
      assert.equal(Number(timesheetDays.rows[0]?.days ?? 0), 0);

      const lines = await resolveStatutoryHolidayPay(db, holidayInput(fx));
      const holidayPay = lines.find((line) => line.componentId === fx.holidayComponentId);
      assert.ok(holidayPay, "Canada Day is paid");
      // $900 of the boundary stub is in the lookback; BC s. 45(1) yields $2,900 ÷ 15 scheduled weekdays,
      // rounded once at cents like every earning line.
      assert.equal(holidayPay.amount, "193.3300");
      assert.match(holidayPay.basis, /÷ 15 days worked or earned wages/);
      assert.equal(holidayPay.holidayDate, "2026-07-01");
      // Not worked, so no premium line.
      assert.equal(lines.some((line) => line.componentId === fx.premiumComponentId), false);
      // Manitoba Remembrance Day is work-triggered, not a general holiday: 2
      // hours worked on 11-11 with a non-exempt employer pays the normal-day
      // amount (8 h × $30) plus the 1.5× overtime minimum on the greater of
      // hours worked and half a normal day, less ordinary wages already paid.
      await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
        is_billable, billing_status, costing_basis, created_by, updated_by)
        values (${fx.orgId}, ${fx.employeeId}, '2026-11-11', '2', 'approved', false, 'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
      await upsertPayrollEmployerFact({ orgId: fx.orgId, actorId: fx.actorId,
        subsidiaryId: fx.subsidiaryId, country: "CA", factKey: "mb_remembrance_day_act_exempt",
        effectiveFrom: "2026-01-01", value: "false", changeReason: "Subject to Manitoba Act" });
      const manitoba = await resolveStatutoryHolidayPay(db, { ...holidayInput(fx),
        periodStart: "2026-11-11", periodEnd: "2026-11-11", jurisdiction: "CA-MB",
        country: "CA", subsidiaryId: fx.subsidiaryId });
      assert.deepEqual(manitoba.map((line) => line.amount), ["240.0000", "120.0000"]);
      await upsertPayrollEmployerFact({
        orgId: fx.orgId, actorId: fx.actorId, subsidiaryId: fx.subsidiaryId,
        country: "CA", factKey: "work_week_start", effectiveFrom: "2026-01-01",
        value: "1", changeReason: "Ontario ESA work-week election",
      });
      const ontario = await resolveStatutoryHolidayPay(db, {
        ...holidayInput(fx), country: "CA", subsidiaryId: fx.subsidiaryId,
        jurisdiction: "CA-ON", absentWithoutConsent: false,
      });
      // ESA s. 24(1)(a): regular wages (none here) plus vacation payable for
      // the four work weeks before the holiday week — $2,900 ÷ 20.
      assert.equal(ontario.find((line) => line.componentId === fx.holidayComponentId)?.amount, "145.0000");
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

test(
  "a declaring jurisdiction outside Ontario/Quebec still demands the last-and-first assertion",
  { skip: !DB },
  async () => {
    // Alberta's own rule (Employment Standards Code, Part 2 Div. 5) makes an
    // unconsented absence on the adjacent shifts an entitlement condition, and
    // the pack declares `lastAndFirstScheduledShift: true` for CA-AB — but the
    // demand fired only for CA-ON/CA-QC, so an Alberta run paid the holiday
    // without ever asking the employer the question the statute requires.
    await assert.rejects(
      resolveStatutoryHolidayPay(db, {
        orgId: randomUUID(),
        employeePartyId: randomUUID(),
        employeeName: "Alberta Employee",
        jurisdiction: "CA-AB",
        periodStart: "2026-10-11",
        periodEnd: "2026-10-17",
        holidayComponentId: randomUUID(),
        premiumComponentId: randomUUID(),
        excludeDocumentId: randomUUID(),
        hourlyRate: "25.00",
      }),
      /Alberta Employee[\s\S]*last-and-first-shift[\s\S]*absence assertion/,
    );
  },
);

test(
  "jurisdictions that do not declare the test are not asked for it",
  { skip: !DB },
  async () => {
    // British Columbia declares no last-and-first condition and no commission
    // window, so a BC run with no facts supplied must keep computing (here:
    // no wages, no pay) rather than trip a demand driven by another
    // province's statute. BC does declare its own 30-day employment
    // qualifier, so the employee gets a hire date to isolate this question.
    const orgId = randomUUID();
    const employeePartyId = randomUUID();
    const actorId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeePartyId}, ${orgId}, 'person', 'BC Employee', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on, created_by, updated_by)
      values (${orgId}, ${employeePartyId}, '2020-01-01', ${actorId}, ${actorId})`);
    try {
      const lines = await resolveStatutoryHolidayPay(db, {
        orgId,
        employeePartyId,
        employeeName: "BC Employee",
        jurisdiction: "CA-BC",
        periodStart: "2026-10-11",
        periodEnd: "2026-10-17",
        holidayComponentId: randomUUID(),
        premiumComponentId: randomUUID(),
        excludeDocumentId: randomUUID(),
        hourlyRate: "25.00",
      });
      assert.deepEqual(lines, []);
    } finally {
      await db.execute(sql`delete from employee_roles where org_id = ${orgId}`);
      await db.execute(sql`delete from parties where org_id = ${orgId}`);
    }
  },
);
