import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { roeCandidates, roeRecord, t4Slips } from "./yearend.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * ROE Block 17 carries declared separation payments and Block 11 the
 * continuance end; candidates and T4 reconcile to payroll.
 */
test(
  "a terminated employee's ROE record, candidacy, and T4 include separation facts",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      // No EHT insert here: seedAdoption already carries the decided ON EHT
      // rate, and a second row for the same key conflicts.
      await db.execute(sql`insert into addresses (org_id, party_id, line1, city, region, postal_code, country)
        values (${fx.orgId}, ${fx.employeeId}, '10 Main Street', 'Toronto', 'ON', 'M5V 2T6', 'CA')`);
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
      const agg = (await db.execute<{ gross: string }>(sql`
        select sum(s.gross)::text as gross
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and r.run_status = 'committed'`));
      const stubGross = agg.rows.reduce((a, r) => add(a, r.gross), "0");

      const eventId = randomUUID();
      await db.execute(sql`
        with event as (insert into payroll_roe_separation_events
          (id, org_id, employee_party_id, interruption_on, last_insurable_earnings_on,
           salary_continuance_end_on, status, change_reason)
          values (${eventId}, ${fx.orgId}, ${fx.employeeId}, '2026-08-10', '2026-08-01', '2026-08-05', 'confirmed', 'fixture') returning id),
        components as (select distinct component.id, component.code from pay_stub_lines line
          join pay_stubs stub on stub.org_id = line.org_id and stub.id = line.stub_id
          join pay_components component on component.org_id = line.org_id and component.id = line.component_id
          where stub.org_id = ${fx.orgId} and stub.employee_party_id = ${fx.employeeId} and line.kind = 'earning'),
        classified as (insert into payroll_roe_component_classifications
          (org_id, pay_component_id, effective_from, block, category_code, change_reason)
          select ${fx.orgId}::uuid, id, '2020-01-01', case when code = 'VACPAY' then '17A' else 'none' end,
                 case when code = 'VACPAY' then '1' else null end, 'fixture' from components returning pay_component_id)
        insert into payroll_roe_separation_payments
          (org_id, separation_event_id, pay_component_id, amount, payment_status, expected_payment_on, change_reason)
        select ${fx.orgId}::uuid, event.id, components.id, '57.6000'::numeric, 'paid', '2026-08-01'::date, 'fixture'
          from event cross join components where components.code = 'VACPAY'
        union all
        select ${fx.orgId}::uuid, event.id, components.id, '10.0000'::numeric, 'will_pay', '2026-08-20'::date, 'fixture'
          from event cross join components where components.code = 'VACPAY'
      `);

      const record = await roeRecord(fx.orgId, fx.employeeId);
      assert.ok(record, "a Canadian terminated employee gets an ROE record");
      assert.equal(record!.lastDayPaid, "2026-08-05");
      assert.equal(record!.vacationPayOnSeparation, "67.6000");

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
