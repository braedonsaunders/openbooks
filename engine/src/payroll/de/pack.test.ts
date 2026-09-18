/**
 * DE payroll skeleton tests.
 *
 * A skeleton pack plus NAMED refusals is done; guessed bands are not. These
 * tests pin the skeleton: the statutory set is declared, the 16 Länder are
 * listed, ELStAM (not a W-4/TD1 clone) is declared, and 2026 is refused by
 * name everywhere it would otherwise calculate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DE_PAYROLL_PACK } from "./pack.ts";
import { DE_PACK_RATES, DE_TAX_YEARS } from "./rates.ts";

const LAENDER = [
  "BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV",
  "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH",
];

test("DE pack exists, is not installable, runs a calendar year in EUR", () => {
  assert.equal(DE_PAYROLL_PACK.country, "DE");
  assert.equal(DE_PAYROLL_PACK.installable, false);
  assert.equal(DE_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(DE_PAYROLL_PACK.taxYear, {
    basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
  });
  assert.equal(DE_PAYROLL_PACK.statutoryEngineLabel, "Programmablaufplan (EStG §39b)");
});

test("statutory slots name Lohnsteuer, Soli, and employee+employer SV", () => {
  const slots = DE_PAYROLL_PACK.statutorySlots;
  const keys = slots.map((slot) => slot.key);
  for (const key of ["lohnsteuer", "solidaritaetszuschlag", "kv", "rv", "av", "pv"]) {
    assert.ok(keys.includes(key), `missing slot ${key}`);
  }
  // Each SV branch is withheld from the employee AND matched by the employer.
  for (const key of ["kv", "rv", "av", "pv"]) {
    const slot = slots.find((entry) => entry.key === key);
    assert.ok(slot);
    const kinds = slot.components.map((component) => component.kind).sort();
    assert.deepEqual(kinds, ["deduction", "employer_contribution"], key);
  }
  // Lohnsteuer and Soli follow taxable income; SV follows earnings.
  const assessed = new Map(
    slots.flatMap((slot) => slot.components.map((c) => [c.code, c.assessedOn] as const)),
  );
  assert.equal(assessed.get("LST"), "taxable_income");
  assert.equal(assessed.get("SOLI"), "taxable_income");
  for (const code of ["KV", "RV", "AV", "PV", "U1", "BG"]) {
    assert.equal(assessed.get(code), "earnings", code);
  }
  // Employer levies (Umlagen, Berufsgenossenschaft) are declared too.
  assert.ok(keys.includes("umlage"));
  assert.ok(keys.includes("unfall"));
  // Kirchenlohnsteuer is a NAMED refusal, not a slot.
  const text = JSON.stringify(slots).toLowerCase();
  assert.ok(!text.includes("kist"), "KiSt must be refused, not slotted");
  assert.ok(!text.includes("kirchen"), "KiSt must be refused, not slotted");
});

test("all 16 Länder are known regions, all refused by name", () => {
  assert.deepEqual([...DE_PAYROLL_PACK.regions.known].sort(), [...LAENDER].sort());
  assert.deepEqual(DE_PAYROLL_PACK.regions.supported, []);
  assert.equal(DE_PAYROLL_PACK.regions.label, "Land");
  assert.ok(DE_PAYROLL_PACK.regions.unsupportedReason.includes("{region}"));
  assert.ok(DE_PAYROLL_PACK.regions.unsupportedReason.includes("2026"));
  assert.ok(DE_PAYROLL_PACK.regions.unsupportedReason.includes("Kirchenlohnsteuer"));
});

test("certificates declare ELStAM, not a W-4/TD1 clone", () => {
  const declaration = DE_PAYROLL_PACK.certificates();
  assert.equal(declaration.country, "DE");
  assert.equal(declaration.certificates.length, 1);
  const [elstam] = declaration.certificates;
  assert.ok(elstam, "ELStAM declared");
  assert.equal(elstam.form, "ELStAM");
  assert.equal(elstam.scope.level, "country");
  assert.equal(elstam.purpose, "withholding");
  const fields = new Map(elstam.fields.map((field) => [field.key, field]));
  const steuerklasse = fields.get("steuerklasse");
  assert.ok(steuerklasse);
  assert.deepEqual(
    steuerklasse.choices?.map((choice) => choice.value),
    ["I", "II", "III", "IV", "V", "VI"],
  );
  assert.ok(fields.has("konfession"), "ELStAM carries the confession key");
  assert.ok(fields.has("freibetrag"), "ELStAM carries §39a amounts");
  // No cloned North-American field names.
  for (const key of fields.keys()) {
    assert.ok(!/claim_code|allowance|filing_status|multiple_jobs/i.test(key), key);
  }
});

test("2026 is refused by name on taxYears; no year transcribed", () => {
  assert.equal(DE_TAX_YEARS.country, "DE");
  assert.deepEqual(DE_TAX_YEARS.editions, []);
  assert.equal(DE_TAX_YEARS.ratesModule, "engine/src/payroll/de/rates.ts");
  assert.equal(DE_PACK_RATES.country, "DE");
  assert.equal(DE_PAYROLL_PACK.taxYears, DE_TAX_YEARS);
});

test("computeStatutory refuses by name (2026 + BMF Programmablaufplan)", async () => {
  await assert.rejects(
    () => DE_PAYROLL_PACK.computeStatutory({} as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("2026"), error.message);
      assert.ok(error.message.includes("Programmablaufplan"), error.message);
      return true;
    },
  );
});

test("withholding covers all Länder as unimplemented, names KiSt", () => {
  const declaration = DE_PAYROLL_PACK.withholding();
  assert.equal(declaration.country, "DE");
  assert.deepEqual(
    declaration.regions.map((region) => region.region).sort(),
    [...LAENDER].sort(),
  );
  for (const region of declaration.regions) {
    assert.equal(region.implemented, false, region.region);
    assert.ok(region.unimplementedReason?.includes("2026"), region.region);
    assert.ok(region.unimplementedReason?.includes("Kirchenlohnsteuer"), region.region);
    // No German municipality levies a withholdable wage tax.
    assert.deepEqual(region.subRegions, []);
  }
});

test("filings declare the Lohnsteuerbescheinigung and refuse to populate", async () => {
  const filings = DE_PAYROLL_PACK.filings();
  assert.equal(filings.country, "DE");
  const [slip] = filings.yearEnd;
  assert.ok(slip, "Lohnsteuerbescheinigung declared");
  assert.equal(slip.key, "lohnsteuerbescheinigung");
  assert.equal(slip.cadence, "annual");
  assert.equal(slip.parseRowId("anything"), null);
  await assert.rejects(() => slip.population("org", 2026), /2026/);
  assert.equal(slip.amendment.supported, false);
});

test("jurisdictions list all Länder with untranscribed calendars", () => {
  assert.equal(DE_PAYROLL_PACK.jurisdictions.length, 16);
  for (const jurisdiction of DE_PAYROLL_PACK.jurisdictions) {
    assert.ok(jurisdiction.key.startsWith("DE-"), jurisdiction.key);
    assert.equal(jurisdiction.scope, "employment");
    assert.deepEqual(jurisdiction.holidays, []);
  }
});
