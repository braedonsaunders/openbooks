/**
 * DE payroll pack tests (installable for 2026).
 *
 * The skeleton guards inverted in the commit that transcribed 2026 (per the
 * payroll-live rule: invert, never delete): 2026 IS published, all Länder
 * ARE supported, withholding IS implemented, computeStatutory COMPUTES.
 * Every OTHER year is still refused by name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DE_PAYROLL_PACK } from "./pack.ts";
import { DE_PACK_RATES, DE_TAX_YEARS } from "./rates.ts";

const LAENDER = [
  "BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV",
  "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH",
];

test("DE pack exists, is installable for 2026, runs a calendar year in EUR", () => {
  assert.equal(DE_PAYROLL_PACK.country, "DE");
  assert.equal(DE_PAYROLL_PACK.installable, true);
  assert.equal(DE_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(DE_PAYROLL_PACK.taxYear, {
    basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
  });
  assert.equal(DE_PAYROLL_PACK.statutoryEngineLabel, "Programmablaufplan (EStG §39b)");
});

test("statutory slots name Lohnsteuer, Soli, KiSt, and employee+employer SV", () => {
  const slots = DE_PAYROLL_PACK.statutorySlots;
  const keys = slots.map((slot) => slot.key);
  for (const key of ["lohnsteuer", "solidaritaetszuschlag", "kirchenlohnsteuer", "kv", "rv", "av", "pv"]) {
    assert.ok(keys.includes(key), `missing slot ${key}`);
  }
  // Each SV branch is withheld from the employee AND matched by the employer.
  for (const key of ["kv", "rv", "av", "pv"]) {
    const slot = slots.find((entry) => entry.key === key);
    assert.ok(slot);
    const kinds = slot.components.map((component) => component.kind).sort();
    assert.deepEqual(kinds, ["deduction", "employer_contribution"], key);
  }
  // Lohnsteuer, Soli and KiSt follow taxable income; SV follows earnings.
  const assessed = new Map(
    slots.flatMap((slot) => slot.components.map((c) => [c.code, c.assessedOn] as const)),
  );
  assert.equal(assessed.get("LST"), "taxable_income");
  assert.equal(assessed.get("SOLI"), "taxable_income");
  assert.equal(assessed.get("KIST"), "taxable_income");
  for (const code of ["KV", "RV", "AV", "PV", "U1", "BG"]) {
    assert.equal(assessed.get(code), "earnings", code);
  }
  // Employer levies (Umlagen, Berufsgenossenschaft) stay declared.
  assert.ok(keys.includes("umlage"));
  assert.ok(keys.includes("unfall"));
});

test("all 16 Länder are known regions, all supported end to end", () => {
  assert.deepEqual([...DE_PAYROLL_PACK.regions.known].sort(), [...LAENDER].sort());
  assert.deepEqual([...DE_PAYROLL_PACK.regions.supported].sort(), [...LAENDER].sort());
  assert.equal(DE_PAYROLL_PACK.regions.label, "Land");
  assert.ok(DE_PAYROLL_PACK.regions.unsupportedReason.includes("{region}"));
});

test("certificates declare ELStAM (not a W-4/TD1 clone) plus the PV Kindernachweis", () => {
  const declaration = DE_PAYROLL_PACK.certificates();
  assert.equal(declaration.country, "DE");
  assert.equal(declaration.certificates.length, 2);
  const byKey = new Map(declaration.certificates.map((cert) => [cert.key, cert]));
  const elstam = byKey.get("de_elstam");
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
  assert.ok(fields.has("faktor"), "ELStAM carries the §39f Faktor");
  // No cloned North-American field names.
  for (const key of fields.keys()) {
    assert.ok(!/claim_code|allowance|filing_status|multiple_jobs/i.test(key), key);
  }
  // The PV child facts live on their own employer-collected Nachweis — ELStAM
  // carries no PV child data.
  const pv = byKey.get("de_pv_nachweis");
  assert.ok(pv, "PV Kindernachweis declared");
  const pvFields = new Map(pv.fields.map((field) => [field.key, field]));
  assert.equal(pvFields.get("kinderlosenzuschlag")?.kind, "flag");
  assert.equal(pvFields.get("abschlag_kinder")?.kind, "count");
});

test("de_kvz tenant slot declared (org-wide); no national average transcribed", () => {
  assert.equal(DE_PACK_RATES.country, "DE");
  const slot = DE_PACK_RATES.slots.find((entry) => entry.key === "de_kvz");
  assert.ok(slot, "KVZ slot declared");
  assert.equal(slot.scope, "org");
  assert.deepEqual([...slot.systemKeys], ["kv"]);
  const rate = slot.fields.find((field) => field.key === "rate");
  assert.ok(rate);
  assert.equal(rate.kind, "percent");
  // Exactly one field — the fund's own rate. (The doc comment names the
  // BMG national average only to forbid it; no such value is declared.)
  assert.equal(slot.fields.length, 1);
  assert.match(rate.help, /fund's own/);
});

test("2026 is published; every other year is refused by name", () => {
  assert.equal(DE_TAX_YEARS.country, "DE");
  const published2026 = DE_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 1);
  assert.match(published2026[0]!.citation, /BMF-Schreiben vom 12\.11\.2025/);
  assert.match(published2026[0]!.label, /Programmablaufplan/);
  const publishedOther = DE_TAX_YEARS.editions.filter(
    (edition) => edition.year !== 2026 && edition.status === "published",
  );
  assert.deepEqual(publishedOther, []);
  assert.equal(DE_TAX_YEARS.ratesModule, "engine/src/payroll/de/rates.ts");
  assert.equal(DE_PAYROLL_PACK.taxYears, DE_TAX_YEARS);
});

test("computeStatutory refuses any year but 2026 by name", async () => {
  for (const year of [2025, 2027]) {
    await assert.rejects(
      () => DE_PAYROLL_PACK.computeStatutory({ taxYear: year } as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(String(year)), error.message);
        assert.ok(error.message.includes("2026"), error.message);
        return true;
      },
    );
  }
});

test("withholding covers all Länder as implemented, ELStAM-keyed", () => {
  const declaration = DE_PAYROLL_PACK.withholding();
  assert.equal(declaration.country, "DE");
  assert.deepEqual(
    declaration.regions.map((region) => region.region).sort(),
    [...LAENDER].sort(),
  );
  for (const region of declaration.regions) {
    assert.equal(region.implemented, true, region.region);
    assert.equal(region.certificateKey, "de_elstam", region.region);
    // No German municipality levies a withholdable wage tax.
    assert.deepEqual(region.subRegions, []);
  }
});

test("filings declare the Ausdruck (not the ELSTER transmission)", () => {
  const filings = DE_PAYROLL_PACK.filings();
  assert.equal(filings.country, "DE");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["de_finanzamt"],
  );
  const [slip] = filings.yearEnd;
  assert.ok(slip, "Lohnsteuerbescheinigung declared");
  assert.equal(slip.key, "lohnsteuerbescheinigung");
  assert.equal(slip.cadence, "annual");
  assert.match(slip.label, /Ausdruck/);
  // The row grammar is a bare employee id (see filings.test.ts for the full
  // grammar); the transmission half is the named refusal.
  assert.equal(slip.parseRowId("anything"), null);
  assert.ok(slip.slip, "the employee printout is declared");
  assert.match(slip.downloadRefusal ?? "", /ELSTER/);
  assert.equal(slip.amendment.supported, false);
  if (!slip.amendment.supported) {
    assert.match(slip.amendment.refusal, /ELSTER/);
    assert.match(slip.amendment.refusal, /geändert|berichtigt/i);
  }
});

test("jurisdictions list all Länder with untranscribed calendars", () => {
  assert.equal(DE_PAYROLL_PACK.jurisdictions.length, 16);
  for (const jurisdiction of DE_PAYROLL_PACK.jurisdictions) {
    assert.ok(jurisdiction.key.startsWith("DE-"), jurisdiction.key);
    assert.equal(jurisdiction.scope, "employment");
    assert.deepEqual(jurisdiction.holidays, []);
  }
});
