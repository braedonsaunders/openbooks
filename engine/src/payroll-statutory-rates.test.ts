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
  deleteStatutoryRate,
  listStatutoryRates,
  rateScopePointProblem,
  resolveStatutoryRates,
  statutoryRateProblem,
  unconfiguredStatutoryRates,
  upsertStatutoryRate,
  type StatutoryRateRow,
} from "./payroll/statutory-rates.ts";
import { packRates, PAYROLL_COUNTRY_PACKS, payrollPack, statutoryRateSlot } from "./payroll/packs.ts";
import { US_PACK_RATES } from "./payroll/us/rates.ts";
import { GB_PACK_RATES } from "./payroll/gb/rates.ts";
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

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String(current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Declarations                                                        */
/* ------------------------------------------------------------------ */

test("every installable pack declares its tenant-entered rates and their scope", () => {
  // The registry reads the declaration off the pack (no second list), so
  // reachability by country IS the assertion — a pack must declare which
  // statutory rates the employer supplies, and at what scope. Inheriting
  // another jurisdiction's answer is how an org-level blob happened.
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS).filter((p) => p.installable)) {
    assert.equal(packRates(pack.country).country, pack.country);
  }
  assert.throws(() => packRates("XX"), /declares no statutory rate slots/);
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

test("the QC health services fund is declared per region, rate-only, QC-only", () => {
  // TP-1015.F-V s. 5 / Revenu Québec "Total Payroll Threshold and Health
  // Services Fund Contribution Rate" (2026): the HSF rate is a function of
  // the employer's own total payroll and sector class — no pack constant can
  // supply it — and there is no annual exemption, so the slot carries a rate
  // and nothing else, for QC only.
  const hsf = statutoryRateSlot("CA", "ca_hsf");
  assert.equal(hsf.scope, "region");
  assert.deepEqual([...hsf.regions ?? []], ["QC"]);
  assert.deepEqual([...hsf.systemKeys], ["hsf"]);
  assert.deepEqual(hsf.fields.map((field) => field.key), ["rate"]);
  // The 2026 publication's other-sector rate, pasted: 1.65 × earnings.
  assert.deepEqual(
    canonicalStatutoryRateValues(hsf, { rate: "1.65" }),
    { rate: "1.6500" },
  );
  assert.match(
    statutoryRateProblem({
      rates: CA_PACK_RATES, regions: payrollPack("CA").regions,
      rateKey: "ca_hsf", region: "ON", taxYear: 2026, filingAccountId: null,
    }) ?? "",
    /not levied in ON/,
    "an HSF rate belongs to QC employment, never to another province",
  );
  assert.equal(
    statutoryRateProblem({
      rates: CA_PACK_RATES, regions: payrollPack("CA").regions,
      rateKey: "ca_hsf", region: "QC", taxYear: 2026, filingAccountId: null,
    }),
    null,
  );
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

test("flag fields store employer facts as true/false, never coerced", () => {
  // No built-in slot declares a flag yet: the slot is synthetic, which is
  // exactly the point — the kind is generic machinery, not a jurisdiction.
  const slot = {
    ...statutoryRateSlot("CA", "ca_eht"),
    key: "synthetic_class",
    label: "Synthetic class",
    scope: "org",
    fields: [{
      key: "exempt", label: "Exempt class", kind: "flag",
      decimals: 0, min: "false", max: "true", required: false,
      help: "synthetic",
    }],
  } as const;
  assert.deepEqual(
    canonicalStatutoryRateValues(slot, { exempt: true }),
    { exempt: "true" },
  );
  assert.deepEqual(
    canonicalStatutoryRateValues(slot, { exempt: "false" }),
    { exempt: "false" },
  );
  // "yes", 1 and "True" are all refused: a coerced class flag levies the
  // wrong employers, so only the canonical pair (and real booleans) pass.
  for (const raw of ["yes", "1", "True", "FALSE", "0"]) {
    assert.throws(
      () => canonicalStatutoryRateValues(slot, { exempt: raw }),
      /must be true or false/,
      `flag refuses ${JSON.stringify(raw)}`,
    );
  }
});

test("scope is enforced at the write boundary the pack declaration owns", () => {
  const base = {
    rates: US_PACK_RATES, regions: payrollPack("US").regions,
    taxYear: 2026, filingAccountId: null,
  };
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
      rates: US_PACK_RATES, regions: payrollPack("US").regions,
      rateKey: "us_sui", region: "MI", taxYear: 2026,
      filingAccountId: randomUUID(),
      account: { country: "US", programType: "us_ein", stateCode: null },
    }) ?? "",
    /is held by a us_state_sui account/,
    "an experience rate belongs to the state registration, never to the federal EIN",
  );
  assert.match(
    statutoryRateProblem({
      rates: CA_PACK_RATES, regions: payrollPack("CA").regions,
      rateKey: "ca_eht", region: "AB", taxYear: 2026, filingAccountId: null,
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
        orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein1, taxYear: 2026,
        values: { rate: "0.0106", wageBase: "9500" },
      });
      await upsertStatutoryRate({
        orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein2, taxYear: 2026,
        values: { rate: "0.0630", wageBase: "9500" },
      });
      // FUTA on the same employer, differing by state in the same payroll.
      for (const [state, rate] of [["MI", "0.009"], ["TX", "0.006"]] as const) {
        await upsertStatutoryRate({
          orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_futa",
          region: state, filingAccountId: null, taxYear: 2026, values: { rate },
        });
      }

      const resolution = await resolveStatutoryRates(fixture.orgId, US_PACK_RATES, 2026);
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
        orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_sui",
        region: "MI", filingAccountId: fixture.ein1, taxYear: 2026,
        values: { rate: "0.0115", wageBase: "9500" },
      });
      const rows = await listStatutoryRates(fixture.orgId, { country: "US", taxYear: 2026 });
      assert.equal(rows.filter((r) => r.rateKey === "us_sui").length, 2);
      const again = await resolveStatutoryRates(fixture.orgId, US_PACK_RATES, 2026);
      assert.equal(again.values("us_sui", { region: "MI", filingAccountId: fixture.ein1 })!.rate, "0.0115");
      assert.equal(again.values("us_sui", { region: "MI", filingAccountId: fixture.ein2 })!.rate, "0.0630");

      // A rate is assigned FOR A YEAR: next year's resolution does not inherit
      // this year's experience rate, and the gap is reported.
      const nextYear = await resolveStatutoryRates(fixture.orgId, US_PACK_RATES, 2027);
      assert.equal(nextYear.values("us_sui", { region: "MI", filingAccountId: fixture.ein1 }), null);

      // Every write is audited with before/after — a statutory rate change is
      // material configuration.
      const audit = (await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
        select action, changes from audit_log
         where org_id = ${fixture.orgId} and table_name = 'payroll_statutory_rates'
         order by at`));
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
  "rate writes roll back with an audit failure, and configured rows cannot be deleted",
  { skip: !DB },
  async () => {
    const fixture = await seedTwoAccountEmployer();
    try {
      let triggerInstalled = false;
      try {
        await db.execute(sql`
          create or replace function statutory_rate_audit_failure() returns trigger language plpgsql as $$
          begin raise exception 'injected statutory-rate audit failure'; end $$`);
        // CREATE TRIGGER is a utility statement: its WHEN clause cannot use
        // bind parameters, so the scratch org id is interpolated literally.
        await db.execute(sql.raw(
          `create trigger statutory_rate_audit_failure before insert on audit_log\n`
          + `  for each row when (new.org_id = '${fixture.orgId}'::uuid\n`
          + `    and new.table_name = 'payroll_statutory_rates')\n`
          + "  execute function statutory_rate_audit_failure()",
        ));
        triggerInstalled = true;

        await assert.rejects(
          () => upsertStatutoryRate({
            orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_futa",
            region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.009" },
          }),
          (error: unknown) => errorChainMatches(error, /injected statutory-rate audit failure/),
        );
        // The audit insert is in the same transaction as the rate insert: an
        // outage leaves neither half committed.
        assert.deepEqual(await listStatutoryRates(fixture.orgId, { country: "US", taxYear: 2026 }), []);
      } finally {
        if (triggerInstalled) await db.execute(sql`drop trigger statutory_rate_audit_failure on audit_log`);
        await db.execute(sql`drop function if exists statutory_rate_audit_failure()`);
      }

      const saved = await upsertStatutoryRate({
        orgId: fixture.orgId, actorId: fixture.actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.009" },
      });
      await assert.rejects(
        () => deleteStatutoryRate(fixture.orgId, fixture.actorId, saved.id),
        /cannot be deleted.*replacement rate/,
      );
      // A Remove request cannot erase the effective-dated input used to replay a
      // prior payroll period; the row and its resolution remain available.
      assert.equal(
        (await resolveStatutoryRates(fixture.orgId, US_PACK_RATES, 2026)).values("us_futa", { region: "MI" })?.rate,
        "0.0090",
      );
    } finally {
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "an org-wide GB save round-trips: insert, re-save, and resolution agree",
  { skip: !DB },
  async () => {
    // The losing save this guards: a statutory slot saved through setup with
    // no error and no value afterwards. The Employment Allowance is the GB
    // pack's only tenant-entered slot, org-wide, so a save here must be
    // readable through every read the product offers afterwards.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const first = await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: GB_PACK_RATES, rateKey: "gb_employment_allowance",
        region: null, filingAccountId: null, taxYear: 2026, values: { amount: "10500" },
      });
      assert.deepEqual(first.values, { amount: "10500.00" });
      const listed = await listStatutoryRates(org.orgId, { country: "GB", taxYear: 2026 });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.id, first.id);
      assert.deepEqual(listed[0]!.values, { amount: "10500.00" });

      // A second save of the same scope point is an UPDATE, never a duplicate.
      const second = await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: GB_PACK_RATES, rateKey: "gb_employment_allowance",
        region: null, filingAccountId: null, taxYear: 2026, values: { amount: "8000" },
      });
      assert.equal(second.id, first.id);
      const relisted = await listStatutoryRates(org.orgId, { country: "GB", taxYear: 2026 });
      assert.equal(relisted.length, 1);
      assert.deepEqual(relisted[0]!.values, { amount: "8000.00" });

      // And the engine prices from what was saved — never from a stale zero.
      const resolution = await resolveStatutoryRates(org.orgId, GB_PACK_RATES, 2026);
      assert.deepEqual(resolution.values("gb_employment_allowance"), { amount: "8000.00" });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a save outside its slot's scope is refused, never silently stored",
  { skip: !DB },
  async () => {
    // The write boundary enforces the slot's scope structurally, so no caller
    // can store a row the resolution cannot answer: a region carried on an
    // org-wide row, a missing region on a regional row, a jurisdiction carried
    // on a row no read looks at, or an account on a row that applies to every
    // account. Each of those saved successfully before this guard and then
    // resolved to nothing — the engine pricing the levy as unconfigured.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const gbSlot = GB_PACK_RATES.slots.find((slot) => slot.key === "gb_employment_allowance")!;
      assert.match(
        rateScopePointProblem(gbSlot, { region: "ENG", subRegion: null, filingAccountId: null }) ?? "",
        /org-wide/,
      );
      const futaSlot = US_PACK_RATES.slots.find((slot) => slot.key === "us_futa")!;
      assert.match(
        rateScopePointProblem(futaSlot, { region: null, subRegion: null, filingAccountId: null }) ?? "",
        /name the region/,
      );
      const ehtSlot = CA_PACK_RATES.slots.find((slot) => slot.key === "ca_eht")!;
      assert.match(
        rateScopePointProblem(ehtSlot, { region: "ON", subRegion: "TORONTO", filingAccountId: null }) ?? "",
        /sub-jurisdiction/,
      );
      const suiSlot = US_PACK_RATES.slots.find((slot) => slot.key === "us_sui")!;
      assert.equal(
        rateScopePointProblem(suiSlot, { region: "MI", subRegion: null, filingAccountId: null }),
        null,
      );

      const accountId = randomUUID();
      await assert.rejects(
        () => upsertStatutoryRate({
          orgId: org.orgId, actorId, rates: GB_PACK_RATES, rateKey: "gb_employment_allowance",
          region: "ENG", filingAccountId: null, taxYear: 2026, values: { amount: "10500" },
        }),
        /org-wide/,
      );
      await assert.rejects(
        () => upsertStatutoryRate({
          orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
          region: null, filingAccountId: null, taxYear: 2026, values: { rate: "0.006" },
        }),
        /name the region/,
      );
      await assert.rejects(
        () => upsertStatutoryRate({
          orgId: org.orgId, actorId, rates: CA_PACK_RATES, rateKey: "ca_eht",
          region: "ON", subRegion: "TORONTO", filingAccountId: null, taxYear: 2026,
          values: { rate: "1.95", annualExemption: "1000000" },
        }),
        /sub-jurisdiction/,
      );
      await assert.rejects(
        () => upsertStatutoryRate({
          orgId: org.orgId, actorId, rates: CA_PACK_RATES, rateKey: "ca_eht",
          region: "ON", filingAccountId: accountId, taxYear: 2026,
          values: { rate: "1.95", annualExemption: "1000000" },
        }),
        /per filing account/,
      );
      // Every refusal above wrote nothing: a refused save leaves no
      // half-stored row for a later read to trip over.
      assert.deepEqual(await listStatutoryRates(org.orgId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an update that matches no row fails instead of reporting success",
  { skip: !DB },
  async () => {
    // The UPDATE names the row the SELECT just locked, so zero affected rows
    // means the write did not land — a scope the row-level policy hides, a
    // row deleted mid-flight — and success must not be reported for it.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    let triggerInstalled = false;
    try {
      await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.006" },
      });
      try {
        // A BEFORE UPDATE trigger that returns NULL skips the update while
        // the row stays visible: the UPDATE matches but affects zero rows.
        await db.execute(sql`
          create or replace function skip_statutory_rate_update() returns trigger language plpgsql as $$
          begin return null; end $$`);
        await db.execute(sql.raw(
          `create trigger skip_statutory_rate_update before update on payroll_statutory_rates\n`
          + `  for each row when (new.org_id = '${org.orgId}'::uuid)\n`
          + "  execute function skip_statutory_rate_update()",
        ));
        triggerInstalled = true;
        await assert.rejects(
          () => upsertStatutoryRate({
            orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
            region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.009" },
          }),
          /matched no row/,
        );
        // The failed update changed nothing: the stored value is still the
        // first save, and the audit carries no update for the lost write.
        assert.equal(
          (await resolveStatutoryRates(org.orgId, US_PACK_RATES, 2026)).values("us_futa", { region: "MI" })?.rate,
          "0.0060",
        );
      } finally {
        if (triggerInstalled) await db.execute(sql`drop trigger skip_statutory_rate_update on payroll_statutory_rates`);
        await db.execute(sql`drop function if exists skip_statutory_rate_update()`);
      }
      // With the interference gone the same save lands normally.
      await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.009" },
      });
      assert.equal(
        (await resolveStatutoryRates(org.orgId, US_PACK_RATES, 2026)).values("us_futa", { region: "MI" })?.rate,
        "0.0090",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
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

      const us = await resolveStatutoryRates(org.orgId, US_PACK_RATES, 2026);
      assert.deepEqual(us.values("us_sui", { region: "MI", filingAccountId: null }), {
        rate: "0.027", wageBase: "9500",
      });
      assert.equal(us.values("us_futa", { region: "MI" })!.rate, "0.006");
      const ca = await resolveStatutoryRates(org.orgId, CA_PACK_RATES, 2026);
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
