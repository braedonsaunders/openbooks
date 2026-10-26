import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { packSlotState, setPackSlotAccount } from "../packs.ts";
import { payRunReadiness } from "../readiness.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { upsertPayrollEmployerFact } from "../employer-fact-store.ts";
import { US_PACK_RATES } from "./rates.ts";
import { usPayrollConfig } from "./config.ts";
import { waPackCoversYear, waPfmlWithholding } from "./states/wa.ts";
import { payrollPack } from "../packs.ts";
import { upsertStatutoryRate } from "../statutory-rates.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
} from "../../testing/fixtures.ts";
import { seedUsSuiAccount, seedUsEinAccount } from "../filing-test-fixtures.ts";

/**
 * Washington payroll: no state or local income tax, but PFML, WA Cares,
 * SUI and FUTA all apply.
 *
 * The pay run used to demand state- and local-income-tax account mappings
 * of every US employer — including a Washington one, where neither tax
 * exists — while pricing no Washington levy at all. These tests pin the
 * obligation-derived demand: a Washington-only run maps PFML, Cares, SUI
 * and FUTA (and still prices them), never SIT/LIT; a levying state still
 * demands its own.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const PAY_DATE = "2026-07-21";
const PERIOD_START = "2026-07-05";
const PERIOD_END = "2026-07-18";

/**
 * The 2025 run the pack refused before the year shipped: pay date
 * 2025-10-16, on a biweekly period ending three days earlier, exactly like
 * the 2026 fixture's shape.
 */
const DATES_2025 = { payDate: "2025-10-16", periodStart: "2025-09-30", periodEnd: "2025-10-13" };

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  einAccountId: string;
  scheduleId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
}

async function waPayrollOrg(year = 2026): Promise<Fixture> {
  const dates =
    year === 2025
      ? DATES_2025
      : { payDate: PAY_DATE, periodStart: PERIOD_START, periodEnd: PERIOD_END };
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
  const payrollPayable = await account("2330", "Payroll taxes payable", "liability_current");
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
  // Federal + SUI mappings only: the Washington levies stay unmapped until
  // the tests map them, and SIT/LIT are never mapped here by design.
  for (const slot of ["fit", "fica", "futa", "suta"]) {
    await setPackSlotAccount(org.orgId, actorId, "US", slot, payrollPayable);
  }
  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const einAccountId = await seedUsEinAccount(org.orgId, actorId, subsidiaryId, "12-3456789");
  for (const state of ["WA", "CA", "OH"]) {
    const filingAccountId = await seedUsSuiAccount(org.orgId, actorId, state, {
      federalAccountId: einAccountId,
      subsidiaryId,
      effectiveFrom: `${year}-01-01`,
      effectiveTo: null,
      sourceReference: `${state} original employer registration`,
    });
    await upsertStatutoryRate({
      orgId: org.orgId,
      actorId,
      rates: US_PACK_RATES,
      rateKey: "us_sui",
      region: state,
      filingAccountId,
      taxYear: year,
      values: { rate: "0.03", wageBase: "7000" },
      sourceCitation: "Test rate notice",
      reason: "test fixture rate",
    });
    await upsertStatutoryRate({
      orgId: org.orgId,
      actorId,
      rates: US_PACK_RATES,
      rateKey: "us_futa",
      region: state,
      filingAccountId: null,
      taxYear: year,
      values: { rate: "0.006" },
      sourceCitation: "Test rate notice",
      reason: "test fixture rate",
    });
  }
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, ${dates.periodEnd}, 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, subsidiaryId, einAccountId, scheduleId, ...dates };
}

async function waEmployee(
  fx: Fixture,
  name: string,
  state: string,
  residence?: string,
  annualSalary = "52000",
  year = 2026,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'USD', ${annualSalary}, 'year', 2080, ${`${year}-01-01`}, true,
            ${fx.actorId}, ${fx.actorId})`);
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  const suiAccountId = await seedUsSuiAccount(fx.orgId, fx.actorId, state, {
    federalAccountId: fx.einAccountId,
    subsidiaryId: fx.subsidiaryId,
    effectiveFrom: `${year}-01-01`,
    effectiveTo: null,
    sourceReference: `${state} original employer registration`,
  });
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           country, province, residence_region, pay_basis,
                                           filing_status, filing_account_id, is_active,
                                           created_by, updated_by)
    values (${fx.orgId}, ${id}, ${employmentId}, ${fx.scheduleId}, 'US', ${state},
            ${residence ?? null}, 'salary', 'single', ${suiAccountId}, true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                           region, sub_region, answers, effective_from,
                                           created_by, updated_by)
    values (${fx.orgId}, ${id}, 'US', 'us_w4_tax_residency', null, null,
            '{"alien_status": "us_person_or_resident_alien"}'::jsonb, ${`${year}-01-01`},
            ${fx.actorId}, ${fx.actorId})`);
  return id;
}

async function slotDetails(orgId: string, documentId: string): Promise<string[]> {
  const readiness = await payRunReadiness(orgId, documentId);
  return readiness.items
    .filter((item) => item.code === "setup.slot")
    .map((item) => item.detail ?? "");
}

/**
 * One priced Washington run for a recorded employer size: maps the PFML and
 * Cares slots, calculates on the fixture's dates, and returns the stub
 * lines. Refusals fail the test — a priced run prices cleanly.
 */
async function priceWashingtonRun(
  fx: Fixture,
  employerSize: "fifty_or_more" | "fewer_than_fifty",
  year: number,
): Promise<{ system_key: string | null; amount: string }[]> {
  await upsertPayrollEmployerFact({
    orgId: fx.orgId,
    actorId: fx.actorId,
    subsidiaryId: fx.subsidiaryId,
    country: "US",
    factKey: "wa_pfml_employer_size",
    effectiveFrom: `${year}-01-01`,
    value: employerSize,
    changeReason: "recorded employer size",
  });
  const payable = (
    await db.execute<{ id: string }>(
      sql`
    select id from accounts where org_id = ${fx.orgId} and number = '2330'`,
      "objects",
    )
  )[0]!.id;
  await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_pfml", payable);
  await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_cares", payable);
  const run = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: fx.periodStart,
    periodEnd: fx.periodEnd,
    payDate: fx.payDate,
  });
  const result = await calculatePayRun({
    orgId: fx.orgId,
    documentId: run.documentId,
    actorId: fx.actorId,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.employees, 1);
  return await db.execute<{ system_key: string | null; amount: string }>(
    sql`
    select c.system_key, l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${run.documentId}`,
    "objects",
  );
}

describe("washington-obligation-derived-mappings", { skip: !DB }, () => {
  test("slot demand follows actual obligations: WA maps PFML/Cares, never SIT/LIT", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(details.includes("US · wa_pfml"), `demands the PFML mapping: ${details}`);
      assert.ok(details.includes("US · wa_cares"), `demands the Cares mapping: ${details}`);
      // fit/fica/futa/suta are mapped in this fixture, so they clear: the
      // mapping-independent demand shape (SUI/FUTA still demanded of a
      // Washington employer) is pinned below without any mapping.
      assert.ok(
        !details.some((detail) => detail.includes("state_income_tax")),
        `never demands a state income tax Washington does not levy: ${details}`,
      );
      assert.ok(
        !details.some((detail) => detail.includes("local_income_tax")),
        `never demands a local income tax Tacoma does not levy: ${details}`,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("levying states still demand their mappings: CA demands SIT, OH demands LIT", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Cally CA", "CA");
      await waEmployee(fx, "Ollie OH", "OH");
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(
        details.includes("US · state_income_tax"),
        `demands SIT for California: ${details}`,
      );
      assert.ok(details.includes("US · local_income_tax"), `demands LIT for Ohio: ${details}`);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("residence is a second claim: WA work with CA residence demands SIT", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Rita Crossborder", "WA", "CA");
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(
        details.includes("US · state_income_tax"),
        `a California resident owes California tax with no California work region: ${details}`,
      );
      assert.ok(
        !details.some((detail) => detail.includes("local_income_tax")),
        `no local levy applies to either end: ${details}`,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("pack slot presence is obligation-derived without any mapping", async () => {
    const fx = await waPayrollOrg();
    try {
      const wa = await packSlotState(fx.orgId, ["US"], new Map([["US", new Set(["WA"])]]));
      const waKeys = wa.find((pack) => pack.country === "US")!.slots.map((slot) => slot.key);
      assert.ok(waKeys.includes("wa_pfml") && waKeys.includes("wa_cares"), waKeys.join(","));
      assert.ok(waKeys.includes("suta") && waKeys.includes("futa"), waKeys.join(","));
      assert.ok(waKeys.includes("fit") && waKeys.includes("fica"), waKeys.join(","));
      assert.ok(!waKeys.includes("state_income_tax"), waKeys.join(","));
      assert.ok(!waKeys.includes("local_income_tax"), waKeys.join(","));
      const oh = await packSlotState(fx.orgId, ["US"], new Map([["US", new Set(["OH"])]]));
      const ohKeys = oh.find((pack) => pack.country === "US")!.slots.map((slot) => slot.key);
      assert.ok(
        ohKeys.includes("state_income_tax") && ohKeys.includes("local_income_tax"),
        ohKeys.join(","),
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a Washington run prices PFML and Cares with no SIT line", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      await upsertPayrollEmployerFact({
        orgId: fx.orgId,
        actorId: fx.actorId,
        subsidiaryId: fx.subsidiaryId,
        country: "US",
        factKey: "wa_pfml_employer_size",
        effectiveFrom: "2026-01-01",
        value: "fifty_or_more",
        changeReason: "fifty-plus employer",
      });
      const payable = (
        await db.execute<{ id: string }>(
          sql`
        select id from accounts where org_id = ${fx.orgId} and number = '2330'`,
          "objects",
        )
      )[0]!.id;
      await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_pfml", payable);
      await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_cares", payable);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
      });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);
      // $2,000 of wages: PFML totals $22.60 (1.13%), split $16.14/$6.46; Cares $11.60 (0.58%).
      const lines = await db.execute<{ system_key: string | null; amount: string }>(
        sql`
        select c.system_key, l.amount::text as amount
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${run.documentId}`,
        "objects",
      );
      const amount = (key: string) => lines.find((line) => line.system_key === key)?.amount;
      assert.equal(amount("wa_pfml_employee"), "16.1400");
      assert.equal(amount("wa_pfml_employer"), "6.4600");
      assert.equal(amount("wa_cares_employee"), "11.6000");
      assert.equal(amount("state_income_tax"), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a 2025 Washington run prices PFML 71.52/28.48 and Cares exactly", async () => {
    // The 2025-10-16 run this pack used to refuse: $2,000 of wages prices
    // $18.40 of PFML (0.92%), split $13.16 employee / $5.24 employer, and
    // $11.60 of WA Cares (0.58%) — decimal-exact on the stub, no SIT line.
    const fx = await waPayrollOrg(2025);
    try {
      await waEmployee(fx, "Wally WA", "WA", undefined, "52000", 2025);
      const lines = await priceWashingtonRun(fx, "fifty_or_more", 2025);
      const amount = (key: string) => lines.find((line) => line.system_key === key)?.amount;
      assert.equal(amount("wa_pfml_employee"), "13.1600");
      assert.equal(amount("wa_pfml_employer"), "5.2400");
      assert.equal(amount("wa_cares_employee"), "11.6000");
      assert.equal(amount("state_income_tax"), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a 2025 Washington run caps PFML at the Social Security base while Cares stays uncapped", async () => {
    // $200,000 of wages against the $176,100 base: PFML prices the room
    // ($1,620.12 total, $1,158.71 employee / $461.41 employer) while WA
    // Cares prices the whole cheque ($1,160.00) — the cap binds one levy
    // and not the other.
    const fx = await waPayrollOrg(2025);
    try {
      await waEmployee(fx, "Hetty High", "WA", undefined, "5200000", 2025);
      const lines = await priceWashingtonRun(fx, "fifty_or_more", 2025);
      const amount = (key: string) => lines.find((line) => line.system_key === key)?.amount;
      assert.equal(amount("wa_pfml_employee"), "1158.7100");
      assert.equal(amount("wa_pfml_employer"), "461.4100");
      assert.equal(amount("wa_cares_employee"), "1160.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a 2025 Washington run for a small employer withholds PFML with no employer share", async () => {
    // Fewer than 50 employees: the $13.16 employee share is still withheld
    // and remitted, but the employer owes no share of the premium — so no
    // employer line posts at all (zero statutory lines never post).
    const fx = await waPayrollOrg(2025);
    try {
      await waEmployee(fx, "Wally WA", "WA", undefined, "52000", 2025);
      const lines = await priceWashingtonRun(fx, "fewer_than_fifty", 2025);
      const amount = (key: string) => lines.find((line) => line.system_key === key)?.amount;
      assert.equal(amount("wa_pfml_employee"), "13.1600");
      assert.equal(amount("wa_pfml_employer"), undefined);
      assert.equal(amount("wa_cares_employee"), "11.6000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("an operator-entered 2027 back-fill resolves and prices through the pack engine", async () => {
    // A year the pack has not shipped prices from the entered row: the write
    // boundary canonicalizes the figures, the config resolves them at the
    // Washington scope point, and the pack engine prices them exactly —
    // while the pack keeps winning wherever its own table is published.
    const fx = await waPayrollOrg();
    try {
      await upsertStatutoryRate({
        orgId: fx.orgId,
        actorId: fx.actorId,
        rates: US_PACK_RATES,
        rateKey: "us_wa_pfml",
        region: "WA",
        filingAccountId: null,
        taxYear: 2027,
        values: {
          totalRate: "0.01",
          employeeShare: "0.70",
          employerShare: "0.30",
          wageBase: "180000",
          caresRate: "0.0058",
        },
        sourceCitation: "Test rate notice",
        reason: "test fixture rate",
      });
      const config = await usPayrollConfig(fx.orgId, 2027, "2027-03-15");
      const entered = config.waBackfill("WA");
      assert.deepEqual(entered, {
        totalRate: "0.0100",
        employeeShare: "0.7000",
        employerShare: "0.3000",
        wageBase: "180000.00",
        caresRate: "0.0058",
      });
      assert.ok(!waPackCoversYear(2027));
      const pfml = waPfmlWithholding("2027-03-15", "10000.00", "0", "fifty_or_more", {
        pfmlTotalRate: entered!.totalRate,
        pfmlEmployeeShare: entered!.employeeShare,
        pfmlEmployerShare: entered!.employerShare,
        pfmlWageBase: entered!.wageBase,
        caresRate: entered!.caresRate,
      });
      assert.equal(pfml.total, "100.0000");
      assert.equal(pfml.employee, "70.0000");
      assert.equal(pfml.employer, "30.0000");
      // No row was entered for a covered year, and none is read there.
      const covered = await usPayrollConfig(fx.orgId, 2026, "2026-07-21");
      assert.equal(covered.waBackfill("WA"), undefined);
      assert.ok(waPackCoversYear(2026));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("the back-fill slot stands down wherever the pack covers the year", async () => {
    // The waiver is the pack winning, stated once: a covered pay date
    // waives the slot (no advisory, no demand), an uncovered one keeps it
    // live, and other states never see it.
    const fx = await waPayrollOrg();
    try {
      const pack = payrollPack("US");
      assert.ok(pack.waivedRateSlots);
      const covered = await pack.waivedRateSlots!(db, {
        orgId: fx.orgId,
        subsidiaryId: fx.subsidiaryId,
        region: "WA",
        filingAccountId: null,
        payDate: "2026-07-21",
      });
      assert.ok(covered.includes("us_wa_pfml"));
      const uncovered = await pack.waivedRateSlots!(db, {
        orgId: fx.orgId,
        subsidiaryId: fx.subsidiaryId,
        region: "WA",
        filingAccountId: null,
        payDate: "2027-03-15",
      });
      assert.ok(!uncovered.includes("us_wa_pfml"));
      const otherState = await pack.waivedRateSlots!(db, {
        orgId: fx.orgId,
        subsidiaryId: fx.subsidiaryId,
        region: "CA",
        filingAccountId: null,
        payDate: "2026-07-21",
      });
      assert.ok(!otherState.includes("us_wa_pfml"));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a Washington run without a recorded employer size refuses by name", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
      });
      assert.equal(result.employees, 0);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!.message, /wa_pfml_employer_size/);
      assert.match(result.errors[0]!.message, /Employer facts/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("statutory mappings require their native country components", async () => {
    const fx = await waPayrollOrg();
    try {
      const baselineAccount = randomUUID();
      const scopedAccount = randomUUID();
      for (const [id, number, name] of [
        [baselineAccount, "2380", "Baseline payroll liabilities"],
        [scopedAccount, "2381", "Scoped payroll liabilities"],
      ] as const) {
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${fx.orgId}, ${number}, ${name}, 'liability_current', false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
      }
      for (const code of ["WA-PFML", "WA-CARES"]) {
        await db.execute(sql`
          insert into pay_components (org_id, code, name, kind, system_key, country, basis, taxable,
                                      pensionable, insurable, vacationable, non_periodic, sequence,
                                      liability_account_id, created_by, updated_by)
          select ${fx.orgId}, code, name, kind, system_key, null, basis, taxable,
                 pensionable, insurable, vacationable, non_periodic, sequence,
                 ${baselineAccount}, ${fx.actorId}, ${fx.actorId}
            from pay_components where org_id = ${fx.orgId} and country = 'US' and code = ${code}`);
      }
      const shown = await packSlotState(fx.orgId, ["US"]);
      const us = shown.find((pack) => pack.country === "US")!;
      assert.equal(us.slots.find((slot) => slot.key === "wa_pfml")?.accountId, null);
      assert.equal(us.slots.find((slot) => slot.key === "wa_cares")?.accountId, null);
      // Only the declared country components supply the account.
      await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_pfml", scopedAccount);
      const reshown = await packSlotState(fx.orgId, ["US"]);
      const reus = reshown.find((pack) => pack.country === "US")!;
      assert.equal(reus.slots.find((slot) => slot.key === "wa_pfml")?.accountId, scopedAccount);
      assert.equal(reus.slots.find((slot) => slot.key === "wa_cares")?.accountId, null);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
});
