import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add } from "./money.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

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
      const qcPayable = await account("2315", "Revenu Québec payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      const rqVendorId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${rqVendorId}, ${org.orgId}, 'company', 'Revenu Québec', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})`);
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
            craRemittancePartyId: org.vendorId,
            rqRemittancePartyId: rqVendorId,
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");
      await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${rqVendorId}
         where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);
      // A QC employer always owes the HSF at its own rate: a live-but-
      // unconfigured slot refuses by name at calculate, so the fixture
      // carries the employer's rate (this test asserts QPIP, never HSF).
      const hsfPayable = await account("2360", "HSF payable", "liability_current");
      await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
      await db.execute(sql`
        insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                             rate_values, created_by, updated_by)
        values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"rate": "1.65"}',
                ${actorId}, ${actorId})`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Jean Tremblay', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '5000', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, vacation_percent,
                                               vacation_method, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'QC', 'hourly', 1,
                '0', 'accrue', true, ${actorId}, ${actorId})`);

      const employerQpip: string[] = [];
      for (const [start, end, days] of [
        ["2026-07-05", "2026-07-18", ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]],
        ["2026-07-19", "2026-08-01", ["2026-07-20", "2026-07-22", "2026-07-24", "2026-07-28"]],
      ] as const) {
        for (const workedOn of days) {
          await db.execute(sql`
            insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                      billing_status, costing_basis, created_by, updated_by)
            values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                    'unbilled', 'actual', ${actorId}, ${actorId})`);
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
