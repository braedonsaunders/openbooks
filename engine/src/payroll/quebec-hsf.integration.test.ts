import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, neg, sum } from "../money/money.ts";
import { setPackSlotAccount } from "./packs.ts";
import { payrollRemittanceSummary } from "./remittance.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Québec Health Services Fund (TP-1015.F-V s. 5).
 *
 * The publication-pasted golden: the 2026 Revenu Québec table's other-sector
 * rate (1.65%) times the remuneration subject — employment income is
 * generally subject, so the stub's gross — with no exemption and no cap:
 * 2400.00 × 1.65% = 39.60. The rate is tenant-entered because it is a
 * function of the employer's own total payroll and sector class, which no
 * stub can see; the band itself is never derived here.
 */
test(
  "QC HSF: tenant rate times gross on QC stubs, never on ON stubs, remitted to Revenu Québec",
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
      const hsfPayable = await account("2360", "HSF payable", "liability_current");

      // A second vendor party: Revenu Québec. org.vendorId plays the CRA.
      const rqVendorId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${rqVendorId}, ${org.orgId}, 'company', 'Revenu Québec', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
        on conflict do nothing`);

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
            // The pack's regional declaration routes a QC stub's HSF here
            // (TPZ-1015.R), never to the CRA vendor above.
            rqRemittancePartyId: rqVendorId,
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${rqVendorId}
         where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);

      // The employer's own HSF rate from Revenu Québec's total-payroll table:
      // 1.65% (the 2026 other-sector rate, pasted from the publication).
      await db.execute(sql`
        insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                             rate_values, created_by, updated_by)
        values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"rate": "1.65"}',
                ${actorId}, ${actorId})`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const seedEmployee = async (name: string, province: string) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                                 pay_basis, federal_claim_code, vacation_percent,
                                                 vacation_method, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', ${province}, 'hourly', 1,
                  '0', 'accrue', true, ${actorId}, ${actorId})`);
        for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await db.execute(sql`
            insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                      billing_status, costing_basis, created_by, updated_by)
            values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                    'unbilled', 'actual', ${actorId}, ${actorId})`);
        }
        return employeeId;
      };
      const qcEmployeeId = await seedEmployee("Jean Tremblay", "QC");
      const onEmployeeId = await seedEmployee("Casey Siteworker", "ON");

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 2);
      assert.deepEqual(result.errors, []);

      const stubs = (await db.execute<{ employee_party_id: string; factors: Record<string, string> }>(sql`
        select employee_party_id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `));
      assert.equal(stubs.rows.length, 2);
      const stubFor = (employeeId: string) =>
        stubs.rows.find((row) => row.employee_party_id === employeeId)!;

      // QC golden: 2400.00 × 1.65% = 39.60 on the full gross — no exemption,
      // no cap, exactly as the publication states the contribution.
      const qcFactors = stubFor(qcEmployeeId).factors;
      assert.equal(qcFactors.HSF_EARN, "2400.0000");
      assert.equal(qcFactors.HSF, "39.6000");

      const qcLines = (await db.execute<{ system_key: string | null; kind: string; description: string; amount: string; sequence: number }>(sql`
        select c.system_key, l.kind, l.description, l.amount, l.sequence
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
          join pay_stubs s on s.id = l.stub_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and s.employee_party_id = ${qcEmployeeId} and c.system_key = 'hsf'
      `));
      assert.equal(qcLines.rows.length, 1);
      assert.deepEqual(
        [qcLines.rows[0]!.sequence, qcLines.rows[0]!.kind, qcLines.rows[0]!.description],
        [280, "employer_contribution", "Health Services Fund"],
      );
      assert.equal(qcLines.rows[0]!.amount, "39.6000");

      // The region gate: the ON stub carries no HSF evidence at all, even
      // though the org holds a QC HSF rate.
      const onFactors = stubFor(onEmployeeId).factors;
      assert.equal(onFactors.HSF ?? "0", "0");
      assert.ok(!("HSF_EARN" in onFactors), "no HSF assessable earnings outside QC");
      const onHsfLines = (await db.execute<{ amount: string }>(sql`
        select l.amount
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
          join pay_stubs s on s.id = l.stub_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and s.employee_party_id = ${onEmployeeId} and c.system_key = 'hsf'
      `));
      assert.equal(onHsfLines.rows.length, 0);

      // Remittance: the pack's regional declaration sends the QC stub's HSF
      // to the Revenu Québec vendor; the CRA vendor never sees it.
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      const hsfLeg = glLines.rows.filter((row) => row.account_id === hsfPayable);
      assert.equal(sum(hsfLeg.map((row) => row.amount)), neg("39.6000"));

      const groups = await payrollRemittanceSummary(org.orgId, { from: "2026-07-01", to: "2026-07-31" });
      const rqGroup = groups.find((group) => group.partyId === rqVendorId);
      const craGroup = groups.find((group) => group.partyId === org.vendorId);
      assert.ok(rqGroup, "a Revenu Québec remittance group exists");
      assert.ok(craGroup, "a CRA remittance group exists");
      const rqHsf = rqGroup!.components.filter((component) => component.systemKey === "hsf");
      assert.equal(rqHsf.length, 1, "HSF remits to Revenu Québec");
      assert.equal(sum(rqHsf.map((component) => component.amount)), "39.6000");
      assert.ok(
        !craGroup!.components.some((component) => component.systemKey === "hsf"),
        "the CRA never sees a QC stub's HSF",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
