import { seedPayrollAccountingConfiguration } from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createRetroPayRun, proposeRetroPay } from "./retro-store.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import {
  seedCanadianFilingAccountForTest,
  seedCanadianPayrollComponentsForTest as seedPayrollComponents,
} from "./filing-test-fixtures.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { seedHiredEmployee } from "./filing-test-fixtures.ts";

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
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: {
            cpp: craPayable,
            ei: craPayable,
            qpip: craPayable,
            income_tax: craPayable,
            vacation: vacationPayable,
          },
        },
      });
      await seedPayrollComponents(org.orgId, actorId);

      const scheduleId = randomUUID();
      // An organization-wide schedule is owned by the root subsidiary on each run.
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-08-15', 3, null, true,
                ${actorId}, ${actorId})`);

      const filingAccountId = await seedCanadianFilingAccountForTest(org.orgId, actorId, {
        subsidiaryId: org.subsidiaryId,
        accountNumber: "123456789RP0001",
        name: "CRA payroll",
        effectiveFrom: "2026-01-01",
        eiEmployerMultiplier: "1.4",
      });
      const hire = async (name: string, hiredOn: string) => {
        const { employeeId } = await seedHiredEmployee(org.orgId, actorId, {
          scheduleId,
          subsidiaryId: org.subsidiaryId,
          name,
          country: "CA",
          province: "ON",
          payBasis: "salary",
          currency: "CAD",
          rate: "78000",
          rateBasis: "year",
          annualHours: "2080",
          federalClaimCode: 1,
          provincialClaimCode: 1,
          hiredOn,
          wcbExempt: true,
          wcbExemptReason:
            "The declared employee is outside the employer workers-compensation coverage.",
        });
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
          where org_id=${org.orgId} and employee_party_id=${employeeId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        return employeeId;
      };

      // Pieter is on staff; the Aug 16–29 run posts with only him on it.
      await hire("Pieter Janssen", "2026-01-05");
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-08-16",
        periodEnd: "2026-08-29",
        payDate: "2026-09-01",
      });
      const calculated = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "3000.0000", "78,000 / 26 for Pieter alone");
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      // Sanne joins during the posted period; Teun joins after it ended.
      await hire("Sanne de Vries", "2026-08-20");
      await hire("Teun Bakker", "2026-09-05");

      // Current regular pay supplies the actual income required by the native separate-payment method.
      const current = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-08-30",
        periodEnd: "2026-09-12",
        payDate: "2026-09-15",
      });
      assert.deepEqual(
        (await calculatePayRun({ orgId: org.orgId, documentId: current.documentId, actorId }))
          .errors,
        [],
      );
      await commitPayRun({ orgId: org.orgId, documentId: current.documentId, actorId });

      // ---- Detect + quantify ------------------------------------------------
      const proposal = await proposeRetroPay({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        payDate: "2026-09-19",
        allowedSubsidiaryIds: null,
      });
      const sanne = proposal.periods.filter((p) => p.candidate.employeeName === "Sanne de Vries");
      assert.equal(sanne.length, 1, "the never-paid hire is surfaced for the posted period");
      assert.equal(sanne[0]!.candidate.sourceDocumentNumber, run.documentNumber);
      assert.ok(
        sanne[0]!.candidate.reasons.some((reason) => reason.source === "omitted_from_run"),
        "the reason names the omission, not a backdated change",
      );
      assert.equal(sanne[0]!.outcome, "payable");
      assert.equal(sanne[0]!.difference!.originalEarnings, "0.0000", "she was never paid");
      assert.equal(
        sanne[0]!.difference!.recomputedEarnings,
        "3000.0000",
        "what the period would pay her today",
      );
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
      const create = () =>
        createRetroPayRun({
          orgId: org.orgId,
          actorId,
          payScheduleId: scheduleId,
          payDate: "2026-09-19",
          allowedSubsidiaryIds: null,
        });
      const attempts = await Promise.allSettled([create(), create()]);
      const created = attempts.filter((result) => result.status === "fulfilled");
      assert.equal(created.length, 1, "competing creators may retain only one retro settlement");
      const refused = attempts.find((result) => result.status === "rejected");
      assert.ok(refused && refused.status === "rejected");
      assert.match(refused.reason.message, /already settles|sources changed concurrently/);
      assert.equal(created[0]!.status, "fulfilled");
      const retro = created[0]!.value;
      assert.equal(retro.settlements, 1);
      assert.equal(retro.employees, 1);
      assert.equal(retro.total, "3000.0000");
      const retroCalculated = await calculatePayRun({
        orgId: org.orgId,
        documentId: retro.documentId,
        actorId,
      });
      assert.deepEqual(retroCalculated.errors, []);
      const references = await db.execute<{ referenceRunId: string }>(
        sql`
        select reference->>'referenceRunId' as "referenceRunId" from pay_runs,
          jsonb_array_elements(calculation_source_snapshot->'bonusIncomeReferences') reference
         where org_id=${org.orgId} and document_id=${retro.documentId}`,
        "objects",
      );
      assert.deepEqual(
        references,
        [{ referenceRunId: current.documentId }],
        "retro tax references current committed regular income, independently of the old earning window",
      );
      assert.equal(retroCalculated.gross, "3000.0000", "the retro cheque IS her September wages");
      await commitPayRun({ orgId: org.orgId, documentId: retro.documentId, actorId });

      // Exactly once: proposed again, she is still listed but there is nothing
      // left to give — the committed settlement sits inside previouslySettled.
      const again = await proposeRetroPay({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        payDate: "2026-09-19",
        allowedSubsidiaryIds: null,
      });
      const settled = again.periods.filter((p) => p.candidate.employeeName === "Sanne de Vries");
      assert.equal(settled.length, 1, "the omission still reads as a row, not silence");
      assert.equal(settled[0]!.outcome, "none");
      assert.equal(settled[0]!.difference!.delta, "0.0000");
      assert.equal(again.payableTotal, "0.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
