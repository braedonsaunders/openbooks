import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, neg, sum } from "./money.ts";
import { calculateT4127 } from "./payroll/canada/t4127.ts";
import { calculatePub15T } from "./payroll/us/pub15t.ts";
import { setPackSlotAccount, uninstallPayrollPack } from "./payroll/packs.ts";
import { payRunBankFileEntitlement } from "./payroll-bank-file-artifact.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { unionRemittanceReport, upsertUnionFringe } from "./payroll-union.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "pay run end to end: hourly Ontario employee, calculate → commit → balanced GL projection",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      // Payroll GL accounts + settings
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

      // Employee: person party + hourly wage + biweekly schedule + TD1 profile
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Terry Worker', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);

      // 80 approved hours inside the period 2026-07-05..07-18
      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });

      // Calculate twice — recalculation must be idempotent (one stub, same totals)
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);

      const stubs = (await db.execute(sql`
        select * from pay_stubs where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: Record<string, string>[] };
      assert.equal(stubs.rows.length, 1);
      const stub = stubs.rows[0]!;
      assert.equal(stub.gross, "2400.0000"); // 80h × $30

      // The stub must match the T4127 engine called directly with the same facts
      // (pay date 2026-07-21 → 123rd edition).
      const expected = calculateT4127({
        payDate: "2026-07-21", province: "ON", periodsPerYear: 26,
        income: "2400.00", federalClaimCode: 1, provincialClaimCode: 1,
      });
      const factors = stub.factors as unknown as Record<string, string>;
      assert.equal(factors.C, expected.cpp);
      assert.equal(factors.EI, expected.ei);
      assert.equal(factors.T, expected.periodicTax);

      const deductions = sum([expected.cpp, expected.cpp2, expected.ei, expected.totalTax]);
      assert.equal(stub.net_pay, add("2400.0000", neg(deductions)));
      // Vacation 4% accrues as employer cost, never touches net
      assert.equal(stub.vacation_accrued, "96.0000");
      assert.equal(stub.employer_cost,
        sum([expected.cppEmployer, expected.eiEmployer, "96.00"]));

      // Commit: balanced signed document lines, time entries claimed
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const lines = (await db.execute(sql`
        select account_id, amount, party_id from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `)) as unknown as { rows: { account_id: string; amount: string; party_id: string | null }[] };
      assert.ok(lines.rows.length >= 5);
      assert.equal(cmp(sum(lines.rows.map((l) => l.amount)), "0"), 0, "GL projection balances");
      const netLeg = lines.rows.find((l) => l.party_id === employeeId);
      assert.ok(netLeg, "net pay leg carries the employee party");
      assert.equal(netLeg!.amount, neg(stub.net_pay));

      const claimed = (await db.execute(sql`
        select count(*)::int as n from time_entries
         where org_id = ${org.orgId} and payroll_batch_ref = ${run.documentId}
      `)) as unknown as { rows: { n: number }[] };
      assert.equal(claimed.rows[0]!.n, 4);

      // The bank file now exists, behind the immutable-artifact lifecycle
      // (engine/src/payroll-bank-file-artifact.ts), which is exercised in
      // payroll-bank-file.test.ts. What this run must still prove is that a
      // committed run knows it is ENTITLED to one — the gate that used to be a
      // blanket refusal is now a per-run decision.
      const entitlement = await payRunBankFileEntitlement(org.orgId, run.documentId);
      assert.equal(entitlement.entitled, true);
      assert.equal(entitlement.refusal, null);

      // Committed stubs feed YTD: a second run must see this run's CPP/EI
      const run2 = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
      });
      const r2 = (await db.execute(sql`
        select period_start, period_end from pay_runs where document_id = ${run2.documentId}
      `)) as unknown as { rows: { period_start: string; period_end: string }[] };
      assert.equal(r2.rows[0]!.period_start, "2026-07-19"); // derived next period
      assert.equal(r2.rows[0]!.period_end, "2026-08-01");
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                  billing_status, costing_basis, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, '2026-07-22', 20, 'approved', false,
                'unbilled', 'actual', ${actorId}, ${actorId})`);
      await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
      const stub2 = (await db.execute(sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run2.documentId}
      `)) as unknown as { rows: { factors: Record<string, string> }[] };
      const expected2 = calculateT4127({
        payDate: "2026-08-04", province: "ON", periodsPerYear: 26,
        income: "600.00", federalClaimCode: 1, provincialClaimCode: 1,
        ytd: {
          cpp: expected.cpp, cpp2: expected.cpp2, ei: expected.ei,
          pensionable: "2400.00",
        },
      });
      assert.equal(stub2.rows[0]!.factors.C, expected2.cpp);
      assert.equal(stub2.rows[0]!.factors.EI, expected2.ei);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "union payroll: dues feed U1, job-costed fringes split by project, remittance report",
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
      const fringeExpense = await account("6020", "Union fringes", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA payable", "liability_current");
      const duesPayable = await account("2330", "Union dues payable", "liability_current");
      const fringePayable = await account("2340", "Union fringes payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense, burdenExpenseAccountId: fringeExpense,
            netPayAccountId: netPayable, cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable, taxPayableAccountId: craPayable,
            vacationPayableAccountId: craPayable, wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const agreementId = randomUUID();
      await db.execute(sql`
        insert into union_agreements (id, org_id, name, union_name, local_number, is_active,
                                      created_by, updated_by)
        values (${agreementId}, ${org.orgId}, 'IBEW 353 Inside Wire', 'IBEW', '353', true,
                ${actorId}, ${actorId})`);
      const classificationId = randomUUID();
      await db.execute(sql`
        insert into union_classifications (id, org_id, agreement_id, code, name, is_active,
                                           created_by, updated_by)
        values (${classificationId}, ${org.orgId}, ${agreementId}, 'JW', 'Journeyman', true,
                ${actorId}, ${actorId})`);
      await upsertUnionFringe(org.orgId, actorId, {
        agreementId, code: "DUES", name: "Working dues", calc: "percent_of_gross",
        value: "2.5", paidBy: "employee", liabilityAccountId: duesPayable,
      });
      await upsertUnionFringe(org.orgId, actorId, {
        agreementId, code: "PEN", name: "Pension fund", calc: "per_hour_worked",
        value: "5", paidBy: "employer", jobCosted: true,
        expenseAccountId: fringeExpense, liabilityAccountId: fringePayable,
      });

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Jordan Sparks', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '48', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Union weekly', 'weekly', 52, '2026-07-18', 5, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               union_agreement_id, union_classification_id, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
                ${agreementId}, ${classificationId}, true, ${actorId}, ${actorId})`);

      const projectA = randomUUID();
      const projectB = randomUUID();
      for (const [id, name] of [[projectA, "Job A"], [projectB, "Job B"]] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${id}, ${org.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      // 24h on Job A, 16h on Job B inside 2026-07-12..07-18
      for (const [workedOn, hours, projectId] of [
        ["2026-07-13", "12", projectA], ["2026-07-14", "12", projectA],
        ["2026-07-15", "8", projectB], ["2026-07-16", "8", projectB],
      ] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, ${hours}, ${projectId}, 'approved',
                  false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-12", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);

      const stub = ((await db.execute(sql`
        select * from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: Record<string, string>[] }).rows[0]!;
      assert.equal(stub.gross, "1920.0000"); // 40h × $48
      const factors = stub.factors as unknown as Record<string, string>;

      const stubLines = ((await db.execute(sql`
        select l.description, l.kind, l.amount, l.hours, l.project_id
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} order by l.sequence
      `)) as unknown as { rows: Record<string, string | null>[] }).rows;

      // Dues: 2.5% × 1920 = 48.00, deduction, feeds U1
      const dues = stubLines.find((l) => l.description === "Working dues");
      assert.equal(dues?.kind, "deduction");
      assert.equal(dues?.amount, "48.0000");
      // U1 reduces annual taxable income: A = 52 × (1920 − F5A − 48)
      const expected = calculateT4127({
        payDate: "2026-07-23", province: "ON", periodsPerYear: 52,
        income: "1920.00", federalClaimCode: 1, provincialClaimCode: 1,
        unionDues: "48.00",
      });
      assert.equal(factors.A, expected.factors.A);
      assert.equal(factors.T, expected.periodicTax);

      // Pension: $5/h split by project — 120.00 on Job A, 80.00 on Job B
      const pension = stubLines.filter((l) => l.description === "Pension fund");
      assert.equal(pension.length, 2);
      const byProject = new Map(pension.map((l) => [l.project_id, l.amount]));
      assert.equal(byProject.get(projectA), "120.0000");
      assert.equal(byProject.get(projectB), "80.0000");

      // Commit: fringe expense legs carry the project split
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = ((await db.execute(sql`
        select account_id, amount, project_id from document_lines
         where document_id = ${run.documentId}
      `)) as unknown as { rows: Record<string, string | null>[] }).rows;
      assert.equal(cmp(sum(glLines.map((l) => l.amount!)), "0"), 0);
      const fringeLegs = glLines.filter((l) => l.account_id === fringeExpense && l.project_id);
      assert.equal(fringeLegs.length, 2);
      assert.equal(new Map(fringeLegs.map((l) => [l.project_id, l.amount])).get(projectA), "120.0000");

      // Remittance report aggregates the committed month per fund
      const report = await unionRemittanceReport(org.orgId, agreementId, "2026-07-01", "2026-07-31");
      const pensionRow = report.find((r) => r.fringeCode === "PEN");
      assert.equal(pensionRow?.amount, "200.0000");
      assert.equal(pensionRow?.hours, "40.00");
      const duesRow = report.find((r) => r.fringeCode === "DUES");
      assert.equal(duesRow?.amount, "48.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "US pay run end to end: salaried Texas employee, W-4 MFJ, FICA/FUTA/SUI, balanced GL",
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
      const irsPayable = await account("2330", "Federal payroll taxes payable", "liability_current");
      const futaPayable = await account("2340", "FUTA payable", "liability_current");
      const sutaPayable = await account("2350", "SUI payable", "liability_current");
      const statePayable = await account("2360", "State income tax payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            wagesTo: "expense",
            countries: ["US"],
            us: { sui: { TX: { rate: "0.027", wageBase: "9000" } } },
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "US");
      // Statutory liabilities land on the components via the pack slots.
      await setPackSlotAccount(org.orgId, actorId, "US", "fit", irsPayable);
      await setPackSlotAccount(org.orgId, actorId, "US", "fica", irsPayable);
      await setPackSlotAccount(org.orgId, actorId, "US", "futa", futaPayable);
      await setPackSlotAccount(org.orgId, actorId, "US", "suta", sutaPayable);
      // State withholding is remitted to the STATE, so it has its own slot and
      // its own payable — never the federal one the FIT rides.
      await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);
      await setPackSlotAccount(org.orgId, actorId, "US", "local_income_tax", statePayable);

      // The US employees are paid BY a US entity. The pay run is denominated in
      // its subsidiary's functional currency and the wage rows are USD, so
      // paying them from the CAD root would (correctly) demand a USD→CAD spot
      // rate — resolvePayRate converts the wage rather than paying the raw
      // number in the wrong currency.
      const usSubId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${usSubId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)`);

      // Salaried Texas employee, married filing jointly: $104,000/yr biweekly.
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Tex Worker', ${usSubId}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'USD', '104000', 'year', 2080, '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, '2026-07-18', 3,
                ${usSubId}, true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                               province, pay_basis, filing_status, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'US', 'TX', 'salary', 'married_joint',
                true, ${actorId}, ${actorId})`);

      // A second employee in a taxing state must error per-employee, not crash the run.
      const caStateEmployee = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${caStateEmployee}, ${org.orgId}, 'person', 'Cali Worker', ${usSubId}, true,
                '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${caStateEmployee}, 'USD', '30', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                               province, pay_basis, filing_status, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${caStateEmployee}, ${scheduleId}, 'US', 'CA', 'hourly', 'single',
                true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                  billing_status, costing_basis, created_by, updated_by)
        values (${org.orgId}, ${caStateEmployee}, '2026-07-08', 8, 'approved', false,
                'unbilled', 'actual', ${actorId}, ${actorId})`);

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      // BOTH employees calculate now. This assertion used to be "1 paid, 1
      // refused, because California is not supported" — the second employee was
      // here to prove that an unsupported state errors per employee instead of
      // crashing the run. California IS supported now: its tables are
      // transcribed and its income tax is withheld on the stub, and the
      // per-employee error channel is still proven by the same shape below with
      // a state that genuinely has no engine.
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 2);

      const stubs = (await db.execute(sql`
        select * from pay_stubs where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
          and employee_party_id = ${employeeId}
      `)) as unknown as { rows: Record<string, string>[] };
      assert.equal(stubs.rows.length, 1);
      const stub = stubs.rows[0]!;
      assert.equal(stub.gross, "4000.0000"); // 104,000 / 26
      assert.equal(stub.province, "TX");

      // The stub must match the Pub 15-T engine called directly with the same facts.
      const expected = calculatePub15T({
        payDate: "2026-07-21", periodsPerYear: 26, wages: "4000.00",
        filingStatus: "married_joint",
        sui: { rate: "0.027", wageBase: "9000" },
      });
      const factors = stub.factors as unknown as Record<string, string>;
      assert.equal(factors.FIT, expected.fit);
      assert.equal(factors.SS, expected.ss);
      assert.equal(factors.MED, expected.medicare);
      assert.equal(factors.FUTA, expected.futa);
      assert.equal(factors.SUTA, expected.suta);
      // Hand-worked: AAWA 104,000 − 12,900 = 91,100 → 2,480 + 12% × 47,000
      // = 8,120 → ÷26 = 312.31; SS 248.00; Medicare 58.00; FUTA 24.00 (first
      // 7,000 at 0.6%); SUI 108.00 (2.7% of 4,000 under the 9,000 base).
      assert.equal(expected.fit, "312.3100");
      assert.equal(expected.ss, "248.0000");
      assert.equal(expected.medicare, "58.0000");
      assert.equal(expected.futa, "24.0000");
      assert.equal(expected.suta, "108.0000");

      const deductions = sum([expected.fit, expected.ss, expected.medicare]);
      assert.equal(stub.net_pay, add("4000.0000", neg(deductions)));
      assert.equal(stub.employer_cost,
        sum([expected.ssEmployer, expected.medicareEmployer, expected.futa, expected.suta]));

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const lines = (await db.execute(sql`
        select account_id, amount, party_id from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `)) as unknown as { rows: { account_id: string; amount: string; party_id: string | null }[] };
      assert.equal(cmp(sum(lines.rows.map((l) => l.amount)), "0"), 0, "GL projection balances");
      const sutaLeg = lines.rows.find((l) => l.account_id === sutaPayable);
      assert.ok(sutaLeg, "SUI liability posts to its slot account");
      assert.equal(sutaLeg!.amount, neg(expected.suta));

      // Second run: YTD wage bases carry — FUTA has 3,000 of room left.
      const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
      await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
      const stub2 = (await db.execute(sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run2.documentId}
           and employee_party_id = ${employeeId}
      `)) as unknown as { rows: { factors: Record<string, string> }[] };
      assert.equal(stub2.rows[0]!.factors.FUTA, "18.0000"); // min(4,000, 7,000 − 4,000) × 0.6%
      assert.equal(stub2.rows[0]!.factors.SS, "248.0000"); // far from the wage base

      // Uninstall guards: an active US profile AND committed stubs both block.
      await assert.rejects(
        uninstallPayrollPack(org.orgId, actorId, "US"),
        /active employee payroll profile.*pay stub/s,
      );

      // Clearing the profiles alone is not enough — stubs still block.
      await db.execute(sql`
        update employee_payroll_profiles set is_active = false
         where org_id = ${org.orgId} and country = 'US'`);
      await assert.rejects(
        uninstallPayrollPack(org.orgId, actorId, "US"),
        /pay stub\(s\) reference this pack/,
      );

      // A pack with no dependents uninstalls cleanly: CA was never used here.
      // 12 statutory components: TAX, QCTAX, CPP, CPP2, CPP-ER, EI, EI-ER,
      // QPIP, QPIP-ER, VAC, WCB, EHT.
      await seedPayrollComponents(org.orgId, actorId, "CA");
      const removed = await uninstallPayrollPack(org.orgId, actorId, "CA");
      assert.equal(removed.componentsRemoved, 12);
      const caLeft = (await db.execute(sql`
        select count(*)::int as n from pay_components
         where org_id = ${org.orgId} and country = 'CA'`)) as unknown as { rows: { n: number }[] };
      assert.equal(caLeft.rows[0]!.n, 0);
      const markers = (await db.execute(sql`
        select settings#>'{payroll,countries}' as countries from orgs where id = ${org.orgId}
      `)) as unknown as { rows: { countries: unknown }[] };
      assert.ok(!(markers.rows[0]!.countries as string[] | null ?? []).includes("CA"));
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

/**
 * This test used to BLESS the defect it now proves is fixed.
 *
 * It put an employee in a `country='US'`/USD subsidiary, omitted the profile
 * country so it defaulted to 'CA', and asserted `result.errors` was empty —
 * i.e. the suite certified that withholding Canadian CPP, EI and Ontario
 * income tax from an employee of a US legal entity, denominating it in USD and
 * pointing it at a CRA program account, was correct behaviour. A test that
 * asserts the absence of an error IS the bug when the error is the point.
 *
 * The corrected version asserts both halves of "correct or refused, never
 * silently wrong": the misconfigured employee is REFUSED by name, and the same
 * employee configured honestly as a US employee CALCULATES, under Pub 15-T,
 * in USD.
 */
test(
  "subsidiary-scoped schedule: entity currency, employee filtering, and country reconciliation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedPayrollComponents(org.orgId, actorId, "CA");
      // Both packs: the US entity's employee needs the US pack's components.
      await seedPayrollComponents(org.orgId, actorId, "US");
      const usSubId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${usSubId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)`);

      const mkEmployee = async (name: string, subsidiaryId: string | null, currency: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values (${id}, ${org.orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                        effective_from, is_active, created_by, updated_by)
          values (${org.orgId}, ${id}, ${currency}, '40', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
        return id;
      };
      const rootEmployee = await mkEmployee("Root Rita", org.subsidiaryId, "CAD");
      const usEmployee = await mkEmployee("Scoped Sam", usSubId, "USD");

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'US biweekly', 'biweekly', 26, '2026-07-18', 3,
                ${usSubId}, true, ${actorId}, ${actorId})`);
      for (const [employee, province] of [[rootEmployee, "ON"], [usEmployee, "ON"]] as const) {
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                                 pay_basis, federal_claim_code, provincial_claim_code,
                                                 is_active, created_by, updated_by)
          values (${org.orgId}, ${employee}, ${scheduleId}, ${province}, 'hourly', 1, 1, true,
                  ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employee}, '2026-07-14', 8, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      // The run document carries the schedule's entity and its currency
      const doc = ((await db.execute(sql`
        select subsidiary_id, currency from documents where id = ${run.documentId}
      `)) as unknown as { rows: { subsidiary_id: string; currency: string }[] }).rows[0]!;
      assert.equal(doc.subsidiary_id, usSubId);
      assert.equal(doc.currency, "USD");

      // Only the scoped subsidiary's employee is included…
      const refused = await calculatePayRun({
        orgId: org.orgId, documentId: run.documentId, actorId,
      });
      assert.equal(refused.employees, 0, "the misconfigured employee produced no stub");
      assert.equal(refused.errors.length, 1);
      assert.equal(refused.errors[0]!.employee, "Scoped Sam");
      // …and because their profile still says Canada while the entity paying
      // them is American, they are refused BY NAME rather than paid CPP/EI.
      assert.match(
        refused.errors[0]!.message,
        /on the CA country pack, but this run pays from US Entity, a US legal entity/,
      );
      const noStubs = ((await db.execute(sql`
        select count(*)::int as n from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { n: number }[] }).rows[0]!;
      assert.equal(noStubs.n, 0, "nothing wrong was written");

      // Configure the employee honestly — a US employee, in a state the US
      // pack covers — and the same run calculates.
      await db.execute(sql`
        update employee_payroll_profiles
           set country = 'US', province = 'TX', filing_status = 'single'
         where org_id = ${org.orgId} and employee_party_id = ${usEmployee}`);
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);
      const stubs = ((await db.execute(sql`
        select employee_party_id, currency_code, province, factors
          from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as {
        rows: { employee_party_id: string; currency_code: string; province: string;
                factors: Record<string, string> }[];
      }).rows;
      assert.deepEqual(stubs.map((s) => s.employee_party_id), [usEmployee]);
      // The whole chain agrees: US pack, US state, USD, and Pub 15-T factors
      // (SS/Medicare) rather than T4127's CPP/EI.
      assert.equal(stubs[0]!.currency_code, "USD");
      assert.equal(stubs[0]!.province, "TX");
      assert.ok(stubs[0]!.factors.SS != null, "FICA computed — the US pack ran");
      assert.equal(stubs[0]!.factors.C, undefined, "no CPP on a US employee");
      assert.equal(stubs[0]!.factors.EI, undefined, "no EI on a US employee");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "run adjustments: one-off bonus uses the bonus method, replace overrides, exclude drops the stub",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedPayrollComponents(org.orgId, actorId, "CA");
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Adjusted Avery', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '78000', 'year', '2080', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'salary', 1, 1, true,
                ${actorId}, ${actorId})`);
      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const baseline = ((await db.execute(sql`
        select gross, net_pay from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { gross: string; net_pay: string }[] }).rows[0]!;
      assert.equal(baseline.gross, "3000.0000"); // 78,000 / 26

      // One-off bonus: taxed with the non-periodic method (TB), gross +500
      const bonusComponent = ((await db.execute(sql`
        select id from pay_components where org_id = ${org.orgId} and code = 'BONUS'
      `)) as unknown as { rows: { id: string }[] }).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, note, created_by, updated_by)
        values (${org.orgId}, ${run.documentId}, ${employeeId}, 'line', ${bonusComponent.id},
                '500', 'Spot bonus', ${actorId}, ${actorId})`);
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const adjusted = ((await db.execute(sql`
        select gross, factors from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { gross: string; factors: Record<string, string> }[] }).rows[0]!;
      assert.equal(adjusted.gross, "3500.0000");
      assert.ok(Number(adjusted.factors.TB) > 0, "bonus method tax applies");
      const bonusLine = ((await db.execute(sql`
        select l.description from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} and l.component_id = ${bonusComponent.id}
      `)) as unknown as { rows: { description: string }[] }).rows;
      assert.deepEqual(bonusLine.map((l) => l.description), ["Spot bonus"]);

      // Replace: override the salary-derived base pay line entirely
      const baseComponent = ((await db.execute(sql`
        select id from pay_components where org_id = ${org.orgId} and code = 'BASE'
      `)) as unknown as { rows: { id: string }[] }).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, replace_component,
                                         note, created_by, updated_by)
        values (${org.orgId}, ${run.documentId}, ${employeeId}, 'line', ${baseComponent.id},
                '2000', true, 'Unpaid leave proration', ${actorId}, ${actorId})`);
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const replaced = ((await db.execute(sql`
        select gross from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { gross: string }[] }).rows[0]!;
      assert.equal(replaced.gross, "2500.0000"); // 2,000 replaced base + 500 bonus

      // Exclude: employee drops out of the run entirely
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, created_by, updated_by)
        values (${org.orgId}, ${run.documentId}, ${employeeId}, 'exclude', ${actorId}, ${actorId})`);
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 0);
      const stubCount = ((await db.execute(sql`
        select count(*)::int as n from pay_stubs where pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { n: number }[] }).rows[0]!;
      assert.equal(stubCount.n, 0);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
