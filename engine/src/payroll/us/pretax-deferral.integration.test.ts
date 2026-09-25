import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "../packs.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../../testing/fixtures.ts";
import { calculatePub15T } from "./pub15t.ts";
import { form941Worksheet, w2Slips } from "../yearend.ts";
import { resolveUsSuiYtd, resolveUsSuiYtdForCoverage, usEmployeeYtd } from "./compute-statutory.ts";

// The pack registry side effect every pay run reads through.
void PAYROLL_COUNTRY_PACKS;

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * US income-base treatments: 401(k) deferrals reduce FIT, but union dues do
 * not. IRS Pub. 525 says employee-paid union dues cannot be excluded from
 * income; the same result must reach Pub. 15-T, W-2 box 1, and Form 941.
 *
 * The US pack's `union_dues` treatment was incorrectly declared to reduce
 * federal income-tax wages, and W-2 Box 1 and Form 941 line 2 subtracted it
 * too. IRS Pub. 525 says employee-paid union dues cannot be excluded from
 * income. A $200 deduction therefore changes net pay only: FIT, federal
 * taxable wage factors, Box 1 and Form 941 wages must match an otherwise
 * identical employee without dues. The 401(k) control proves that a genuine
 * federal income-tax deduction still reduces FIT and Box 1 while leaving
 * Social Security and Medicare wages unchanged.
 */

const PERIOD_START = "2026-07-05";
const PERIOD_END = "2026-07-18";
const PAY_DATE = "2026-07-21";
/** $52,000 a year at 26 periods — comfortably into every bracket. */
const PERIOD_WAGES = "2000.0000";
const DEFERRAL = "200.0000";

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  deferralPayable: string;
}

async function usPayrollOrg(): Promise<Fixture> {
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
  const deferralPayable = await account("2340", "401(k) payable", "liability_current");
  const statePayable = await account("2360", "State income tax payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["US"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "US");
  for (const slot of ["fit", "fica", "futa", "suta"]) {
    await setPackSlotAccount(org.orgId, actorId, "US", slot, irsPayable);
  }
  await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "local_income_tax", statePayable);
  // Texas SUI presence: asserted here is withholding, never SUI amounts, and
  // a live-but-unconfigured SUI refuses by name at calculate.
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{payroll,us}',
      coalesce(settings#>'{payroll,us}', '{}'::jsonb) || ${JSON.stringify({
        sui: { TX: { rate: "0.03", wageBase: "7000" } },
      })}::jsonb
    ) where id = ${org.orgId}`);
  // This integration suite tests SUI and filing aggregation; configure the
  // ordinary full-credit FUTA rate explicitly so it does not depend on a
  // Schedule A transcription for the test year.
  await db.execute(sql`
    insert into payroll_statutory_rates
      (org_id, country, rate_key, region, tax_year, rate_values, created_by, updated_by)
    values (${org.orgId}, 'US', 'us_futa', 'TX', 2026, '{"rate":"0.006"}'::jsonb,
            ${actorId}, ${actorId})
  `);

  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, ${PERIOD_END}, 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, subsidiaryId, scheduleId, deferralPayable };
}

async function usEmployee(fx: Fixture, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  // Stub calculation refuses employees without an HRM employment, so the hire
  // carries one and the profile points at it.
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           country, province, residence_region, pay_basis,
                                           filing_status, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${employmentId}, ${fx.scheduleId}, 'US', 'TX',
            null, 'salary', 'single', true, ${fx.actorId}, ${fx.actorId})`);
  // The federal calculation refuses payroll without a tax-residency status
  // (Pub. 15-T nonresident-alien rules), so every synthetic employee states
  // one — U.S. person, like the single filing status above.
  await db.execute(sql`
    insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                           region, sub_region, answers, effective_from,
                                           created_by, updated_by)
    values (${fx.orgId}, ${id}, 'US', 'us_w4_tax_residency', null, null,
            '{"alien_status": "us_person_or_resident_alien"}'::jsonb, '2026-01-01',
            ${fx.actorId}, ${fx.actorId})`);
  return id;
}

/** Dan's 401(k): a recurring pre-tax deduction carrying the pack's treatment. */
async function assign401k(fx: Fixture, employeePartyId: string): Promise<void> {
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, tax_treatment,
                                liability_account_id,
                                is_active, created_by, updated_by)
    values (${componentId}, ${fx.orgId}, 'K401', '401(k) elective deferral', 'deduction',
            'US', 'pension_f', ${fx.deferralPayable},
            true, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                         effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeePartyId}, ${componentId}, ${DEFERRAL}, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`update pay_component_earning_classifications set statutory_reporting_category = 'us_401k_elective_deferral' where org_id = ${fx.orgId} and pay_component_id = ${componentId}`);
}

/** Union dues are withheld from net pay but stay in federal taxable wages. */
async function assignUnionDues(fx: Fixture, employeePartyId: string): Promise<void> {
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, tax_treatment,
                                liability_account_id, is_active, created_by, updated_by)
    values (${componentId}, ${fx.orgId}, 'UNION-DUES', 'Union dues', 'deduction',
            'US', 'union_dues', ${fx.deferralPayable}, true, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                         effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeePartyId}, ${componentId}, ${DEFERRAL}, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
}

/** Pub 15-T called directly with the FIT-able wages — the agreement the stub must keep. */
function expectedFit(fitWages: string): string {
  return calculatePub15T({
    payDate: PAY_DATE,
    periodsPerYear: 26,
    wages: fitWages,
    supplemental: "0.0000",
    ficaWages: PERIOD_WAGES,
    futaWages: PERIOD_WAGES,
    filingStatus: "single",
    // The effective FUTA rate rides the call's own input — the engine passes
    // the configured rate the same way — because no 2026 Schedule A is
    // transcribed and the pure boundary refuses untranscribed years by name.
    futaEffectiveRate: "0.006",
    sui: { rate: "0.03", wageBase: "7000" },
  }).fit;
}

const stubFactors = async (fx: Fixture, documentId: string, employeePartyId: string) => {
  const r = (await db.execute<{ factors: Record<string, string> }>(sql`
    select factors from pay_stubs
     where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${employeePartyId}
  `));
  return r.rows[0]?.factors ?? null;
};

test(
  "a 401(k) deferral reduces FIT but union dues remain in federal wages",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      const carl = await usEmployee(fx, "Control Carl");
      const dan = await usEmployee(fx, "Deferral Dan");
      const ula = await usEmployee(fx, "Union Ula");
      await assign401k(fx, dan);
      await assignUnionDues(fx, ula);

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);

      const carlFactors = (await stubFactors(fx, run.documentId, carl))!;
      const danFactors = (await stubFactors(fx, run.documentId, dan))!;
      const ulaFactors = (await stubFactors(fx, run.documentId, ula))!;
      assert.ok(carlFactors && danFactors && ulaFactors, "all three Texans were paid");

      // The withholding leg: Dan prices $1,800 of FIT-able wages, Carl and
      // Ula each price $2,000.
      // Pinned literals: $2,000 biweekly single prices $156.15, $1,800 prices
      // $132.15 — the $24.00 difference is the $200 deferral at the 12%
      // marginal rate, and each figure agrees with Pub 15-T called directly.
      assert.equal(carlFactors.FIT, "156.1500");
      assert.equal(danFactors.FIT, "132.1500");
      assert.equal(carlFactors.FIT, expectedFit(PERIOD_WAGES));
      assert.equal(danFactors.FIT, expectedFit("1800.0000"));
      // IRS Pub. 525, "Union benefits and dues": employee-paid dues cannot be
      // excluded from income. Published guidance: https://www.irs.gov/publications/p525
      assert.equal(ulaFactors.FIT, "156.1500");
      assert.equal(ulaFactors.I, PERIOD_WAGES);
      assert.notEqual(
        danFactors.FIT, carlFactors.FIT,
        "the deferral must move FIT — identical figures are the defect",
      );
      // The negative: Social Security and Medicare price unreduced wages.
      assert.equal(carlFactors.SS, "124.0000");
      assert.equal(carlFactors.MED, "29.0000");
      assert.equal(danFactors.SS, carlFactors.SS);
      assert.equal(danFactors.MED, carlFactors.MED);
      assert.equal(ulaFactors.SS, carlFactors.SS);
      assert.equal(ulaFactors.MED, carlFactors.MED);
      // The trace factor moves with the base it prices (AU precedent).
      assert.equal(danFactors.I, "1800.0000");
      assert.equal(carlFactors.I, PERIOD_WAGES);

      await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });

      // Box 1 reflects valid federal reductions only; union dues leave wages intact.
      const slips = await w2Slips(fx.orgId, 2026);
      assert.equal(slips.length, 3);
      const carlSlip = slips.find((slip) => slip.employeePartyId === carl)!;
      const danSlip = slips.find((slip) => slip.employeePartyId === dan)!;
      const ulaSlip = slips.find((slip) => slip.employeePartyId === ula)!;
      assert.ok(carlSlip && danSlip && ulaSlip, "all three Texans have W-2 slips");
      assert.equal(carlSlip.box1Wages, "2000.0000");
      assert.equal(danSlip.box1Wages, "1800.0000");
      assert.equal(danSlip.box12Lines?.find((line) => line.code === "D")?.value, "200.0000"); // IRS 2026 W-2 instructions, Box 12: https://www.irs.gov/instructions/iw2w3
      assert.equal(ulaSlip.box1Wages, "2000.0000");
      assert.notEqual(
        danSlip.box1Wages, carlSlip.box1Wages,
        "Box 1 must reflect the deferral — identical figures are the defect",
      );
      assert.equal(danSlip.box3SsWages, carlSlip.box3SsWages);
      assert.equal(danSlip.box5MedicareWages, carlSlip.box5MedicareWages);

      // Form 941 line 2 is the same federal-wage concept as Box 1: the
      // quarter totals $2,000 + $1,800 + $2,000; dues do not lower line 2.
      const quarters = await form941Worksheet(fx.orgId, 2026);
      assert.equal(quarters.length, 1);
      assert.equal(quarters[0]!.wages, "5800.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "Form 941 reports Additional Medicare wages and tax separately on line 5d",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      const employee = await usEmployee(fx, "Additional Medicare employee");
      await db.execute(sql`
        update labor_cost_rates set rate = '5330000'
         where org_id = ${fx.orgId} and employee_party_id = ${employee}
           and effective_from = '2026-01-01'
      `);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });

      const quarters = await form941Worksheet(fx.orgId, 2026);
      assert.equal(quarters.length, 1);
      assert.equal(quarters[0]!.medicareWages, "205000.0000");
      assert.equal(quarters[0]!.medicareTax, "5945.0000");
      assert.equal(quarters[0]!.additionalMedicareWages, "5000.0000");
      assert.equal(quarters[0]!.additionalMedicareTax, "45.0000");
      const usPack = PAYROLL_COUNTRY_PACKS.US;
      assert.ok(usPack, "US payroll pack is registered");
      const form941 = usPack.filings().yearEnd.find((filing) => filing.key === "941");
      assert.ok(form941?.slip, "the US pack declares the Form 941 slip");
      const slip = await form941.slip.build(fx.orgId, 2026, ":3");
      assert.equal(slip.boxes.find((box) => box.code === "5d")?.value, "5000.0000");
      assert.equal(slip.boxes.find((box) => box.code === "5d tax")?.value, "45.0000");
      assert.equal(slip.boxes.find((box) => box.code === "5e")?.value, "28868.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "US SUI refuses out-of-state wage history until its transfer treatment is configured",
  { skip: !DB },
  async () => {
    // Oregon's Employment Department says prior taxable wages paid in other
    // states may reduce Oregon's wage-base room (UI PUB 217,
    // https://www.oregon.gov/employ/Businesses/Documents/Tax/uipub217.pdf).
    // California separately allows certain same-year out-of-state wage
    // credits on transfer (EDD Employer's Guide,
    // https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de44.pdf). The test
    // therefore requires a named refusal until state-specific history and
    // eligibility can distinguish these rules.
    const fx = await usPayrollOrg();
    try {
      const employee = await usEmployee(fx, "Multi-state SUI employee");
      for (const [region, rate, wageBase] of [
        ["TX", "0.03", "7000"],
        ["OR", "0.03", "56700"],
      ] as const) {
        await db.execute(sql`
          insert into payroll_statutory_rates
            (org_id, country, rate_key, region, tax_year, rate_values, created_by, updated_by)
          values (${fx.orgId}, 'US', 'us_sui', ${region}, 2026,
                  ${JSON.stringify({ rate, wageBase })}::jsonb, ${fx.actorId}, ${fx.actorId})`);
      }
      const firstRun = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const firstResult = await calculatePayRun({
        orgId: fx.orgId, documentId: firstRun.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(firstResult.errors, []);
      await commitPayRun({ orgId: fx.orgId, documentId: firstRun.documentId, actorId: fx.actorId });

      await db.execute(sql`
        update employee_payroll_profiles set province = 'OR'
         where org_id = ${fx.orgId} and employee_party_id = ${employee}`);
      await db.execute(sql`
        update orgs set settings = jsonb_set(
          settings, '{payroll,us,sui,OR}', '{"rate":"0.03","wageBase":"56700"}'::jsonb, true
        ) where id = ${fx.orgId}`);
      const priorStateStub = (await db.execute<{ province: string }>(sql`
        select province from pay_stubs
         where org_id = ${fx.orgId} and employee_party_id = ${employee}
      `)).rows[0];
      assert.equal(priorStateStub?.province, "TX", "the committed stub preserves the prior work state");
      const stateHistory = await usEmployeeYtd({
        tx: db, orgId: fx.orgId, employeePartyId: employee, taxYear: 2026,
        documentId: randomUUID(),
      }, "OR");
      assert.equal(stateHistory.suiOtherRegions, "TX", "SUI history is state-dimensioned independently of FUTA");

      // SUI-TRANSFER-CREDIT-IMPL: Oregon prices the Texas stub under its
      // aggregate transfer rule instead of refusing — the same-employer
      // wages are in the system, so the base follows them to the new state.
      assert.equal(resolveUsSuiYtdForCoverage("OR", 2026, stateHistory, false), PERIOD_WAGES,
        "Oregon credits prior-state same-employer wages toward its base");
      assert.equal(resolveUsSuiYtdForCoverage("OR", 2026, stateHistory, true), "0");
      const sameStateHistory = await usEmployeeYtd({
        tx: db, orgId: fx.orgId, employeePartyId: employee, taxYear: 2026,
        documentId: randomUUID(),
      }, "TX");
      assert.equal(resolveUsSuiYtd("TX", 2026, sameStateHistory), PERIOD_WAGES,
        "same-state SUI history remains usable; FUTA retains its independent aggregate");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "FUTA and SUI exemptions independently control their employer contribution lines",
  { skip: !DB },
  async () => {
    // FUTA federal employment exclusions and state UI coverage are separate;
    // California describes tax-rated UI and reimbursable employers separately:
    // https://www.irs.gov/publications/p15 and https://edd.ca.gov/tax-rated-employers.
    const fx = await usPayrollOrg();
    try {
      const futaOnlyExempt = await usEmployee(fx, "FUTA-only exempt employee");
      const suiOnlyExempt = await usEmployee(fx, "SUI-only exempt employee");
      await db.execute(sql`
        update employee_payroll_profiles set futa_exempt = true
         where org_id = ${fx.orgId} and employee_party_id = ${futaOnlyExempt}`);
      await db.execute(sql`
        update employee_payroll_profiles set sui_exempt = true
         where org_id = ${fx.orgId} and employee_party_id = ${suiOnlyExempt}`);

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      const lines = (await db.execute<{
        employee_party_id: string; system_key: string; amount: string;
      }>(sql`
        select s.employee_party_id, pc.system_key, coalesce(sum(l.amount), 0)::text as amount
          from pay_stubs s
          join pay_stub_lines l on l.org_id = s.org_id and l.stub_id = s.id
          join pay_components pc on pc.org_id = l.org_id and pc.id = l.component_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.kind = 'employer_contribution' and pc.system_key in ('futa', 'suta')
         group by s.employee_party_id, pc.system_key`)).rows;
      const amount = (employee: string, systemKey: string) =>
        lines.find((line) => line.employee_party_id === employee && line.system_key === systemKey)?.amount ?? "0";
      assert.equal(amount(futaOnlyExempt, "futa"), "0");
      assert.equal(amount(futaOnlyExempt, "suta"), "60.0000");
      assert.equal(amount(suiOnlyExempt, "futa"), "12.0000");
      assert.equal(amount(suiOnlyExempt, "suta"), "0");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
