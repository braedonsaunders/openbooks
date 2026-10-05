import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Reduced employer EI rates price per payroll program account.
 *
 * Insurable earnings of 1,227.00 price employee EI of 20.00. On an RP
 * account with a CRA-approved 1.167 multiple the employer share is 23.34;
 * on a standard account it is 28.00. An account whose multiples leave the
 * pay date uncovered refuses calculation naming the employee and the
 * setup page — it never guesses the standard rate past an approval.
 */
test(
  "employer EI prices the account multiple and refuses an uncovered pay date",
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
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const filingAccount = async (accountNumber: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                               remitter_type, is_default, is_active, created_by, updated_by)
          values (${id}, ${org.orgId}, 'CA', 'ca_rp', ${accountNumber}, ${accountNumber}, 'regular', false,
                  true, ${actorId}, ${actorId})`);
        return id;
      };
      const reducedId = await filingAccount("111111111RP0001");
      const standardId = await filingAccount("222222222RP0002");
      const gappedId = await filingAccount("333333333RP0003");
      await upsertPayrollEmployerFact({
        orgId: org.orgId, actorId, country: "CA", factKey: "ei_employer_multiplier",
        filingAccountId: reducedId,
        effectiveFrom: "2026-01-01", value: "1.167",
        changeReason: "CRA-approved reduced rate for the account wage-loss plan.",
      });
      // The gapped account records its approval only from August: a July
      // pay date falls in the uncovered gap and must refuse.
      await upsertPayrollEmployerFact({
        orgId: org.orgId, actorId, country: "CA", factKey: "ei_employer_multiplier",
        filingAccountId: gappedId,
        effectiveFrom: "2026-08-01", value: "1.167",
        changeReason: "CRA-approved reduced rate for the account wage-loss plan.",
      });

      const makeSchedule = async (name: string) => {
        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                     pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, ${name}, 'biweekly', 26, '2026-07-18', 3, true,
                  ${actorId}, ${actorId})`);
        return scheduleId;
      };
      const scheduleId = await makeSchedule("Biweekly");
      const gapScheduleId = await makeSchedule("Biweekly gap");

      const hire = async (name: string, accountId: string | null, rosterScheduleId: string = scheduleId) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into employee_roles (id, org_id, party_id)
          values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', '31902', 'year', '2026-01-01', true,
                  ${actorId}, ${actorId})`);
        const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                 filing_account_id, country, province, pay_basis,
                                                 federal_claim_code, provincial_claim_code,
                                                 is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${employmentId}, ${rosterScheduleId}, ${accountId}, 'CA', 'ON',
                  'salary', 1, 1, true, ${actorId}, ${actorId})`);
        await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
        return employeeId;
      };
      const reducedEmployeeId = await hire("Rae Reduced", reducedId);
      const standardEmployeeId = await hire("Sam Standard", standardId);

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 2);

      const stubs = (await db.execute<{ employee_party_id: string; factors: Record<string, string> }>(sql`
        select employee_party_id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `));
      const stubFor = (employeeId: string) =>
        stubs.rows.find((row) => row.employee_party_id === employeeId)!;

      // 1,227.00 insurable prices EI 20.00; the account multiple prices
      // the employer share: 23.34 reduced, 28.00 standard.
      assert.equal(stubFor(reducedEmployeeId).factors.EI, "20.0000");
      assert.equal(stubFor(reducedEmployeeId).factors.EI_ER, "23.3400");
      assert.equal(stubFor(standardEmployeeId).factors.EI, "20.0000");
      assert.equal(stubFor(standardEmployeeId).factors.EI_ER, "28.0000");

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      // The uncovered account refuses by name: the employee and the setup
      // page that records the multiple.
      await hire("Gail Gapped", gappedId, gapScheduleId);
      const gapRun = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: gapScheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const gapResult = await calculatePayRun({ orgId: org.orgId, documentId: gapRun.documentId, actorId });
      const gapErrors = gapResult.errors.filter((error) => error.employee === "Gail Gapped");
      assert.equal(gapErrors.length, 1);
      assert.match(gapErrors[0]!.message, /Gail Gapped/);
      assert.match(gapErrors[0]!.message, /Payroll Setup → Employer facts/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
