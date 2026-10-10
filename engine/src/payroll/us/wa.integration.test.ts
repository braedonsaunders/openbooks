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
import { upsertStatutoryRate } from "../statutory-rates.ts";
import {
  createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../../testing/fixtures.ts";
import { seedUsSuiAccount } from "../filing-test-fixtures.ts";

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

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
}

async function waPayrollOrg(): Promise<Fixture> {
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
  for (const state of ["WA", "CA", "OH"]) {
    const filingAccountId = await seedUsSuiAccount(org.orgId, actorId, state);
    await upsertStatutoryRate({
      orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_sui",
      region: state, filingAccountId, taxYear: 2026, values: { rate: "0.03", wageBase: "7000" },
    });
    await upsertStatutoryRate({
      orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
      region: state, filingAccountId: null, taxYear: 2026, values: { rate: "0.006" },
    });
  }
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
  return { orgId: org.orgId, actorId, subsidiaryId, scheduleId };
}

async function waEmployee(
  fx: Fixture, name: string, state: string, residence?: string,
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
    values (${fx.orgId}, ${id}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  const suiAccountId = await seedUsSuiAccount(fx.orgId, fx.actorId, state);
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
            '{"alien_status": "us_person_or_resident_alien"}'::jsonb, '2026-01-01',
            ${fx.actorId}, ${fx.actorId})`);
  return id;
}

async function slotDetails(orgId: string, documentId: string): Promise<string[]> {
  const readiness = await payRunReadiness(orgId, documentId);
  return readiness.items
    .filter((item) => item.code === "setup.slot")
    .map((item) => item.detail ?? "");
}

describe("washington-obligation-derived-mappings", { skip: !DB }, () => {
  test("slot demand follows actual obligations: WA maps PFML/Cares, never SIT/LIT", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(details.includes("US · wa_pfml"), `demands the PFML mapping: ${details}`);
      assert.ok(details.includes("US · wa_cares"), `demands the Cares mapping: ${details}`);
      // fit/fica/futa/suta are mapped in this fixture, so they clear: the
      // mapping-independent demand shape (SUI/FUTA still demanded of a
      // Washington employer) is pinned below without any mapping.
      assert.ok(!details.some((detail) => detail.includes("state_income_tax")),
        `never demands a state income tax Washington does not levy: ${details}`);
      assert.ok(!details.some((detail) => detail.includes("local_income_tax")),
        `never demands a local income tax Tacoma does not levy: ${details}`);
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
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(details.includes("US · state_income_tax"), `demands SIT for California: ${details}`);
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
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
      });
      const details = await slotDetails(fx.orgId, run.documentId);
      assert.ok(details.includes("US · state_income_tax"),
        `a California resident owes California tax with no California work region: ${details}`);
      assert.ok(!details.some((detail) => detail.includes("local_income_tax")),
        `no local levy applies to either end: ${details}`);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("pack slot presence is obligation-derived without any mapping", async () => {
    const fx = await waPayrollOrg();
    try {
      const wa = await packSlotState(fx.orgId, ["US"], {}, new Map([["US", new Set(["WA"])]]));
      const waKeys = wa.find((pack) => pack.country === "US")!.slots.map((slot) => slot.key);
      assert.ok(waKeys.includes("wa_pfml") && waKeys.includes("wa_cares"), waKeys.join(","));
      assert.ok(waKeys.includes("suta") && waKeys.includes("futa"), waKeys.join(","));
      assert.ok(waKeys.includes("fit") && waKeys.includes("fica"), waKeys.join(","));
      assert.ok(!waKeys.includes("state_income_tax"), waKeys.join(","));
      assert.ok(!waKeys.includes("local_income_tax"), waKeys.join(","));
      const oh = await packSlotState(fx.orgId, ["US"], {}, new Map([["US", new Set(["OH"])]]));
      const ohKeys = oh.find((pack) => pack.country === "US")!.slots.map((slot) => slot.key);
      assert.ok(ohKeys.includes("state_income_tax") && ohKeys.includes("local_income_tax"), ohKeys.join(","));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a Washington run prices PFML and Cares with no SIT line", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      await upsertPayrollEmployerFact({
        orgId: fx.orgId, actorId: fx.actorId, subsidiaryId: fx.subsidiaryId, country: "US",
        factKey: "wa_pfml_employer_size", effectiveFrom: "2026-01-01",
        value: "fifty_or_more", changeReason: "fifty-plus employer",
      });
      const payable = (await db.execute<{ id: string }>(sql`
        select id from accounts where org_id = ${fx.orgId} and number = '2330'`)).rows[0]!.id;
      await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_pfml", payable);
      await setPackSlotAccount(fx.orgId, fx.actorId, "US", "wa_cares", payable);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
      });
      const result = await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);
      // $2,000 of wages: PFML totals $22.60 (1.13%), split $16.14/$6.46; Cares $11.60 (0.58%).
      const lines = (await db.execute<{ system_key: string | null; amount: string }>(sql`
        select c.system_key, l.amount::text as amount
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${run.documentId}`)).rows;
      const amount = (key: string) => lines.find((line) => line.system_key === key)?.amount;
      assert.equal(amount("wa_pfml_employee"), "16.1400");
      assert.equal(amount("wa_pfml_employer"), "6.4600");
      assert.equal(amount("wa_cares_employee"), "11.6000");
      assert.equal(amount("state_income_tax"), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("a Washington run without a recorded employer size refuses by name", async () => {
    const fx = await waPayrollOrg();
    try {
      await waEmployee(fx, "Wally WA", "WA");
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
      });
      const result = await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      assert.equal(result.employees, 0);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!.message, /wa_pfml_employer_size/);
      assert.match(result.errors[0]!.message, /Employer facts/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
});
