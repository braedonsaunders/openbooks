/**
 * IT payroll pack skeleton tests — the declaration, not a computation.
 *
 * Nothing here computes a euro: the pack is installable:false with no
 * transcribed edition, so these tests pin the skeleton contract instead —
 * the slots exist under their statutory names, all 20 regions are known and
 * refused, the certificate is the real detrazioni declaration (not a W-4
 * clone), the CU/770 filings are declared-but-unpopulated, and 2026 is
 * refused by name everywhere a year can appear.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { IT_CERTIFICATES } from "./certificates.ts";
import { ItPayrollRefusal, computeItStatutory } from "./compute-statutory.ts";
import { IT_PACK_FILINGS } from "./filings.ts";
import { IT_JURISDICTIONS } from "./jurisdictions.ts";
import { IT_PAYROLL_PACK } from "./pack.ts";
import { IT_REGION_CODES } from "./regions.ts";
import { IT_TAX_YEARS } from "./rates.ts";
import { IT_WITHHOLDING } from "./withholding.ts";

test("IT pack exists, is uninstallable, computes in EUR on the calendar year", () => {
  assert.equal(IT_PAYROLL_PACK.country, "IT");
  assert.equal(IT_PAYROLL_PACK.installable, false);
  assert.equal(IT_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(IT_PAYROLL_PACK.taxYear, {
    basis: "calendar",
    startMonth: 1,
    startDay: 1,
    namedBy: "opening_year",
  });
});

test("statutory slots name IRPEF, both addizionali, and both INPS shares", () => {
  const slots = IT_PAYROLL_PACK.statutorySlots;
  assert.deepEqual(slots.map((slot) => slot.key), [
    "irpef",
    "addizionale_regionale",
    "addizionale_comunale",
    "inps",
  ]);
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  assert.equal(byKey.get("irpef")?.components[0]?.systemKey, "income_tax");
  assert.equal(byKey.get("addizionale_regionale")?.components[0]?.systemKey, "regional_surtax");
  assert.equal(byKey.get("addizionale_comunale")?.components[0]?.systemKey, "municipal_surtax");
  // Income taxes move with pre-tax deductions; INPS contributions do not.
  for (const key of ["irpef", "addizionale_regionale", "addizionale_comunale"]) {
    assert.equal(byKey.get(key)?.components[0]?.assessedOn, "taxable_income", key);
  }
  const inps = byKey.get("inps")?.components ?? [];
  assert.deepEqual(inps.map((c) => c.kind), ["deduction", "employer_contribution"]);
  for (const component of inps) {
    assert.equal(component.assessedOn, "earnings", component.code);
    assert.equal(component.systemKey, "inps", component.code);
  }
});

test("all 20 regions are known and every one is refused by name", () => {
  assert.equal(IT_REGION_CODES.length, 20);
  assert.deepEqual(IT_PAYROLL_PACK.regions.known, IT_REGION_CODES);
  assert.deepEqual(IT_PAYROLL_PACK.regions.supported, []);
  assert.match(IT_PAYROLL_PACK.regions.unsupportedReason, /addizionale/);
  assert.equal(IT_WITHHOLDING.country, "IT");
  assert.deepEqual(
    IT_WITHHOLDING.regions.map((region) => region.region),
    IT_REGION_CODES,
  );
  for (const region of IT_WITHHOLDING.regions) {
    assert.equal(region.implemented, false, region.region);
    assert.match(region.unimplementedReason ?? "", /transcribed/, region.region);
  }
});

test("the certificate is the detrazioni declaration, not a W-4 clone", () => {
  assert.equal(IT_CERTIFICATES.country, "IT");
  assert.equal(IT_CERTIFICATES.certificates.length, 1);
  const cert = IT_CERTIFICATES.certificates[0]!;
  assert.equal(cert.key, "it_detrazioni");
  assert.match(cert.form, /TUIR/);
  assert.match(cert.citation, /DPR 22 dicembre 1986, n\. 917/);
  const fields = new Map(cert.fields.map((field) => [field.key, field]));
  assert.ok(fields.has("figli_a_carico"), "dependent children are declared");
  assert.ok(fields.has("reddito_complessivo_presunto"), "presumed total income is declared");
  for (const field of cert.fields) {
    assert.deepEqual(field.storage ?? { kind: "row" }, { kind: "row" }, field.key);
  }
  assert.equal(IT_PAYROLL_PACK.certificates(), IT_CERTIFICATES);
});

test("2026 is refused by name: no published edition, scaffold names the law", () => {
  const published2026 = IT_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.deepEqual(published2026, []);
  assert.equal(IT_TAX_YEARS.ratesModule, "engine/src/payroll/it/rates.ts");
  assert.match(IT_TAX_YEARS.scaffold.steps.join("\n"), /L\. 30 dicembre 2025, n\. 199/);
  assert.equal(IT_PAYROLL_PACK.taxYears, IT_TAX_YEARS);
});

test("the statutory pass refuses with the requested year", async () => {
  const ctx = { taxYear: 2026 } as PayrollStatutoryComputeContext;
  await assert.rejects(computeItStatutory(ctx), (error: unknown) => {
    assert.ok(error instanceof ItPayrollRefusal);
    assert.ok(error instanceof PayrollError);
    assert.match((error as Error).message, /2026/);
    assert.match((error as Error).message, /engine\/src\/payroll\/it\/rates\.ts/);
    return true;
  });
});

test("CU and 770 are declared annually, unpopulated, with refused corrections", async () => {
  assert.equal(IT_PACK_FILINGS.country, "IT");
  assert.deepEqual(
    IT_PACK_FILINGS.yearEnd.map((filing) => [filing.key, filing.cadence]),
    [["cu", "annual"], ["770", "annual"]],
  );
  for (const filing of IT_PACK_FILINGS.yearEnd) {
    assert.equal(filing.slip, undefined, `${filing.key} declares no slip builder`);
    assert.match(filing.downloadRefusal ?? "", /no Entratel/, filing.key);
    assert.equal(filing.amendment.supported, false, `${filing.key} names its correction gap`);
    await assert.rejects(
      filing.population("org", 2026),
      /no tax-year edition is transcribed/,
    );
    assert.equal(filing.parseRowId("anything"), null);
  }
  assert.equal(IT_PAYROLL_PACK.filings(), IT_PACK_FILINGS);
});

test("the national festivity calendar is declared with Easter Monday computed", () => {
  assert.equal(IT_JURISDICTIONS.length, 1);
  const italy = IT_JURISDICTIONS[0]!;
  assert.equal(italy.scope, "employment");
  assert.equal(italy.holidays.length, 11);
  const pasquetta = italy.holidays.find((holiday) => holiday.key === "lunedi_angelo")!;
  assert.deepEqual(pasquetta.rule, { kind: "easter_offset", days: 1 });
  assert.equal(italy.holidayPay, null);
  assert.deepEqual(IT_PAYROLL_PACK.jurisdictions, IT_JURISDICTIONS);
  assert.equal(IT_PAYROLL_PACK.withholding(), IT_WITHHOLDING);
});
