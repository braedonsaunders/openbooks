import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add } from "./money.ts";
import { seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { calculatePayRun, commitPayRun, createPayRun } from "./payroll-run.ts";
import { roeCandidates, roeRecord, roeWorksheet, t4Slips } from "./payroll-yearend.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * ROE tie-out for a terminated employee: the worksheet, the record, the
 * candidates list, and the T4 must all read the same committed stubs.
 *
 * Regular run (32h x $30 = $960) plus a termination run (16h x $30 = $480
 * with the $57.60 vacation-bank payout) gives $1,497.60 of insurable
 * earnings over 48 hours. Block 17 must carry the final stub's payout line,
 * the candidates list must name the terminated employee, and the T4 must
 * carry the same gross the ROE totals.
 */
test(
  "a terminated employee's ROE worksheet, record, candidacy, and T4 all tie to committed stubs",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(sql`
        update employee_roles set terminated_on = '2026-08-10'
         where org_id = ${fx.orgId} and party_id = ${fx.employeeId}`);
      const hours = (day: string, h: string) =>
        db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                    is_billable, billing_status, costing_basis,
                                    created_by, updated_by)
          values (${fx.orgId}, ${fx.employeeId}, ${day}, ${h}, 'approved', false,
                  'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(day, "8");
      }
      const regular = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.deepEqual((await calculatePayRun({
        orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId,
      })).errors, []);
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });

      for (const day of ["2026-07-20", "2026-07-22"]) {
        await hours(day, "8");
      }
      const final = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
        employeePartyIds: [fx.employeeId],
      });
      assert.deepEqual((await calculatePayRun({
        orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId,
      })).errors, []);
      await commitPayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });

      // Ground truth, straight from committed stubs.
      const agg = (await db.execute<{ gross: string; ie: string }>(sql`
        select sum(s.gross)::text as gross, sum(s.insurable_earnings)::text as ie
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and r.run_status = 'committed'`));
      const stubGross = agg.rows.reduce((a, r) => add(a, r.gross), "0");
      const stubEarnings = agg.rows.reduce((a, r) => add(a, r.ie), "0");
      const stubHours = (await db.execute<{ hours: string }>(sql`
        select sum(l.hours)::text as hours
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and r.run_status = 'committed' and l.kind = 'earning'`))
        .rows.reduce((a, r) => add(a, r.hours ?? "0"), "0");
      assert.equal(stubGross, "1497.6000");

      const worksheet = await roeWorksheet(fx.orgId, fx.employeeId, 27);
      assert.equal(worksheet.totalInsurableEarnings, stubEarnings);
      assert.equal(worksheet.totalInsurableHours, stubHours);

      const record = await roeRecord(fx.orgId, fx.employeeId);
      assert.ok(record, "a Canadian terminated employee gets an ROE record");
      assert.equal(record!.totalInsurableEarnings, stubEarnings);
      assert.equal(record!.totalInsurableHours, stubHours);
      assert.equal(record!.lastDayPaid, "2026-08-10");
      assert.equal(record!.payPeriodType, "B");
      // Block 17: the final stub's vacation pay — the prior bank's payout
      // (38.40) plus the final period's accrual paid as earnings (19.20).
      const vacation = (await db.execute<{ amount: string }>(sql`
        select sum(l.amount)::text as amount
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${final.documentId}
           and l.kind = 'earning' and c.code = 'VACPAY'`));
      assert.equal(vacation.rows[0]!.amount, "57.6000");
      assert.equal(record!.vacationPayOnSeparation, vacation.rows[0]!.amount);

      const candidates = await roeCandidates(fx.orgId, 2026);
      assert.ok(
        candidates.some((c) => c.employeePartyId === fx.employeeId),
        "the terminated employee is an ROE candidate",
      );

      const slips = await t4Slips(fx.orgId, 2026);
      assert.equal(slips.length, 1);
      assert.equal(slips[0]!.box14EmploymentIncome, stubGross);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
