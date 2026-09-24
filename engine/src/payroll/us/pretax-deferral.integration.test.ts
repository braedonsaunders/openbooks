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
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";
import { calculatePub15T } from "./pub15t.ts";
import { form941Worksheet, w2Slips } from "../yearend.ts";
import { resolveUsSuiYtd, usEmployeeYtd } from "./compute-statutory.ts";

// The pack registry side effect every pay run reads through.
void PAYROLL_COUNTRY_PACKS;

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * US pre-tax deferrals: the wrong-money defect, proved fixed (DB partition).
 *
 * The US pack declares three `reduces: ["income"]` treatments (401(k)
 * elective deferrals, pre-tax union dues, pre-2019 alimony) and its own help
 * text promises "reduce FIT-able wages" — but `computeUsStatutory` priced
 * federal income tax off the raw `income` leg and never read `reducedBases`,
 * so a $200 401(k) deferral left FIT exactly where it was. And the W-2 query
 * summed `kind = 'earning'` only, so Box 1 reported the unreduced wage too:
 * over-withheld AND a W-2 that overstates wages, which is why the
 * over-withholding never surfaced as a refund at filing.
 *
 * The pair below is two identical Texas employees on one run — same salary
 * ($52,000/year = $2,000 a period), same single filing status, no W-4
 * extras — differing only in Dan's $200 recurring 401(k) deferral. Before
 * the fix both stubs carried identical FIT; after it Dan's FIT prices $1,800
 * of FIT-able wages while Social Security and Medicare do not move (401(k)
 * reduces FIT-able wages but NOT FICA wages, IRC §125/401(k)), and Box 1
 * reports $1,800 for Dan against $2,000 for Carl.
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
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, residence_region, pay_basis, filing_status,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'US', 'TX',
            null, 'salary', 'single', true, ${fx.actorId}, ${fx.actorId})`);
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
  "a $200 401(k) deferral reduces FIT but not FICA, and Box 1 reports the reduced wage",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      const carl = await usEmployee(fx, "Control Carl");
      const dan = await usEmployee(fx, "Deferral Dan");
      await assign401k(fx, dan);

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
      assert.ok(carlFactors && danFactors, "both Texans were paid");

      // The withholding leg: Dan prices $1,800 of FIT-able wages, Carl $2,000.
      // Pinned literals: $2,000 biweekly single prices $156.15, $1,800 prices
      // $132.15 — the $24.00 difference is the $200 deferral at the 12%
      // marginal rate, and each figure agrees with Pub 15-T called directly.
      assert.equal(carlFactors.FIT, "156.1500");
      assert.equal(danFactors.FIT, "132.1500");
      assert.equal(carlFactors.FIT, expectedFit(PERIOD_WAGES));
      assert.equal(danFactors.FIT, expectedFit("1800.0000"));
      assert.notEqual(
        danFactors.FIT, carlFactors.FIT,
        "the deferral must move FIT — identical figures are the defect",
      );
      // The negative: Social Security and Medicare price unreduced wages.
      assert.equal(carlFactors.SS, "124.0000");
      assert.equal(carlFactors.MED, "29.0000");
      assert.equal(danFactors.SS, carlFactors.SS);
      assert.equal(danFactors.MED, carlFactors.MED);
      // The trace factor moves with the base it prices (AU precedent).
      assert.equal(danFactors.I, "1800.0000");
      assert.equal(carlFactors.I, PERIOD_WAGES);

      await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });

      // The reporting leg: Box 1 reports the reduced wage; FICA boxes do not move.
      const slips = await w2Slips(fx.orgId, 2026);
      assert.equal(slips.length, 2);
      const carlSlip = slips.find((slip) => slip.employeePartyId === carl)!;
      const danSlip = slips.find((slip) => slip.employeePartyId === dan)!;
      assert.ok(carlSlip && danSlip, "both Texans have W-2 slips");
      assert.equal(carlSlip.box1Wages, "2000.0000");
      assert.equal(danSlip.box1Wages, "1800.0000");
      assert.notEqual(
        danSlip.box1Wages, carlSlip.box1Wages,
        "Box 1 must reflect the deferral — identical figures are the defect",
      );
      assert.equal(danSlip.box3SsWages, carlSlip.box3SsWages);
      assert.equal(danSlip.box5MedicareWages, carlSlip.box5MedicareWages);

      // Form 941 line 2 is the same federal-wage concept as Box 1: the
      // quarter totals $2,000 + $1,800, never $4,000.
      const quarters = await form941Worksheet(fx.orgId, 2026);
      assert.equal(quarters.length, 1);
      assert.equal(quarters[0]!.wages, "3800.0000");
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

      assert.throws(
        () => resolveUsSuiYtd("OR", stateHistory),
        /US SUI cannot be calculated for OR: prior insurable wages are recorded in TX/,
      );
      const sameStateHistory = await usEmployeeYtd({
        tx: db, orgId: fx.orgId, employeePartyId: employee, taxYear: 2026,
        documentId: randomUUID(),
      }, "TX");
      assert.equal(resolveUsSuiYtd("TX", sameStateHistory), PERIOD_WAGES,
        "same-state SUI history remains usable; FUTA retains its independent aggregate");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
