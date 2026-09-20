import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, neg, sum } from "../money/money.ts";
import { payRunReadiness, payrollSetupState } from "./readiness.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePub15T } from "./us/pub15t.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A silent-zero SUI and Quebec noise for an Ontario tenant — one model.
 *
 * A live-but-unconfigured `refuse` rate slot stops the employee BY NAME at
 * calculate (reusing the readiness detector's sentence), while a slot that
 * does not apply in the employee's region produces no line and demands no
 * account. The sharp case is the misconfigured tenant: SUI rates on file for
 * TX, CA and NY, every one linked to an account the employee is NOT assigned
 * to — "a rate exists somewhere in the org" must not pass; only a rate that
 * RESOLVES for this employee, at this region, on this assigned filing
 * account accrues.
 */

interface UsHarness {
  orgId: string;
  actorId: string;
  scheduleId: string;
  employeeId: string;
  einAccountId: string;
  txSuiAccountId: string;
  sutaPayable: string;
}

/** Texas hourly employee ($45/h) on the Default/EIN filing account. */
async function seedTexasHarness(): Promise<UsHarness> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
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
      features: { payroll: true },
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["US"],
      },
    })}::jsonb where id = ${org.orgId}`);

  await seedPayrollComponents(org.orgId, actorId, "US");
  await setPackSlotAccount(org.orgId, actorId, "US", "fit", irsPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "fica", irsPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "futa", futaPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "suta", sutaPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "local_income_tax", statePayable);

  const usSubId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${usSubId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);

  // The Default/EIN account and a Texas SUI account: the persona's shape.
  const einAccountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         is_default, is_active, created_by, updated_by)
    values (${einAccountId}, ${org.orgId}, 'US', 'us_ein', '12-3456789', 'Default employer',
            true, true, ${actorId}, ${actorId})`);
  const txSuiAccountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         state_code, is_active, created_by, updated_by)
    values (${txSuiAccountId}, ${org.orgId}, 'US', 'us_state_sui', 'TX-001', 'Texas SUI',
            'TX', true, ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Tex Worker', ${usSubId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'USD', '45', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, '2026-07-18', 3,
            ${usSubId}, true, ${actorId}, ${actorId})`);
  // Assigned to the EIN account — NOT to any state SUI account.
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, filing_status, filing_account_id,
                                           is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'US', 'TX', 'hourly', 'single',
            ${einAccountId}, true, ${actorId}, ${actorId})`);
  // 160 hours in the period: 160 × 45 = 7,200 gross, past the $7,000 FUTA base.
  for (const [workedOn, hours] of [
    ["2026-07-06", 40], ["2026-07-08", 40], ["2026-07-10", 40], ["2026-07-14", 40],
  ] as const) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${workedOn}, ${hours}, 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`);
  }
  return {
    orgId: org.orgId, actorId, scheduleId, employeeId, einAccountId, txSuiAccountId, sutaPayable,
  };
}

async function suiRow(
  orgId: string, actorId: string, region: string, filingAccountId: string | null,
  rate: string, wageBase: string,
): Promise<void> {
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, filing_account_id,
                                         tax_year, rate_values, created_by, updated_by)
    values (${orgId}, 'US', 'us_sui', ${region}, ${filingAccountId}, 2026,
            ${JSON.stringify({ rate, wageBase })}::jsonb, ${actorId}, ${actorId})`);
}

test(
  "TX with no SUI rate refuses by name instead of accruing 0.00",
  { skip: !DB },
  async () => {
    const h = await seedTexasHarness();
    try {
      const run = await createPayRun({
        orgId: h.orgId, actorId: h.actorId, payScheduleId: h.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: h.orgId, documentId: run.documentId, actorId: h.actorId });
      assert.equal(result.employees, 0);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]!.employee, "Tex Worker");
      // The readiness detector's sentence, verbatim, prefixed by the employee.
      assert.match(
        result.errors[0]!.message,
        /no State unemployment \(SUI\) rate is configured for TX · the assigned filing account in 2026 — nothing is being accrued for it/,
      );
      // And nothing was accrued: no stub, no SUI line anywhere.
      const stubs = (await db.execute(sql`
        select 1 from pay_stubs where org_id = ${h.orgId} and pay_run_document_id = ${run.documentId}`));
      assert.equal(stubs.rows.length, 0);
    } finally {
      await dropScratchOrgReporting(h.orgId);
    }
  },
);

test(
  "TX with SUI rates on other accounts still refuses for the EIN-assigned employee",
  { skip: !DB },
  async () => {
    const h = await seedTexasHarness();
    try {
      // Three perfectly good rates — linked to accounts this employee is not on.
      const otherSui = randomUUID();
      await db.execute(sql`
        insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                             state_code, is_active, created_by, updated_by)
        values (${otherSui}, ${h.orgId}, 'US', 'us_state_sui', 'CA-001', 'California SUI',
                'CA', true, ${h.actorId}, ${h.actorId})`);
      await suiRow(h.orgId, h.actorId, "TX", h.txSuiAccountId, "0.034", "9000");
      await suiRow(h.orgId, h.actorId, "CA", otherSui, "0.034", "7000");
      await suiRow(h.orgId, h.actorId, "NY", otherSui, "0.041", "12700");
      const run = await createPayRun({
        orgId: h.orgId, actorId: h.actorId, payScheduleId: h.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: h.orgId, documentId: run.documentId, actorId: h.actorId });
      assert.equal(result.employees, 0, "a rate somewhere in the org must not pass");
      assert.equal(result.errors.length, 1);
      assert.match(
        result.errors[0]!.message,
        /Tex Worker: no State unemployment \(SUI\) rate is configured for TX · the assigned filing account/,
      );
    } finally {
      await dropScratchOrgReporting(h.orgId);
    }
  },
);

test(
  "TX with a resolving SUI rate computes, and the US arithmetic does not move",
  { skip: !DB },
  async () => {
    const h = await seedTexasHarness();
    try {
      await suiRow(h.orgId, h.actorId, "TX", h.txSuiAccountId, "0.027", "9000");
      await db.execute(sql`
        update employee_payroll_profiles set filing_account_id = ${h.txSuiAccountId}
         where org_id = ${h.orgId} and employee_party_id = ${h.employeeId}`);
      const run = await createPayRun({
        orgId: h.orgId, actorId: h.actorId, payScheduleId: h.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: h.orgId, documentId: run.documentId, actorId: h.actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);

      const stubs = (await db.execute<{ factors: Record<string, string>; gross: string }>(sql`
        select factors, gross from pay_stubs
         where org_id = ${h.orgId} and pay_run_document_id = ${run.documentId}`));
      assert.equal(stubs.rows.length, 1);
      const factors = stubs.rows[0]!.factors;
      assert.equal(stubs.rows[0]!.gross, "7200.0000");
      // The persona-tied arithmetic: 6.2% / 1.45% / 0.6% capped at 42.00 on
      // the first 7,000 of gross, plus 2.7% SUI under the 9,000 base.
      assert.equal(factors.SS, "446.4000");
      assert.equal(factors.MED, "104.4000");
      assert.equal(factors.FUTA, "42.0000");
      assert.equal(factors.SUTA, "194.4000");
      // FIT matches the Pub 15-T engine called directly with the same facts.
      const expected = calculatePub15T({
        payDate: "2026-07-21", periodsPerYear: 26, wages: "7200.00", filingStatus: "single",
        futaEffectiveRate: "0.006", sui: { rate: "0.027", wageBase: "9000" },
      });
      assert.equal(factors.FIT, expected.fit);
      assert.equal(factors.FUTA, expected.futa);
      assert.equal(factors.SUTA, expected.suta);

      await commitPayRun({ orgId: h.orgId, documentId: run.documentId, actorId: h.actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines
         where org_id = ${h.orgId} and document_id = ${run.documentId}`));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      const sutaLeg = glLines.rows.find((row) => row.account_id === h.sutaPayable);
      assert.ok(sutaLeg, "SUI liability posts to its slot account");
      assert.equal(sutaLeg!.amount, neg("194.4000"));
    } finally {
      await dropScratchOrgReporting(h.orgId);
    }
  },
);

test(
  "ON under the EHT exemption pays: no refusal, no HSF line, no Quebec account demand",
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
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          features: { payroll: true },
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
            countries: ["CA"],
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      // Every slot that applies in Ontario is mapped. The Quebec-only slots
      // (qc_income_tax, qpip, hsf) are deliberately left unmapped: an
      // Ontario-only tenant must not be asked for Revenu Québec accounts.
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Ontario Worker', true, '{}'::jsonb)`);
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
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                '0', 'accrue', true, ${actorId}, ${actorId})`);
      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      // No ca_eht rate: under the exemption the employer owes no EHT, and
      // zero is legitimate — the run pays without refusal.
      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);

      // Inert means absent: no Health Services Fund line anywhere on the stub.
      const hsfLines = (await db.execute(sql`
        select l.amount
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
          join pay_stubs s on s.id = l.stub_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and c.system_key = 'hsf'`));
      assert.equal(hsfLines.rows.length, 0);
      const stubs = (await db.execute<{ factors: Record<string, string> }>(sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}`));
      assert.ok(!("HSF" in stubs.rows[0]!.factors), "no HSF factor outside QC");
      assert.ok(!("HSF_EARN" in stubs.rows[0]!.factors));

      // And no demand for the Quebec-only control accounts — neither in the
      // setup state nor in the run pre-flight.
      const setup = await payrollSetupState(org.orgId);
      const slotBlockers = setup.checks.filter(
        (check) => check.code === "setup.slot" && !check.ok,
      );
      assert.deepEqual(
        slotBlockers.map((check) => check.detail).sort(),
        [],
        "Ontario-only tenant maps no Quebec account",
      );
      const readiness = await payRunReadiness(org.orgId, run.documentId);
      const runSlotBlockers = readiness.items.filter(
        (item) => item.code === "setup.slot" && item.severity === "blocker",
      );
      assert.deepEqual(runSlotBlockers, []);

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ amount: string }>(sql`
        select amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}`));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
