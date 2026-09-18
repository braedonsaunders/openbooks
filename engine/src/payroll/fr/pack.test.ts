import assert from "node:assert/strict";
import test from "node:test";
import { certificateDeclarationProblem } from "../certificates.ts";
import {
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "../tax-years.ts";
import { FR_PAYROLL_PACK } from "./pack.ts";
import { FR_TAX_YEARS } from "./rates.ts";

test("FR skeleton pack exists and is not installable", () => {
  assert.equal(FR_PAYROLL_PACK.country, "FR");
  assert.equal(FR_PAYROLL_PACK.installable, false);
  assert.equal(FR_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(FR_PAYROLL_PACK.taxYear, {
    basis: "calendar",
    startMonth: 1,
    startDay: 1,
    namedBy: "opening_year",
  });
  assert.equal(FR_PAYROLL_PACK.statutoryEngineLabel, "PAS");
  assert.equal(FR_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  assert.equal(FR_PAYROLL_PACK.retroactivePayTreatment, "periodic");
  assert.equal(FR_PAYROLL_PACK.employeeUnionDuesTaxTreatment, null);
});

test("FR statutory slots are named, assessed, and routable", () => {
  const keys = FR_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["pas", "salariales", "retraite_comp", "patronales"]);
  const bySystemKey = new Map(
    FR_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((c) => [c.systemKey + "|" + c.kind, c] as const),
    ),
  );
  // PAS moves with pre-tax deductions; everything else is rate × salary.
  assert.equal(bySystemKey.get("pas|deduction")?.assessedOn, "taxable_income");
  for (const key of ["vieillesse|deduction", "csg|deduction", "arrco|deduction", "atmp|employer_contribution"]) {
    assert.equal(bySystemKey.get(key)?.assessedOn, "earnings", key);
  }
  // AGIRC-ARRCO goes to the employer's own caisse, never the statutory vendor.
  assert.equal(bySystemKey.get("arrco|deduction")?.remittance, "external");
  assert.equal(bySystemKey.get("pas|deduction")?.remittance, "tax_authority");
});

test("FR regions are national: one known region, none supported until PAS computes", () => {
  assert.deepEqual([...FR_PAYROLL_PACK.regions.known], ["FR"]);
  assert.deepEqual([...FR_PAYROLL_PACK.regions.supported], []);
});

test("FR certificate declares the PAS rate option, not a W-4 clone", () => {
  const declared = FR_PAYROLL_PACK.certificates();
  assert.equal(declared.country, "FR");
  assert.equal(declared.certificates.length, 1);
  const cert = declared.certificates[0];
  assert.ok(cert);
  assert.equal(cert.key, "fr_pas_option");
  assert.equal(cert.form, "2043");
  assert.equal(cert.purpose, "withholding");
  assert.equal(cert.scope.level, "country");
  assert.ok(!/W-4|TD1/i.test(`${cert.form} ${cert.label}`));
  const option = cert.fields.find((field) => field.key === "taux_option");
  assert.equal(option?.kind, "choice");
  assert.deepEqual(
    option?.choices?.map((choice) => choice.value),
    ["personnalise", "individualise", "non_personnalise"],
  );
  assert.equal(certificateDeclarationProblem(cert), null);
});

test("FR withholding declares one national region, unimplemented by name", () => {
  const declared = FR_PAYROLL_PACK.withholding();
  assert.equal(declared.regions.length, 1);
  const region = declared.regions[0];
  assert.ok(region);
  assert.equal(region.region, "FR");
  assert.equal(region.implemented, false);
  assert.match(region.unimplementedReason ?? "", /barème/);
  assert.equal(region.certificateKey, "fr_pas_option");
  assert.ok(region.citation.length > 0);
});

test("FR refuses the untranscribed 2026 year by name", () => {
  assert.equal(
    FR_TAX_YEARS.editions.filter((edition) => edition.status === "published").length,
    0,
  );
  registerPayrollTaxYears(FR_TAX_YEARS);
  try {
    const problem = payrollTaxYearProblem("FR", 2026);
    assert.equal(problem?.kind, "missing");
    assert.match(problem?.message ?? "", /2026/);
  } finally {
    unregisterPayrollTaxYears("FR");
  }
});

test("FR computeStatutory refuses instead of calculating", async () => {
  await assert.rejects(
    () => FR_PAYROLL_PACK.computeStatutory(),
    /not installable/,
  );
});

test("FR employment calendars: 11 national holidays, 13 in Alsace-Moselle", () => {
  const byKey = new Map(FR_PAYROLL_PACK.jurisdictions.map((j) => [j.key, j]));
  assert.equal(byKey.get("FR")?.holidays.length, 11);
  assert.equal(byKey.get("FR-AM")?.holidays.length, 13);
  assert.ok(
    byKey.get("FR-AM")?.holidays.some((h) => h.key === "fr_good_friday"),
  );
  assert.equal(FR_PAYROLL_PACK.jurisdictions.every((j) => j.holidayPay === null), true);
});
