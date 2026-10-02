import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import { seedPayrollVendorRole } from '../testing/fixtures.ts';
import {
  seedPayrollSchedule, seedPayrollPerson, seedPayrollTime, seedPostingAccount, seedPayrollProfile, seedPayrollWage,
  createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedCntSubjectEmployerFixture } from "./filing-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Employer QPIP has its OWN annual maximum ($620.06 for 2026) — unlike EI,
 * it is not a multiple of the capped employee amount, so each period must
 * be reduced by what the employer already accrued. One $400,000 period takes
 * the whole maximum; the next period must accrue nothing. Anything more
 * over-remits every high earner's employer share for the rest of the year.
 */
test(
  "employer QPIP accrues against its own annual maximum across periods",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const account = seedPostingAccount.bind(null, org.orgId);
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const qcPayable = await account("2315", "Revenu Québec payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      const rqVendorId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${rqVendorId}, ${org.orgId}, 'company', 'Revenu Québec', true, '{}'::jsonb)`);
      await seedPayrollVendorRole(org.orgId, rqVendorId, actorId);
      await seedPayrollAccountingConfiguration(org.orgId, {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
            craRemittancePartyId: org.vendorId,
            rqRemittancePartyId: rqVendorId,
          });
      await seedPayrollComponents(org.orgId, actorId, "CA");
      await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${rqVendorId}
         where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);
      // A QC employer always owes the HSF at its own rate: an unclassified
      // employer refuses by name at calculate, so the fixture classifies
      // ordinary-sector (this test asserts QPIP, never HSF).
      const hsfPayable = await account("2360", "HSF payable", "liability_current");
      await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
      await db.execute(sql`
        insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                             rate_values, created_by, updated_by)
        values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
                ${actorId}, ${actorId})`);
      // The QC stub prices CNT too (asserted nowhere here; QPIP only).
      await seedCntSubjectEmployerFixture(org.orgId, actorId, org.subsidiaryId, qcPayable);

      const employeeId = randomUUID();
      await seedPayrollPerson(org.orgId, employeeId, 'Jean Tremblay');
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await seedPayrollWage(org.orgId, employeeId, actorId, {
        currency: 'CAD', rate: '5000', basis: 'hour', effectiveFrom: '2026-01-01',
      });
      const scheduleId = randomUUID();
      await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
        name: 'Biweekly', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
        payDateOffsetDays: 3,
      });
      await seedPayrollProfile(org.orgId, employeeId, employmentId, scheduleId, actorId, {
        country: 'CA', province: 'QC', payBasis: 'hourly', federalClaimCode: 1,
      }, { percentFloor: '0', method: 'accrue' });


      const employerQpip: string[] = [];
      for (const [start, end, days] of [
        ["2026-07-05", "2026-07-18", ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]],
        ["2026-07-19", "2026-08-01", ["2026-07-20", "2026-07-22", "2026-07-24", "2026-07-28"]],
      ] as const) {
        for (const workedOn of days) {
          await seedPayrollTime(org.orgId, employeeId, actorId, {
            workedOn: workedOn, hours: 20, status: 'approved', isBillable: false, billingStatus: 'unbilled',
            costingBasis: 'actual',
          });
        }
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: start, periodEnd: end,
        });
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.deepEqual(result.errors, []);
        const factors = (await db.execute<{ factors: unknown }>(sql`
          select factors from pay_stubs
           where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
        `)).rows[0]!.factors as Record<string, string>;
        employerQpip.push(factors.QPIP_ER!);
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      }

      assert.equal(employerQpip[0], "620.0600", "first period takes the whole annual maximum");
      assert.equal(employerQpip[1], "0.0000", "second period accrues nothing once the maximum is reached");
      assert.equal(
        add(employerQpip[0]!, employerQpip[1]!),
        "620.0600",
        "the year accrues exactly the employer maximum, never past it",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
