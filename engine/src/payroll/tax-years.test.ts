import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { formatInZone } from "../platform/business-date.ts";
import { now, withSimClock } from "../platform/clock.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { payRunReadiness, payrollSetupState } from "./readiness.ts";
import { orgYearEndFilings } from "./yearend.ts";
import { ratesForPayDate as caRatesForPayDate } from "./canada/rates.ts";
import { qcRatesForPayDate } from "./canada/quebec/rates.ts";
import { ratesForPayDate as usRatesForPayDate } from "./us/rates.ts";
import {
  payrollDraftTaxYears,
  payrollSupportedTaxYears,
  type PayrollTaxYearSupport,
} from "./tax-years.ts";
import {
  assertPayrollTaxYearSupported,
  PAYROLL_COUNTRY_PACKS,
  payrollTaxYearCoverage,
  payrollTaxYearForDate,
  payrollTaxYearProblem,
  type PayrollTaxYearCoverage,
  payrollTaxYearSupport,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "./packs.ts";
import { unfilledPaths, UNFILLED } from "./unfilled.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

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
  // The registry reads the declaration off the pack (no second list), so
  // reachability by country IS the assertion — an undeclared pack refuses by
  // name instead of returning a neighbour's years.
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS).filter((p) => p.installable)) {
    assert.equal(payrollTaxYearSupport(pack.country).country, pack.country);
  }
  assert.throws(() => payrollTaxYearSupport("XX"), /declares no statutory tax years/);
});

test("the declaration agrees with what the engines will actually calculate", () => {
  // The declaration is only worth having if it cannot drift from the tables. It
  // is derived from the edition lists themselves, so this asserts the round trip
  // rather than a duplicated literal.
  for (const year of payrollSupportedTaxYears(payrollTaxYearSupport("CA"))) {
    assert.equal(caRatesForPayDate(`${year}-01-15`).year, year);
  }
  for (const year of payrollSupportedTaxYears(payrollTaxYearSupport("US"))) {
    assert.equal(usRatesForPayDate(`${year}-01-15`).year, year);
  }
  for (const year of payrollSupportedTaxYears(payrollTaxYearSupport("CA"), "QC")) {
    assert.equal(qcRatesForPayDate(`${year}-01-15`).year, year);
  }
  // And a year outside it throws, from the engine, exactly as before.
  const beyond = Math.max(...payrollSupportedTaxYears(payrollTaxYearSupport("CA"))) + 1;
  assert.throws(() => caRatesForPayDate(`${beyond}-01-15`));
  assert.throws(() => usRatesForPayDate(`${beyond}-01-15`));
});

test("an unloaded year is named, with the year, the pack and the fix", () => {
  const beyond = Math.max(...payrollSupportedTaxYears(payrollTaxYearSupport("CA"))) + 1;
  const problem = payrollTaxYearProblem("CA", beyond);
  assert.equal(problem?.kind, "missing");
  assert.match(problem!.message, new RegExp(`${beyond} statutory tables are not loaded for CA`));
  assert.match(problem!.message, /payroll-new-tax-year/);
  assert.match(problem!.message, /engine\/src\/payroll\/canada\/rates\.ts/);
  assert.equal(payrollTaxYearProblem("CA", 2026), null);
  assert.throws(() => assertPayrollTaxYearSupported("US", beyond), /not loaded for US/);
});

test("an unsupported year tells the operator what is published, with no developer remedy", () => {
  // REALISTIC: ES publishes 2026 only, so 2025 is a real pack with a real
  // gap. The operator surface (readiness detail) must name the pack, the
  // requested year, and the published years — and must not prescribe the
  // scaffold script, which only a developer with a terminal can run.
  const problem = payrollTaxYearProblem("ES", 2025);
  assert.equal(problem?.kind, "missing");
  const operator = problem!.operatorMessage;
  assert.match(operator, /ES/);
  assert.match(operator, /2025/);
  assert.match(operator, /2026/);
  assert.match(operator, /No action in the product/);
  assert.ok(!operator.includes("payroll-new-tax-year"), `operator text must not name the scaffold script:\n${operator}`);
  assert.ok(
    !operator.includes(payrollTaxYearSupport("ES").ratesModule),
    `operator text must not name the rates module:\n${operator}`,
  );
  assert.ok(!/scaffold/i.test(operator), `operator text must not prescribe scaffolding:\n${operator}`);
  assert.ok(!/transcribe/i.test(operator), `operator text must not prescribe transcription:\n${operator}`);
  // The developer remedy is unchanged for engine throws and logs.
  assert.match(problem!.message, /payroll-new-tax-year/);
});

test("a draft year tells the operator it is not available, with no developer remedy", () => {
  // REALISTIC: AU publishes 2027 while its 2026 edition is scaffolded but
  // unfilled, so 2026 is a real draft gap — not a synthetic collision.
  const problem = payrollTaxYearProblem("AU", 2026);
  assert.equal(problem?.kind, "draft");
  const operator = problem!.operatorMessage;
  assert.match(operator, /AU/);
  assert.match(operator, /2026/);
  assert.match(operator, /2027/);
  assert.match(operator, /No action in the product/);
  assert.ok(!operator.includes("payroll-new-tax-year"), `operator text must not name the scaffold script:\n${operator}`);
  assert.ok(
    !operator.includes(payrollTaxYearSupport("AU").ratesModule),
    `operator text must not name the rates module:\n${operator}`,
  );
  assert.ok(!/scaffold/i.test(operator), `operator text must not prescribe scaffolding:\n${operator}`);
  assert.ok(!/transcribe/i.test(operator), `operator text must not prescribe transcription:\n${operator}`);
  // The developer remedy is unchanged for engine throws and logs.
  assert.match(problem!.message, /placeholder values/);
});

test("a country with no pack tells the operator there is nothing to load", () => {
  // REALISTIC: XX is declared nowhere, so the operator must learn the
  // country itself is uncovered — not go looking for a year to load.
  const problem = payrollTaxYearProblem("XX", 2025);
  assert.equal(problem?.kind, "undeclared");
  const operator = problem!.operatorMessage;
  assert.match(operator, /XX/);
  assert.match(operator, /2025/);
  assert.match(operator, /no payroll pack/i);
  assert.match(operator, /No action in the product/);
  assert.ok(!operator.includes("payroll-new-tax-year"), `operator text must not name the scaffold script:\n${operator}`);
  assert.ok(!/scaffold/i.test(operator), `operator text must not prescribe scaffolding:\n${operator}`);
  assert.ok(!/transcribe/i.test(operator), `operator text must not prescribe transcription:\n${operator}`);
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
    assert.deepEqual(payrollSupportedTaxYears(support), [2026, 2027]);
    assert.deepEqual(payrollSupportedTaxYears(support, "R1"), [2026]);
    assert.deepEqual(payrollSupportedTaxYears(support, "R2"), [2026, 2027]);
    // A scaffolded-but-unfilled year is a LOUDER refusal than a missing one: the
    // module exists, so anything checking mere presence would have said yes.
    assert.deepEqual(payrollDraftTaxYears(support, "R1"), [2027]);
    const drafted = payrollTaxYearProblem(country, 2027, "R1");
    assert.equal(drafted?.kind, "draft");
    assert.match(drafted!.message, /scaffolded but not filled in/);
    assert.equal(payrollTaxYearProblem(country, 2027, "R2"), null);
    assert.throws(() => registerPayrollTaxYears(support), /already declared/);
  } finally {
    unregisterPayrollTaxYears(country);
  }
  assert.throws(() => payrollTaxYearSupport(country), /declares no statutory tax years/);
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

/**
 * Packs track the CURRENT tax year (queue item 45: Italy was STALE at 2025
 * while every other pack carried 2026).
 *
 * The engines have always refused an untranscribed year at Calculate time.
 * This guard catches the drift EARLIER — the day a pack stops covering the
 * current year — by reading the TYPED declaration
 * (`payrollTaxYearCoverage()`), never a grep.
 */

const PINNED_TODAY = "2026-09-20";

/**
 * The instrument: which installable packs do NOT support their own current
 * tax year. The current year comes from each pack's own year definition
 * (`payrollTaxYearForDate`), so a fiscal-year pack (AU, July, closing-year
 * naming) is asked about its year, not the calendar's. Each gap names the
 * pack, the missing year, the years it does support, and the module that
 * must transcribe them: the message is the product of this test, so it is
 * asserted exactly, not merely that something failed.
 */
function currentYearGaps(
  coverage: PayrollTaxYearCoverage[],
  currentYearFor: (country: string) => number,
): string[] {
  const gaps: string[] = [];
  for (const entry of coverage) {
    if (!entry.installable) continue;
    const current = currentYearFor(entry.country);
    if (!entry.supported.includes(current)) {
      gaps.push(
        `${entry.country} does not support the current tax year ${current} — supported: `
        + `[${entry.supported.join(", ")}], draft: [${entry.draft.join(", ")}] `
        + `(see ${entry.ratesModule})`,
      );
    }
  }
  return gaps;
}

test("every installable pack supports its current tax year", () => {
  // LIVE guard, on the real clock: "today" is the product's own business
  // date (now() through formatInZone, the helper businessToday builds on),
  // and each pack's current year is its own definition of it — never a
  // hardcoded year, or this starts failing on 1 January. When a pack drifts
  // (as IT did at 2025 while every other pack carried 2026), this goes red
  // naming the pack.
  const today = formatInZone(now(), "UTC");
  const gaps = currentYearGaps(
    payrollTaxYearCoverage(),
    (country) => payrollTaxYearForDate(country, today).taxYear,
  );
  assert.deepEqual(gaps, []);
});

test("the instrument fails a pack pinned to a past year, naming it and its years", async () => {
  // FAIL direction, on a pinned clock so the red is deterministic: Italy as
  // it stood before its 2026 edition (supported [2025], current year 2026).
  // This is the realistic red, not a synthetic collision — it is the exact
  // message the live guard above would have printed for that tree.
  await withSimClock(`${PINNED_TODAY}T12:00:00Z`, async () => {
    const today = formatInZone(now(), "UTC");
    assert.equal(today, PINNED_TODAY);
    const coverage = payrollTaxYearCoverage().map((entry) =>
      entry.country === "IT" ? { ...entry, supported: [2025], draft: [] } : entry);
    // The year in the message comes from the pinned clock, not a literal:
    // move the pin and this still names whatever year the pin sits in (and
    // goes red if the pin ever lands inside 2025, where the pin stops
    // demonstrating a gap at all).
    const itYear = payrollTaxYearForDate("IT", today).taxYear;
    assert.deepEqual(
      currentYearGaps(coverage, (country) => payrollTaxYearForDate(country, today).taxYear),
      [
        `IT does not support the current tax year ${itYear} — supported: [2025], `
        + "draft: [] (see engine/src/payroll/it/rates.ts)",
      ],
    );
  });
});

test("the instrument passes the real set and ignores non-installable packs", async () => {
  // PASS direction, same pinned clock: the unmodified declaration is clean,
  // and a non-installable entry with no current year behind it is not a gap
  // (the filter is on installable, and this proves it is not vacuous).
  await withSimClock(`${PINNED_TODAY}T12:00:00Z`, async () => {
    const today = formatInZone(now(), "UTC");
    const currentYearFor = (country: string) => payrollTaxYearForDate(country, today).taxYear;
    assert.deepEqual(currentYearGaps(payrollTaxYearCoverage(), currentYearFor), []);
    const withExtra: PayrollTaxYearCoverage[] = [
      ...payrollTaxYearCoverage(),
      {
        country: "ZY",
        installable: false,
        supported: [],
        draft: [],
        ratesModule: "nowhere",
        regionsWithOwnTables: [],
        editions: [],
        regions: [],
      },
    ];
    assert.deepEqual(currentYearGaps(withExtra, currentYearFor), []);
  });
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
    const unloaded = Math.max(...payrollSupportedTaxYears(payrollTaxYearSupport("CA"))) + 1;
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
      const unloaded = Math.max(...payrollSupportedTaxYears(payrollTaxYearSupport("US"))) + 1;
      const sections = await orgYearEndFilings(org.orgId, unloaded);
      assert.ok(sections.length > 0);
      for (const section of sections) {
        // The CA T4 already refused an unknown year through its box caps. The
        // W-2 and the 941 did not: they would have filed a year the engine
        // cannot withhold for, with no refusal anywhere on the page.
        //
        // "Unloaded" is PER PACK, which this test originally assumed away by
        // deriving one year from the US pack and asserting the year refusal for
        // every section. Both CA and US run on the calendar year, so the
        // assumption held while they were the only packs; AU's fiscal year
        // 2026-27 makes `max(US) + 1` a year AU genuinely has loaded, and AU
        // then reports its OWN refusal (STP finalisation is declared but not
        // populated). That is the pack being right, not the page being wrong.
        //
        // So the invariant is asked of each pack on its own terms. What must
        // hold everywhere is the part that actually protects the filing: no
        // section returns rows for a year its own pack cannot withhold for.
        const yearProblem = payrollTaxYearProblem(section.country, unloaded);
        if (yearProblem) {
          assert.match(
            section.populationRefusal ?? "",
            new RegExp(`${unloaded} statutory tables are not loaded`),
            `${section.country} ${section.key}`,
          );
          assert.deepEqual(section.data.rows, [], `${section.country} ${section.key}`);
        } else {
          // The pack has the year. It may populate or name its own refusal —
          // but it may never do both, which would show rows under a refusal.
          if (section.populationRefusal != null) {
            assert.deepEqual(section.data.rows, [], `${section.country} ${section.key}`);
          }
        }
      }
      // A year loaded for CA and US populates for them with no refusal (empty
      // tenant). Other packs may legitimately carry a named refusal for 2026 —
      // DE declares the Lohnsteuerbescheinigung but has not implemented ELSTER
      // population — so this asks the two packs the fixture installed.
      for (const section of await orgYearEndFilings(org.orgId, 2026)) {
        if (section.country !== "CA" && section.country !== "US") continue;
        assert.equal(section.populationRefusal, null, `${section.country} ${section.key}`);
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
