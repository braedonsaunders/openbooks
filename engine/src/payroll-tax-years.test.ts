import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { payRunReadiness, payrollSetupState } from "./payroll-readiness.ts";
import { orgYearEndFilings } from "./payroll-yearend.ts";
import { ratesForPayDate as caRatesForPayDate } from "./payroll/canada/rates.ts";
import { qcRatesForPayDate } from "./payroll/canada/quebec/rates.ts";
import { ratesForPayDate as usRatesForPayDate } from "./payroll/us/rates.ts";
import {
  assertPayrollTaxYearSupported,
  packsMissingTaxYearDeclarations,
  payrollDraftTaxYears,
  payrollSupportedTaxYears,
  payrollTaxYearCoverage,
  payrollTaxYearForDate,
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
  type PayrollTaxYearSupport,
} from "./payroll/tax-years.ts";
import { unfilledPaths, UNFILLED } from "./payroll/unfilled.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * A pack's tax-year coverage: declared, discoverable, and refused by name.
 *
 * The engines have always refused an untranscribed year. What they could not do
 * is ANSWER THE QUESTION before payroll ran, so the first sign that nobody had
 * loaded next year's tables was an exception from inside calculateStub, per
 * employee, in January.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("every installable pack declares which tax years its tables are loaded for", () => {
  assert.deepEqual(packsMissingTaxYearDeclarations(), []);
});

test("the declaration agrees with what the engines will actually calculate", () => {
  // The declaration is only worth having if it cannot drift from the tables. It
  // is derived from the edition lists themselves, so this asserts the round trip
  // rather than a duplicated literal.
  for (const year of payrollSupportedTaxYears("CA")) {
    assert.equal(caRatesForPayDate(`${year}-01-15`).year, year);
  }
  for (const year of payrollSupportedTaxYears("US")) {
    assert.equal(usRatesForPayDate(`${year}-01-15`).year, year);
  }
  for (const year of payrollSupportedTaxYears("CA", "QC")) {
    assert.equal(qcRatesForPayDate(`${year}-01-15`).year, year);
  }
  // And a year outside it throws, from the engine, exactly as before.
  const beyond = Math.max(...payrollSupportedTaxYears("CA")) + 1;
  assert.throws(() => caRatesForPayDate(`${beyond}-01-15`));
  assert.throws(() => usRatesForPayDate(`${beyond}-01-15`));
});

test("an unloaded year is named, with the year, the pack and the fix", () => {
  const beyond = Math.max(...payrollSupportedTaxYears("CA")) + 1;
  const problem = payrollTaxYearProblem("CA", beyond);
  assert.equal(problem?.kind, "missing");
  assert.match(problem!.message, new RegExp(`${beyond} statutory tables are not loaded for CA`));
  assert.match(problem!.message, /payroll-new-tax-year/);
  assert.match(problem!.message, /engine\/src\/payroll\/canada\/rates\.ts/);
  assert.equal(payrollTaxYearProblem("CA", 2026), null);
  assert.throws(() => assertPayrollTaxYearSupported("US", beyond), /not loaded for US/);
});

test("a region with its own tables can lag the country's, and says so", () => {
  // Quebec administers its own income tax and publishes its own guide, so
  // "loaded for Canada" and "loaded for a Quebec employee" are different facts.
  // Declared as a scaffolded QC year that the federal side already covers.
  const country = "ZY";
  const support: PayrollTaxYearSupport = {
    country,
    editions: [
      { year: 2026, label: "national 2026", effectiveFrom: "2026-01-01", citation: "n/a", status: "published" },
      { year: 2027, label: "national 2027", effectiveFrom: "2027-01-01", citation: "n/a", status: "published" },
      { year: 2026, label: "regional 2026", effectiveFrom: "2026-01-01", citation: "n/a", status: "published", region: "R1" },
      { year: 2027, label: "regional 2027", effectiveFrom: "2027-01-01", citation: "n/a", status: "draft", region: "R1" },
    ],
    regionsWithOwnTables: ["R1"],
    ratesModule: "nowhere",
    scaffold: { files: [], barrels: [], steps: [] },
  };
  registerPayrollTaxYears(support);
  try {
    assert.deepEqual(payrollSupportedTaxYears(country), [2026, 2027]);
    assert.deepEqual(payrollSupportedTaxYears(country, "R1"), [2026]);
    assert.deepEqual(payrollSupportedTaxYears(country, "R2"), [2026, 2027]);
    // A scaffolded-but-unfilled year is a LOUDER refusal than a missing one: the
    // module exists, so anything checking mere presence would have said yes.
    assert.deepEqual(payrollDraftTaxYears(country, "R1"), [2027]);
    const drafted = payrollTaxYearProblem(country, 2027, "R1");
    assert.equal(drafted?.kind, "draft");
    assert.match(drafted!.message, /scaffolded but not filled in/);
    assert.equal(payrollTaxYearProblem(country, 2027, "R2"), null);
    assert.throws(() => registerPayrollTaxYears(support), /already declared/);
  } finally {
    unregisterPayrollTaxYears(country);
  }
  assert.throws(() => payrollSupportedTaxYears(country), /declares no statutory tax years/);
});

test("the tax year of a date comes from the pack's own year definition", () => {
  // Both current packs answer "calendar", so the point of the call is that the
  // ARITHMETIC is the pack's — a pack with an April or July year does not have to
  // teach every surface about itself.
  assert.equal(payrollTaxYearForDate("CA", "2026-12-31").taxYear, 2026);
  assert.equal(payrollTaxYearForDate("US", "2026-01-01").taxYear, 2026);
  assert.equal(payrollTaxYearForDate("CA", "2026-06-15").problem, null);
});

test("coverage is reportable for a surface, editions and all", () => {
  const ca = payrollTaxYearCoverage().find((entry) => entry.country === "CA")!;
  assert.ok(ca.supported.includes(2026));
  assert.equal(ca.ratesModule, "engine/src/payroll/canada/rates.ts");
  assert.deepEqual(ca.regionsWithOwnTables, ["QC"]);
  // Both CRA editions plus Revenu Québec's, each with its agency's own stamp.
  assert.ok(ca.editions.some((edition) => edition.label.includes("122nd")));
  assert.ok(ca.editions.some((edition) => edition.region === "QC"));
  assert.ok(ca.editions.every((edition) => edition.citation.length > 0));
});

test("the UNFILLED sentinel is findable wherever a scaffold left one", () => {
  assert.deepEqual(unfilledPaths({ a: "1", b: { c: UNFILLED } }), ["b.c"]);
  assert.deepEqual(unfilledPaths([{ rate: UNFILLED }]), ["0.rate"]);
  assert.deepEqual(unfilledPaths({ a: "1" }), []);
});

/* ------------------------------------------------------------------ */
/* Against the database                                                */
/* ------------------------------------------------------------------ */

/** A minimal CA run for a chosen tax year, with nothing else wrong with it. */
async function seedRunForYear(taxYear: number) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
      payroll: { countries: ["CA"] },
    })}::jsonb where id = ${org.orgId}`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, ${`${taxYear}-07-18`}, 3, true,
            ${actorId}, ${actorId})`);
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Terry Worker', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2024-01-01', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2024-01-01', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, federal_claim_code,
                                           provincial_claim_code, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1, true,
            ${actorId}, ${actorId})`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, document_date, currency, status,
                           created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${`${taxYear}-07-21`}, 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, ${`${taxYear}-07-05`}, ${`${taxYear}-07-18`},
            ${`${taxYear}-07-21`}, ${taxYear}, 'draft', ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, documentId };
}

test(
  "a run in a year whose tables are not loaded is a named readiness BLOCKER",
  { skip: !DB },
  async () => {
    const unloaded = Math.max(...payrollSupportedTaxYears("CA")) + 1;
    const run = await seedRunForYear(unloaded);
    try {
      // The whole point: the operator learns this from the pre-flight, with the
      // year and the pack named, instead of from an exception thrown per employee
      // out of the middle of Calculate.
      const readiness = await payRunReadiness(run.orgId, run.documentId);
      const blocker = readiness.items.find((item) => item.code === "statutory.taxYear");
      assert.ok(blocker, `a ${unloaded} run must be blocked before it calculates`);
      assert.equal(blocker!.severity, "blocker");
      assert.match(blocker!.detail ?? "", new RegExp(`${unloaded} statutory tables are not loaded for CA`));
      assert.match(blocker!.href ?? "", /admin\/setup\/payroll/);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "a run in a loaded year raises no statutory-table blocker",
  { skip: !DB },
  async () => {
    const run = await seedRunForYear(2026);
    try {
      const readiness = await payRunReadiness(run.orgId, run.documentId);
      assert.deepEqual(
        readiness.items.filter((item) => item.code === "statutory.taxYear"), [],
        "2026 is loaded — the new check must not add noise to a normal payroll",
      );
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "the setup surface reports the current year's coverage per installed pack",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: { countries: ["CA", "US"] },
        })}::jsonb where id = ${org.orgId}`);
      const state = await payrollSetupState(org.orgId);
      const yearChecks = state.checks.filter((check) => check.code === "setup.taxYear");
      assert.equal(yearChecks.length, 2, "one per installed pack, from the pack's own declaration");
      for (const check of yearChecks) {
        assert.equal(check.severity, "blocker");
        // 2026 is the loaded year and today is inside it, so these pass; when the
        // calendar turns and nobody has transcribed the next edition, the setup
        // screen says so instead of the January payroll finding out.
        assert.equal(check.ok, true, check.detail ?? check.code);
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a year-end filing for an unloaded year refuses by name, for every pack's filings",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: { countries: ["CA", "US"] },
        })}::jsonb where id = ${org.orgId}`);
      const unloaded = Math.max(...payrollSupportedTaxYears("US")) + 1;
      const sections = await orgYearEndFilings(org.orgId, unloaded);
      assert.ok(sections.length > 0);
      for (const section of sections) {
        // The CA T4 already refused an unknown year through its box caps. The
        // W-2 and the 941 did not: they would have filed a year the engine
        // cannot withhold for, with no refusal anywhere on the page.
        assert.match(
          section.populationRefusal ?? "",
          new RegExp(`${unloaded} statutory tables are not loaded`),
          `${section.country} ${section.key}`,
        );
        assert.deepEqual(section.data.rows, []);
      }
      // A loaded year still populates normally (empty tenant, but no refusal).
      for (const section of await orgYearEndFilings(org.orgId, 2026)) {
        assert.equal(section.populationRefusal, null, `${section.country} ${section.key}`);
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
