import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { payRunReadiness, payrollStatutoryRateGaps } from "./payroll-readiness.ts";
import { CA_PACK_RATES } from "./payroll/canada/rates.ts";
import {
  buildResolution,
  canonicalStatutoryRateValues,
  listStatutoryRates,
  packRates,
  packsMissingRateDeclarations,
  resolveStatutoryRates,
  statutoryRateProblem,
  statutoryRateSlot,
  unconfiguredStatutoryRates,
  upsertStatutoryRate,
  type StatutoryRateRow,
} from "./payroll/statutory-rates.ts";
import { US_PACK_RATES } from "./payroll/us/rates.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Statutory rate SCOPING.
 *
 * Each test names the money it protects. The three defects being fixed were all
 * the same defect: a statutory rate that varies per employer account or per
 * region was stored once, org-wide, so one of the real values was necessarily
 * wrong and nothing said so.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* Declarations                                                        */
/* ------------------------------------------------------------------ */

test("every installable pack declares its tenant-entered rates and their scope", () => {
  assert.deepEqual(
    packsMissingRateDeclarations(), [],
    "a pack must declare which statutory rates the employer supplies, and at what scope — "
    + "inheriting another jurisdiction's answer is how an org-level blob happened",
  );
});

test("the SUI rate is declared per FILING ACCOUNT, and FUTA per region", () => {
  // The declaration IS the fix: everything downstream (the resolver, the setup
  // surface, the readiness check) reads it, so getting these two wrong is the
  // only way to reintroduce the defect.
  assert.equal(statutoryRateSlot("US", "us_sui").scope, "filing_account");
  assert.equal(statutoryRateSlot("US", "us_sui").programType, "us_state_sui");
  assert.equal(statutoryRateSlot("US", "us_futa").scope, "region");
  assert.equal(statutoryRateSlot("CA", "ca_eht").scope, "region");
  // Four provinces levy an employer health tax; the pre-scoping blob could hold
  // one rate, which could only ever describe one of them.
  assert.deepEqual([...statutoryRateSlot("CA", "ca_eht").regions ?? []], ["BC", "MB", "NL", "ON"]);
});

test("an undeclared pack or slot is refused by name, never defaulted", () => {
  assert.throws(() => packRates("ZZ"), /declares no statutory rate slots/);
  assert.throws(() => statutoryRateSlot("US", "us_paid_family"), /declares no "us_paid_family"/);
});

/* ------------------------------------------------------------------ */
/* Values: canonicalization and refusal                                */
/* ------------------------------------------------------------------ */

test("declared field scales and ranges are enforced, and unknown keys refused", () => {
  const sui = statutoryRateSlot("US", "us_sui");
  assert.deepEqual(
    canonicalStatutoryRateValues(sui, { rate: "0.027", wageBase: "9000" }),
    { rate: "0.0270", wageBase: "9000.00" },
  );
  // A percent typed into a decimal-rate field is the classic payroll-rate
  // defect: 2.7 instead of 0.027 is a hundred times the premium.
  assert.throws(() => canonicalStatutoryRateValues(sui, { rate: "2.7", wageBase: "9000" }), /between 0 and 0.2/);
  assert.throws(
    () => canonicalStatutoryRateValues(sui, { rate: "0.02755555", wageBase: "9000" }),
    /precision/,
    "a rate carrying more precision than the field declares is refused, not silently truncated",
  );
  assert.throws(() => canonicalStatutoryRateValues(sui, { rate: "0.027" }), /required/);
  assert.throws(
    () => canonicalStatutoryRateValues(sui, { rate: "0.027", wageBase: "9000", surcharge: "0.001" }),
    /declares no "surcharge" value/,
    "a number an operator typed is never quietly dropped",
  );
  // The EHT rate is a PERCENT because that is how a province publishes it; the
  // kinds are never converted into each other.
  assert.deepEqual(
    canonicalStatutoryRateValues(statutoryRateSlot("CA", "ca_eht"), { rate: "1.95", annualExemption: "1000000" }),
    { rate: "1.9500", annualExemption: "1000000.00" },
  );
});

test("scope is enforced at the write boundary the pack declaration owns", () => {
  const base = { country: "US", taxYear: 2026, filingAccountId: null };
  assert.equal(
    statutoryRateProblem({ ...base, rateKey: "us_futa", region: "MI" }), null,
  );
  assert.match(
    statutoryRateProblem({ ...base, rateKey: "us_futa", region: null }) ?? "",
    /varies by state/,
  );
  assert.match(
    statutoryRateProblem({ ...base, rateKey: "us_futa", region: "ZZ" }) ?? "",
    /unknown US state/,
  );
  assert.match(
    statutoryRateProblem({ ...base, rateKey: "us_futa", region: "MI", filingAccountId: randomUUID() }) ?? "",
    /not assigned per filing account/,
    "FUTA has no per-account rate — accepting one would create a value nothing reads",
  );
  assert.match(
    statutoryRateProblem({
      country: "US", rateKey: "us_sui", region: "MI", taxYear: 2026,
      filingAccountId: randomUUID(),
      account: { country: "US", programType: "us_ein", stateCode: null },
    }) ?? "",
    /is held by a us_state_sui account/,
    "an experience rate belongs to the state registration, never to the federal EIN",
  );
  assert.match(
    statutoryRateProblem({
      country: "CA", rateKey: "ca_eht", region: "AB", taxYear: 2026, filingAccountId: null,
    }) ?? "",
    /not levied in AB/,
  );
  assert.match(
    statutoryRateProblem({ ...base, rateKey: "us_futa", region: "MI", taxYear: 1999 }) ?? "",
    /is not a tax year/,
  );
});

/* ------------------------------------------------------------------ */
/* The specificity ladder, without a database                          */
/* ------------------------------------------------------------------ */

const row = (over: Partial<StatutoryRateRow>): StatutoryRateRow => ({
  id: randomUUID(), country: "US", rateKey: "us_sui", region: "MI",
  filingAccountId: null, taxYear: 2026, values: { rate: "0.0270", wageBase: "9500.00" },
  ...over,
});

test("an account-specific rate beats the region-wide one; the region-wide one is the fallback", () => {
  const ein1 = randomUUID();
  const ein2 = randomUUID();
  const resolution = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, legacy: [],
    rows: [
      row({ filingAccountId: null, values: { rate: "0.0270", wageBase: "9500.00" } }),
      row({ filingAccountId: ein1, values: { rate: "0.0106", wageBase: "9500.00" } }),
      row({ filingAccountId: ein2, values: { rate: "0.0630", wageBase: "9500.00" } }),
    ],
  });
  // The defect this test exists for: ONE employer, ONE state, TWO registered
  // accounts, two experience rates. An org-level blob could hold one of them.
  assert.equal(resolution.resolve("us_sui", { region: "MI", filingAccountId: ein1 })!.values.rate, "0.0106");
  assert.equal(resolution.resolve("us_sui", { region: "MI", filingAccountId: ein2 })!.values.rate, "0.0630");
  assert.equal(resolution.resolve("us_sui", { region: "MI", filingAccountId: ein1 })!.source, "account");
  // An employee under no account (or an account with no rate of its own) uses
  // the region-wide value — the single-account employer's whole configuration.
  const wide = resolution.resolve("us_sui", { region: "MI", filingAccountId: null })!;
  assert.equal(wide.values.rate, "0.0270");
  assert.equal(wide.source, "region");
  // A state the employer is not registered in resolves to nothing at all rather
  // than borrowing another state's rate.
  assert.equal(resolution.resolve("us_sui", { region: "OH", filingAccountId: ein1 }), null);
});

test("FUTA resolves per state, so one payroll can carry two effective rates", () => {
  const resolution = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, legacy: [],
    rows: [
      row({ rateKey: "us_futa", region: "MI", values: { rate: "0.0090" } }),
      row({ rateKey: "us_futa", region: "TX", values: { rate: "0.0060" } }),
    ],
  });
  // USDOL publishes the credit reduction per state per year. An employer with
  // crews in a credit-reduction state and a normal state owed 0.9% and 0.6% in
  // the same run; a single org-level futaRate had to be wrong for one of them,
  // and Form 940 Schedule A is computed state by state, so the reconciliation
  // could not be made to tie either way.
  assert.equal(resolution.values("us_futa", { region: "MI" })!.rate, "0.0090");
  assert.equal(resolution.values("us_futa", { region: "TX" })!.rate, "0.0060");
  assert.equal(resolution.values("us_futa", { region: "OH" }), null);
});

test("REGRESSION: with no rate rows, the pre-scoping blob resolves byte-identically", () => {
  // The single-account, single-region org is the regression guard. Its stored
  // blob must produce exactly the numbers the engine read before scoping
  // existed: the org-level FUTA rate for whatever state it pays in, the state
  // SUI entry for whatever account the employee is assigned to, and Ontario's
  // EHT at the org rate — same strings, no canonicalization, no rounding.
  const blob = {
    us: { futaRate: "0.006", sui: { MI: { rate: "0.027", wageBase: "9500" } } },
    ca: { eht: { enabled: true, rate: "1.95", annualExemption: "1000000" } },
  };
  const us = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, rows: [],
    legacy: US_PACK_RATES.legacyRows!(blob),
  });
  const account = randomUUID();
  assert.deepEqual(us.values("us_sui", { region: "MI", filingAccountId: account }), {
    rate: "0.027", wageBase: "9500",
  });
  assert.equal(us.resolve("us_sui", { region: "MI", filingAccountId: account })!.source, "legacy");
  // The org-level rate applied to every state, which IS the old behaviour —
  // reproduced exactly rather than "improved" behind the operator's back.
  assert.equal(us.values("us_futa", { region: "MI" })!.rate, "0.006");
  assert.equal(us.values("us_futa", { region: "TX" })!.rate, "0.006");

  const ca = buildResolution({
    country: "CA", taxYear: 2026, pack: CA_PACK_RATES, rows: [],
    legacy: CA_PACK_RATES.legacyRows!(blob),
  });
  assert.deepEqual(ca.values("ca_eht", { region: "ON" }), { rate: "1.95", annualExemption: "1000000" });
  // Ontario only, exactly as before: the old code applied the org rate when
  // province === "ON" and nowhere else.
  assert.equal(ca.values("ca_eht", { region: "BC" }), null);
});

test("a stored blob with the levy switched OFF stays off", () => {
  // An employer that entered a rate and then disabled EHT must not start
  // accruing it because the storage moved.
  const off = CA_PACK_RATES.legacyRows!({
    ca: { eht: { enabled: false, rate: "1.95", annualExemption: "1000000" } },
  });
  assert.deepEqual(off, []);
});

test("a row supersedes the blob for the point it covers, and only that point", () => {
  const resolution = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES,
    rows: [row({ rateKey: "us_futa", region: "MI", values: { rate: "0.0090" } })],
    legacy: US_PACK_RATES.legacyRows!({ us: { futaRate: "0.006" } }),
  });
  assert.equal(resolution.values("us_futa", { region: "MI" })!.rate, "0.0090");
  assert.equal(resolution.values("us_futa", { region: "TX" })!.rate, "0.006");
});

test("nothing configured is reported by name, never accrued as zero in silence", () => {
  const resolution = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, rows: [], legacy: [],
  });
  const account = randomUUID();
  const missing = unconfiguredStatutoryRates(resolution, [
    { region: "MI", filingAccountId: account, employees: [{ partyId: "p1", name: "Dana Fitter" }] },
  ]);
  assert.deepEqual(missing.map((item) => item.slotKey).sort(), ["us_futa", "us_sui"]);
  assert.match(missing.find((m) => m.slotKey === "us_sui")!.message, /nothing is being accrued/);
});

/* ------------------------------------------------------------------ */
/* Against the database                                                */
/* ------------------------------------------------------------------ */

interface UsFixture {
  orgId: string;
  actorId: string;
  ein1: string;
  ein2: string;
}

/** A two-EIN US employer registered for SUI twice in one state. */
async function seedTwoAccountEmployer(): Promise<UsFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const account = async (number: string, name: string, programType: string, state: string | null) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into payroll_filing_accounts
        (id, org_id, country, program_type, account_number, name, remitter_type, state_code,
         is_default, is_active, created_by, updated_by)
      values (${id}, ${org.orgId}, 'US', ${programType}, ${number}, ${name}, 'regular',
              ${state}, false, true, ${actorId}, ${actorId})`);
    return id;
  };
  return {
    orgId: org.orgId,
    actorId,
    ein1: await account("38-1234567/MI-001", "Northshore Drywall — MI SUI", "us_state_sui", "MI"),
    ein2: await account("38-7654321/MI-002", "Lakeside Mechanical — MI SUI", "us_state_sui", "MI"),
  };
}

test(
  "two accounts in one state hold two experience rates, and each resolves to its own",
  { skip: !DB },
  async () => {
    const fixture = await seedTwoAccountEmployer();
    try {
      // Each state assigns its rate to the ACCOUNT. Before scoping, the second
      // of these two saves overwrote the first and every employee of both
      // divisions was assessed at whichever rate was entered last.
      await upsertStatutoryRate({
        orgId: fixture.orgId, actorId: fixture.actorId, country: "US", rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein1, taxYear: 2026,
        values: { rate: "0.0106", wageBase: "9500" },
      });
      await upsertStatutoryRate({
        orgId: fixture.orgId, actorId: fixture.actorId, country: "US", rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein2, taxYear: 2026,
        values: { rate: "0.0630", wageBase: "9500" },
      });
      // FUTA on the same employer, differing by state in the same payroll.
      for (const [state, rate] of [["MI", "0.009"], ["TX", "0.006"]] as const) {
        await upsertStatutoryRate({
          orgId: fixture.orgId, actorId: fixture.actorId, country: "US", rateKey: "us_futa",
          region: state, filingAccountId: null, taxYear: 2026, values: { rate },
        });
      }

      const resolution = await resolveStatutoryRates(fixture.orgId, "US", 2026);
      assert.deepEqual(
        resolution.values("us_sui", { region: "MI", filingAccountId: fixture.ein1 }),
        { rate: "0.0106", wageBase: "9500.00" },
      );
      assert.deepEqual(
        resolution.values("us_sui", { region: "MI", filingAccountId: fixture.ein2 }),
        { rate: "0.0630", wageBase: "9500.00" },
      );
      assert.equal(resolution.values("us_futa", { region: "MI" })!.rate, "0.0090");
      assert.equal(resolution.values("us_futa", { region: "TX" })!.rate, "0.0060");

      // Re-saving one account's rate updates it in place: two rows for one
      // scope point would make the resolution ambiguous.
      await upsertStatutoryRate({
        orgId: fixture.orgId, actorId: fixture.actorId, country: "US", rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein1, taxYear: 2026,
        values: { rate: "0.0115", wageBase: "9500" },
      });
      const rows = await listStatutoryRates(fixture.orgId, { country: "US", taxYear: 2026 });
      assert.equal(rows.filter((r) => r.rateKey === "us_sui").length, 2);
      const again = await resolveStatutoryRates(fixture.orgId, "US", 2026);
      assert.equal(again.values("us_sui", { region: "MI", filingAccountId: fixture.ein1 })!.rate, "0.0115");
      assert.equal(again.values("us_sui", { region: "MI", filingAccountId: fixture.ein2 })!.rate, "0.0630");

      // A rate is assigned FOR A YEAR: next year's resolution does not inherit
      // this year's experience rate, and the gap is reported.
      const nextYear = await resolveStatutoryRates(fixture.orgId, "US", 2027);
      assert.equal(nextYear.values("us_sui", { region: "MI", filingAccountId: fixture.ein1 }), null);

      // Every write is audited with before/after — a statutory rate change is
      // material configuration.
      const audit = (await db.execute(sql`
        select action, changes from audit_log
         where org_id = ${fixture.orgId} and table_name = 'payroll_statutory_rates'
         order by at`)) as unknown as { rows: { action: string; changes: Record<string, unknown> }[] };
      assert.equal(audit.rows.filter((r) => r.action === "insert").length, 4);
      const update = audit.rows.find((r) => r.action === "update")!;
      assert.equal((update.changes.before as Record<string, string>).rate, "0.0106");
      assert.equal((update.changes.after as Record<string, string>).rate, "0.0115");
    } finally {
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "REGRESSION: a single-account org's stored blob resolves to the same numbers it always did",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // Exactly the shape a tenant configured before scoping existed carries.
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: {
            countries: ["US", "CA"],
            us: { futaRate: "0.006", sui: { MI: { rate: "0.027", wageBase: "9500" } } },
            ca: { eht: { enabled: true, rate: "1.95", annualExemption: "1000000" } },
          },
        })}::jsonb where id = ${org.orgId}`);

      const us = await resolveStatutoryRates(org.orgId, "US", 2026);
      assert.deepEqual(us.values("us_sui", { region: "MI", filingAccountId: null }), {
        rate: "0.027", wageBase: "9500",
      });
      assert.equal(us.values("us_futa", { region: "MI" })!.rate, "0.006");
      const ca = await resolveStatutoryRates(org.orgId, "CA", 2026);
      assert.deepEqual(ca.values("ca_eht", { region: "ON" }), {
        rate: "1.95", annualExemption: "1000000",
      });
      // And the blob is not silently promoted into rows: no migration to audit,
      // nothing to reconcile, one writable home going forward.
      assert.deepEqual(await listStatutoryRates(org.orgId), []);
      // With the blob answering for the region the org pays in, there is no gap
      // to nag about either.
      assert.deepEqual(await payrollStatutoryRateGaps(org.orgId, "CA", 2026), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a run whose people occupy an unconfigured rate point is warned, not refused",
  { skip: !DB },
  async () => {
    const fixture = await seedTwoAccountEmployer();
    try {
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${fixture.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${fixture.actorId}, ${fixture.actorId})`);
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${fixture.orgId}, 'person', 'Dana Fitter', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
        values (${fixture.orgId}, ${employeeId}, '2024-01-01', true, ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${fixture.orgId}, ${employeeId}, 'USD', '30', 'hour', '2026-01-01', true,
                ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                               province, pay_basis, filing_account_id, is_active,
                                               created_by, updated_by)
        values (${fixture.orgId}, ${employeeId}, ${scheduleId}, 'US', 'TX', 'hourly',
                ${fixture.ein1}, true, ${fixture.actorId}, ${fixture.actorId})`);
      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, document_date, currency, status,
                               created_by, updated_by)
        values (${fixture.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
                '2026-07-21', 'USD', 'draft', ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                              pay_date, tax_year, run_status, created_by, updated_by)
        values (${documentId}, ${fixture.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18',
                '2026-07-21', 2026, 'draft', ${fixture.actorId}, ${fixture.actorId})`);

      const readiness = await payRunReadiness(fixture.orgId, documentId);
      const gaps = readiness.items.filter((item) => item.code === "statutory.rateUnconfigured");
      assert.ok(gaps.length > 0, "the operator must see the levy nobody configured before payday");
      assert.ok(
        gaps.every((item) => item.severity === "warning"),
        "an employer with no registration in a state owes nothing there — refusing the whole "
        + "payroll over a levy that may not apply would be wrong",
      );
      assert.ok(
        gaps.some((item) => (item.detail ?? "").includes("TX")),
        "the item names the state the run actually pays in",
      );
      assert.ok(
        gaps.every((item) => item.employees.length > 0),
        "and the people it concerns",
      );
    } finally {
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
