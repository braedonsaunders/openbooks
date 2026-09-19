import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createRetroPayRun,
  proposeRetroPay,
} from "./payroll-retro-store.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * An employee hired during a period whose regular run has already POSTED must
 * still be payable for it — through the retro finder, which is the
 * schedule's only vehicle that can reach a posted period with the regular
 * tax treatment. The finder used to diff only employees who had a stub on
 * the original run, so a never-paid employee was invisible: OWED 0.00 with
 * real wages outstanding.
 *
 * Setup mirrors the observation: Pieter posts alone on the Aug 16–29 run
 * (PAY-00001); Sanne is hired during that same period, after it posted.
 * Teun is hired after the period ENDED and must stay out — without the
 * hired-on gate the simulation (which keys eligibility off the live roster,
 * never a hire date) would hand him a full period he never worked.
 */
test(
  "retro pay: an employee hired during a posted period is surfaced as owed, exactly once",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-08-15', 3, true,
                ${actorId}, ${actorId})`);

      const hire = async (name: string, hiredOn: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                        effective_from, is_active, created_by, updated_by)
          values (${org.orgId}, ${id}, 'CAD', '78000', 'year', '2080', '2026-01-01', true,
                  ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                                 pay_basis, federal_claim_code, provincial_claim_code,
                                                 is_active, created_by, updated_by)
          values (${org.orgId}, ${id}, ${scheduleId}, 'ON', 'salary', 1, 1, true,
                  ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_roles (org_id, party_id, hired_on, is_active)
          values (${org.orgId}, ${id}, ${hiredOn}, true)`);
        return id;
      };

      // Pieter is on staff; the Aug 16–29 run posts with only him on it.
      await hire("Pieter Janssen", "2026-01-05");
      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-08-16", periodEnd: "2026-08-29", payDate: "2026-09-01",
      });
      const calculated = await calculatePayRun({
        orgId: org.orgId, documentId: run.documentId, actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "3000.0000", "78,000 / 26 for Pieter alone");
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      // Sanne joins during the posted period; Teun joins after it ended.
      await hire("Sanne de Vries", "2026-08-20");
      await hire("Teun Bakker", "2026-09-05");

      // ---- Detect + quantify ------------------------------------------------
      const proposal = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-09-19",
      });
      const sanne = proposal.periods.filter(
        (p) => p.candidate.employeeName === "Sanne de Vries",
      );
      assert.equal(sanne.length, 1, "the never-paid hire is surfaced for the posted period");
      assert.equal(sanne[0]!.candidate.sourceDocumentNumber, run.documentNumber);
      assert.ok(
        sanne[0]!.candidate.reasons.some((reason) => reason.source === "omitted_from_run"),
        "the reason names the omission, not a backdated change",
      );
      assert.equal(sanne[0]!.outcome, "payable");
      assert.equal(sanne[0]!.difference!.originalEarnings, "0.0000", "she was never paid");
      assert.equal(sanne[0]!.difference!.recomputedEarnings, "3000.0000", "what the period would pay her today");
      assert.equal(sanne[0]!.difference!.delta, "3000.0000");
      assert.equal(proposal.payableTotal, "3000.0000");
      assert.deepEqual(
        proposal.periods
          .filter((p) => p.candidate.employeeName === "Teun Bakker")
          .map((p) => p.candidate.periodStart),
        [],
        "a hire after the period ended is owed nothing for it",
      );

      // ---- Pay ----------------------------------------------------------------
      const retro = await createRetroPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-09-19",
      });
      assert.equal(retro.settlements, 1);
      assert.equal(retro.employees, 1);
      assert.equal(retro.total, "3000.0000");
      const retroCalculated = await calculatePayRun({
        orgId: org.orgId, documentId: retro.documentId, actorId,
      });
      assert.deepEqual(retroCalculated.errors, []);
      assert.equal(retroCalculated.gross, "3000.0000", "the retro cheque IS her September wages");
      await commitPayRun({ orgId: org.orgId, documentId: retro.documentId, actorId });

      // Exactly once: proposed again, she is still listed but there is nothing
      // left to give — the committed settlement sits inside previouslySettled.
      const again = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-09-19",
      });
      const settled = again.periods.filter(
        (p) => p.candidate.employeeName === "Sanne de Vries",
      );
      assert.equal(settled.length, 1, "the omission still reads as a row, not silence");
      assert.equal(settled[0]!.outcome, "none");
      assert.equal(settled[0]!.difference!.delta, "0.0000");
      assert.equal(again.payableTotal, "0.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
