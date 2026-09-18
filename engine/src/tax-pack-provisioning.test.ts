import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries, TAX_SUBDIVISION_CATALOG } from "./tax-pack-provisioning.ts";
import { TAX_RETURN_PACKS } from "./seed-tax-forms.ts";
import {
  assertPackCodeRateSchedule,
  COUNTRY_TAX_PACKS,
  countryTaxPackForReturn,
  packRatesCoveringDate,
  packReturnCodesWithTaxCodes,
  packTaxCodesForReturn,
  primaryPackTaxCode,
} from "./country-tax-packs/index.ts";
import type { EffectiveTaxRate } from "./country-tax-packs/types.ts";

test("every default tax code has an explicit effective-dated rate schedule", () => {
  for (const [packCode, definition] of Object.entries(PACK_DEFAULT_CODES)) {
    // Covers-today invariant (F-tax-sunset-001) against the real today; the
    // shape checks below are date-arithmetic, not today-dependent.
    assertPackCodeRateSchedule(packCode, definition);
    // assertPackCodeRateSchedule already refuses a definition with no rates,
    // so the shape loop below is reached only with a populated schedule.
    assert.ok(definition.rates, `${packCode} has no rate schedule`);
    for (const [index, rate] of definition.rates.entries()) {
      assert.match(rate.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(`${rate.effectiveFrom}T00:00:00Z`).toISOString().slice(0, 10), rate.effectiveFrom);
      if (rate.effectiveTo) {
        assert.match(rate.effectiveTo, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(rate.effectiveTo >= rate.effectiveFrom, `${packCode} has an inverted interval`);
      }
      const previous: EffectiveTaxRate | undefined = definition.rates[index - 1];
      if (previous) {
        assert.ok(rate.effectiveFrom > previous.effectiveFrom, `${packCode} rates are not sorted`);
        assert.ok(previous.effectiveTo, `${packCode} has an open-ended interval before its current rate`);
        assert.ok(rate.effectiveFrom > previous.effectiveTo, `${packCode} rates overlap`);
      }
    }
  }
});

test("every tax return belongs to exactly one versioned country pack", () => {
  const returnCodes = COUNTRY_TAX_PACKS.flatMap((pack) => pack.returnPacks.map((returnPack) => returnPack.code));
  assert.equal(new Set(returnCodes).size, returnCodes.length);
  assert.deepEqual(new Set(returnCodes), new Set(TAX_RETURN_PACKS.map((pack) => pack.code)));
  for (const returnPack of TAX_RETURN_PACKS) {
    assert.ok(countryTaxPackForReturn(returnPack.code), `no country pack owns ${returnPack.code}`);
  }
});

test("country packs have unique identities and immutable-version metadata", () => {
  assert.equal(new Set(COUNTRY_TAX_PACKS.map((pack) => pack.code)).size, COUNTRY_TAX_PACKS.length);
  assert.equal(new Set(COUNTRY_TAX_PACKS.map((pack) => pack.country)).size, COUNTRY_TAX_PACKS.length);
  for (const pack of COUNTRY_TAX_PACKS) {
    assert.match(pack.version, /^\d{4}\.\d{2}\.\d{2}$/);
    assert.ok(pack.sources.length > 0, `missing sources for ${pack.code}`);
    const sourceIds = pack.sources.map((source) => source.id);
    assert.equal(new Set(sourceIds).size, sourceIds.length, `${pack.code} has duplicate source ids`);
    for (const source of pack.sources) {
      assert.match(source.id, /^[a-z][a-z0-9_]*$/);
      assert.match(source.url, /^https:\/\//);
      assert.match(source.asOf, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(`${source.asOf}T00:00:00Z`).toISOString().slice(0, 10), source.asOf);
    }
    const knownSources = new Set(sourceIds);
    for (const code of packReturnCodesWithTaxCodes(pack)) {
      for (const definition of packTaxCodesForReturn(pack, code)) {
        for (const rate of definition.rates ?? []) {
          assert.ok(knownSources.has(rate.sourceId), `${pack.code}/${code} references unknown source ${rate.sourceId}`);
        }
      }
    }
    for (const jurisdiction of pack.jurisdictions) {
      for (const rate of jurisdiction.defaultTaxCode?.rates ?? []) {
        assert.ok(
          knownSources.has(rate.sourceId),
          `${pack.code}/${jurisdiction.region} references unknown source ${rate.sourceId}`,
        );
      }
    }
  }
});

test("pack completeness is explicit and never inferred from a jurisdiction checklist", () => {
  const ca = COUNTRY_TAX_PACKS.find((pack) => pack.country === "CA")!;
  const us = COUNTRY_TAX_PACKS.find((pack) => pack.country === "US")!;
  assert.deepEqual(ca.completeness, {
    jurisdictions: "complete",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  });
  assert.deepEqual(us.completeness, {
    jurisdictions: "complete",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  });
  for (const pack of COUNTRY_TAX_PACKS) {
    assert.deepEqual(Object.keys(pack.completeness).sort(), [
      "jurisdictions",
      "localRates",
      "nexusRules",
      "returnDefinitions",
      "sourcingRules",
      "standardRates",
      "taxability",
    ]);
  }
});

test("default tax codes are unique across packs", () => {
  const codes = [
    ...COUNTRY_TAX_PACKS.flatMap((pack) =>
      packReturnCodesWithTaxCodes(pack).flatMap((code) => packTaxCodesForReturn(pack, code))),
    ...TAX_SUBDIVISION_CATALOG.flatMap((jurisdiction) => jurisdiction.defaultTaxCode ? [jurisdiction.defaultTaxCode] : []),
  ].map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("return pack tax code sets are keyed by own returns, non-empty, and code-unique", () => {
  for (const pack of COUNTRY_TAX_PACKS) {
    const ownReturns = new Set(pack.returnPacks.map((returnPack) => returnPack.code));
    for (const code of packReturnCodesWithTaxCodes(pack)) {
      assert.ok(ownReturns.has(code), `${pack.code} declares tax codes for ${code}, which is not its own return pack`);
      const definitions = packTaxCodesForReturn(pack, code);
      assert.ok(definitions.length > 0, `${pack.code}/${code} declares an empty tax code set`);
      assert.equal(
        new Set(definitions.map((definition) => definition.code)).size,
        definitions.length,
        `${pack.code}/${code} declares duplicate tax codes`,
      );
    }
  }
});

test("every declared code in every return set carries a valid effective-dated schedule", () => {
  for (const pack of COUNTRY_TAX_PACKS) {
    for (const code of packReturnCodesWithTaxCodes(pack)) {
      for (const definition of packTaxCodesForReturn(pack, code)) {
        const label = `${pack.code}/${code}/${definition.code}`;
        assertPackCodeRateSchedule(label, definition);
      }
    }
  }
});

test("a band in force today with a published end date satisfies the schedule guard", () => {
  // A decree-style band: current now, closed in the future. The old
  // open-ended-only guard rejected exactly this shape.
  const definition = {
    code: "DEMO-TEMP",
    name: "Demo temporary band",
    ratePercent: 8,
    rates: [
      { ratePercent: 16, effectiveFrom: "2024-01-01", effectiveTo: "2025-12-31", sourceId: "demo_rate_history" },
      { ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "demo_decree" },
    ],
  };
  assertPackCodeRateSchedule("DEMO/RETURN/DEMO-TEMP", definition, "2026-09-17");
});

test("a code whose band ended yesterday fails naming the code, the band, and the missing successor rate", () => {
  const definition = {
    code: "DEMO-TEMP",
    name: "Demo temporary band",
    ratePercent: 8,
    rates: [
      { ratePercent: 16, effectiveFrom: "2024-01-01", effectiveTo: "2025-12-31", sourceId: "demo_rate_history" },
      { ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "demo_decree" },
    ],
  };
  assert.throws(
    () => assertPackCodeRateSchedule("DEMO/RETURN/DEMO-TEMP", definition, "2027-01-01"),
    /DEMO\/RETURN\/DEMO-TEMP has no rate covering 2027-01-01.*8% from 2026-01-01.*2026-12-31.*successor rate/,
  );
});

test("the schedule guard rejects zero or multiple current bands and a stale headline", () => {
  const history = [
    { ratePercent: 16, effectiveFrom: "2024-01-01", effectiveTo: "2025-12-31", sourceId: "demo_rate_history" },
    { ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "demo_decree" },
  ];
  // Headline must track the rate current today, not history and not the future.
  assert.throws(
    () => assertPackCodeRateSchedule("DEMO/RETURN/DEMO-TEMP", { code: "DEMO-TEMP", name: "Demo", ratePercent: 16, rates: history }, "2026-09-17"),
    /DEMO\/RETURN\/DEMO-TEMP headline rate is stale/,
  );
  // Two bands covering today is ambiguous, never admitted.
  assert.throws(
    () =>
      assertPackCodeRateSchedule("DEMO/RETURN/DEMO-TEMP", {
        code: "DEMO-TEMP",
        name: "Demo",
        ratePercent: 8,
        rates: [
          ...history,
          { ratePercent: 10, effectiveFrom: "2026-06-01", sourceId: "demo_overlap" },
        ],
      }, "2026-09-17"),
    /DEMO\/RETURN\/DEMO-TEMP has 2 rates covering 2026-09-17/,
  );
  // No band in force yet is a nameable failure, not a silent pass.
  assert.throws(
    () =>
      assertPackCodeRateSchedule("DEMO/RETURN/DEMO-TEMP", {
        code: "DEMO-TEMP",
        name: "Demo",
        ratePercent: 8,
        rates: [{ ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "demo_decree" }],
      }, "2025-12-31"),
    /DEMO\/RETURN\/DEMO-TEMP has no rate covering 2025-12-31/,
  );
});

test("Canada GST history is effective-dated instead of backdating the current rate", () => {
  assert.deepEqual(PACK_DEFAULT_CODES.CA_GST34?.rates, [
    { ratePercent: 7, effectiveFrom: "1991-01-01", effectiveTo: "2006-06-30", sourceId: "cra_gst_hst_rates" },
    { ratePercent: 6, effectiveFrom: "2006-07-01", effectiveTo: "2007-12-31", sourceId: "cra_gst_hst_rates" },
    { ratePercent: 5, effectiveFrom: "2008-01-01", sourceId: "cra_gst_hst_rates" },
  ]);
  assert.equal(PACK_DEFAULT_CODES.CA_BC_PST?.rates?.[0]?.effectiveFrom, "2013-04-01");
  assert.equal(PACK_DEFAULT_CODES.CA_SK_PST?.rates?.[0]?.effectiveFrom, "2017-03-23");
  assert.equal(PACK_DEFAULT_CODES.CA_MB_RST?.rates?.[0]?.effectiveFrom, "2019-07-01");
  assert.equal(PACK_DEFAULT_CODES.CA_QC_QST?.rates?.[0]?.effectiveFrom, "2013-01-01");
});

test("US exposes every state plus DC and identifies maintained detailed packs", () => {
  const countries = supportedTaxCountries();
  const us = countries.find((c) => c.country === "US");
  assert.ok(us);
  assert.equal(us.countryPack, null);
  assert.equal(us.countryStatus, "subdivisions");
  assert.equal(us.subs.length, 51);
  assert.equal(new Set(us.subs.map((s) => s.region)).size, 51);
  assert.deepEqual(
    us.subs.map((s) => s.region).sort(),
    ["AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"],
  );
  assert.deepEqual(
    us.subs.filter((s) => s.coverage === "detailed_pack").map((s) => s.region).sort(),
    ["CA", "FL", "NY", "TX"],
  );
  assert.ok(us.subs.some((s) => s.region === "DC" && s.name === "District of Columbia"));
})

test("US supplies a sourced effective-dated statewide rate or explicitly has no statewide sales tax", () => {
  const pack = COUNTRY_TAX_PACKS.find((entry) => entry.country === "US")!;
  const noStatewideSalesTax = new Set(["AK", "DE", "MT", "NH", "OR"]);
  const detailedByRegion = new Map(
    pack.jurisdictions.flatMap((jurisdiction) => {
      if (!jurisdiction.returnPackCode) return [];
      const primary = primaryPackTaxCode(pack, jurisdiction.returnPackCode);
      return primary ? [[jurisdiction.region, primary] as const] : [];
    }),
  );
  const reviewDate = pack.version.replaceAll(".", "-");

  for (const jurisdiction of pack.jurisdictions) {
    const definition = jurisdiction.defaultTaxCode ?? detailedByRegion.get(jurisdiction.region);
    if (noStatewideSalesTax.has(jurisdiction.region)) {
      assert.equal(definition, undefined, `${jurisdiction.region} must not fabricate a statewide rate`);
      continue;
    }
    assert.ok(definition, `${jurisdiction.region} is missing its statewide/base rate`);
    assert.ok(definition.rates?.length, `${jurisdiction.region} is missing an effective-dated schedule`);
    // Same covers-date predicate as the channel guard, pinned to the pack
    // review date instead of today: jurisdiction data goes stale by version,
    // not by calendar.
    const active = packRatesCoveringDate(definition.rates, reviewDate)[0];
    assert.ok(active, `${jurisdiction.region} has no rate effective on the pack review date`);
    assert.equal(active.ratePercent, definition.ratePercent, `${jurisdiction.region} headline rate is not current`);
  }
  assert.equal(pack.jurisdictions.filter((item) => !noStatewideSalesTax.has(item.region)).length, 46);
});

test("US future enacted rate changes are installed without replacing the current headline rate", () => {
  const dc = TAX_SUBDIVISION_CATALOG.find((item) => item.country === "US" && item.region === "DC")!;
  assert.equal(dc.defaultTaxCode?.ratePercent, 6);
  assert.deepEqual(dc.defaultTaxCode?.rates, [
    { ratePercent: 6, effectiveFrom: "2026-07-31", effectiveTo: "2026-09-30", sourceId: "dc_2025_rate_notice" },
    { ratePercent: 7, effectiveFrom: "2026-10-01", sourceId: "dc_2025_rate_notice" },
  ]);
  const sd = TAX_SUBDIVISION_CATALOG.find((item) => item.country === "US" && item.region === "SD")!;
  assert.equal(sd.defaultTaxCode?.ratePercent, 4.2);
  assert.equal(sd.defaultTaxCode?.rates?.at(-1)?.ratePercent, 4.5);
  assert.equal(sd.defaultTaxCode?.rates?.at(-1)?.effectiveFrom, "2027-07-01");
});

test("New Mexico uses the current official statewide GRT base rate", () => {
  const nm = TAX_SUBDIVISION_CATALOG.find((item) => item.country === "US" && item.region === "NM")!;
  assert.equal(nm.defaultTaxCode?.code, "US-NM-GRT");
  assert.equal(nm.defaultTaxCode?.ratePercent, 4.875);
  assert.deepEqual(nm.defaultTaxCode?.rates, [
    { ratePercent: 5, effectiveFrom: "2022-07-01", effectiveTo: "2023-06-30", sourceId: "nm_grt_2022" },
    { ratePercent: 4.875, effectiveFrom: "2023-07-01", sourceId: "nm_grt_2023" },
  ]);
});

test("Canada exposes all ten provinces and three territories", () => {
  const countries = supportedTaxCountries();
  const ca = countries.find((c) => c.country === "CA");
  assert.ok(ca);
  assert.equal(ca.countryPack, "CA_GST34"); // federal GST/HST → CRA
  assert.equal(ca.name, "Canada");
  assert.equal(ca.subs.length, 13);
  assert.deepEqual(ca.subs.map((s) => s.region).sort(), ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
  // BC/SK/MB provincial sales tax + Quebec QST have maintained detailed packs.
  assert.deepEqual(
    ca.subs.filter((s) => s.coverage === "detailed_pack").map((s) => s.region).sort(),
    ["BC", "MB", "QC", "SK"],
  );
});

test("only maintained packs and catalogued jurisdiction selections are accepted", () => {
  assert.equal(isTaxProvisionSelection("CA_GST34"), true);
  assert.equal(isTaxProvisionSelection("US_CA_CDTFA401"), true);
  assert.equal(isTaxProvisionSelection("US_SALES_TAX_WORKPAPER"), false);
  assert.equal(isTaxProvisionSelection("GB_VAT100"), true);
  assert.equal(isTaxProvisionSelection("JURISDICTION:CA-ON"), true);
  assert.equal(isTaxProvisionSelection("JURISDICTION:US-DC"), true);
  assert.equal(isTaxProvisionSelection("JURISDICTION:US-XX"), false);
  assert.equal(isTaxProvisionSelection("JURISDICTION:CA-CALIFORNIA"), false);
});

test("Canadian HST histories are contiguous and current through the latest enacted rates", () => {
  const expectedCurrentRates = new Map([
    ["NB", 15],
    ["NL", 15],
    ["NS", 14],
    ["ON", 13],
    ["PE", 15],
  ]);
  for (const [region, expectedRate] of expectedCurrentRates) {
    const entry = TAX_SUBDIVISION_CATALOG.find((item) => item.country === "CA" && item.region === region);
    const rates = entry?.defaultTaxCode?.rates;
    assert.ok(rates, `missing HST schedule for ${region}`);
    assert.equal(rates.at(-1)?.ratePercent, expectedRate);
    assert.equal(rates.at(-1)?.effectiveTo, undefined);
    for (let i = 1; i < rates.length; i++) {
      const previousEnd: Date = new globalThis.Date(`${rates[i - 1]!.effectiveTo}T00:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      assert.equal(previousEnd.toISOString().slice(0, 10), rates[i]!.effectiveFrom, `${region} HST history has a gap or overlap`);
    }
  }
});

test("the catalog contains no unsourced placeholder country packs", () => {
  assert.deepEqual(supportedTaxCountries().filter((country) => country.countryStatus === "in_development"), []);
});

test("immutable pack evidence permits only an explicit sandbox teardown", () => {
  const baseline = readFileSync(
    "schema/migrations/generated/0001_baseline.sql",
    "utf8",
  );
  assert.match(baseline, /current_setting\('openbooks\.sandbox_wipe', true\) = 'on'/);
  assert.match(baseline, /env_kind = 'sandbox'/);
  assert.match(baseline, /country tax pack installation evidence is immutable/);
});

test("the per-return code-set field is read only through packTaxCodesForReturn", () => {
  // The field name is assembled so this very file never contains the literal
  // and cannot trip its own scan.
  const field = ["returnPack", "TaxCodes"].join("");
  const declaration = new RegExp(`^\\s*${field}\\s*:\\s*\\{`);
  const owners = new Set([
    join("engine", "src", "country-tax-packs", "types.ts"),
    join("engine", "src", "country-tax-packs", "index.ts"),
  ]);
  // Build output is not source. The blue/green rebuild leaves `.next-old` and
  // `.next-stage` beside `.next`, and bundled chunks inline the field name, so
  // a fixed-name skip list reports minified JavaScript as an offending reader.
  // Hidden directories are never source either: the payroll scaffold test
  // copies engine/src under gitignored `engine/.tmp-scaffold-<pid>/` while
  // this scan walks the tree concurrently, so the copy's owned readers report
  // as offenders. Same dot-directory rule as workspace-dependencies.test.mjs.
  const skipDirs = new Set(["node_modules", "dist", "build", "coverage"]);
  const skipDir = (name: string): boolean => skipDirs.has(name) || name.startsWith(".");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) walk(path);
      } else if (/\.[cm]?[tj]sx?$/.test(entry.name) && !owners.has(path)) {
        readFileSync(path, "utf8").split("\n").forEach((line, index) => {
          if (!line.includes(field)) return;
          // Pack files DECLARE the field as an object-literal key; that is
          // writing content, not reading the union — reads are the ban.
          if (declaration.test(line)) return;
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        });
      }
    }
  };
  for (const root of ["engine", "web", "scripts", "schema"]) walk(root);
  assert.deepEqual(offenders, []);
});
