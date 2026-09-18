/**
 * NL payroll pack skeleton tests — pure declarations, no database.
 *
 * Proves: the pack object exists with its slots, regions and certificates;
 * every certificate passes the generic certificate validation; the
 * withholding declaration passes the generic withholding registration; the
 * untranscribed year 2026 is refused by name; the statutory engine refuses
 * before it can compute.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../../payroll-error.ts";
import {
  certificateDeclarationProblem,
} from "../certificates.ts";
import {
  registerPayrollWithholding,
  unregisterPayrollWithholding,
} from "../withholding-jurisdictions.ts";
import { NL_PAYROLL_PACK, NL_TAX_YEARS, NL_WITHHOLDING } from "./pack.ts";

test("the NL pack exists and is a non-installable EUR calendar-year skeleton", () => {
  assert.equal(NL_PAYROLL_PACK.country, "NL");
  assert.equal(NL_PAYROLL_PACK.installable, false);
  assert.equal(NL_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(NL_PAYROLL_PACK.taxYear, {
    basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
  });
  assert.equal(NL_PAYROLL_PACK.statutoryEngineLabel, "Loonbelastingtabellen");
  assert.equal(NL_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // Retro pay is taxed as bijzondere beloning, never annualized as period
  // income — the pack's nonPeriodic path, not a new engine.
  assert.equal(NL_PAYROLL_PACK.retroactivePayTreatment, "non_periodic");
  // Employee-paid union dues buy no loonheffing deduction.
  assert.equal(NL_PAYROLL_PACK.employeeUnionDuesTaxTreatment, null);
});

test("the NL pack declares the loonheffing as one combined slot, not a Canada-shaped split", () => {
  const slots = NL_PAYROLL_PACK.statutorySlots;
  const keys = slots.map((slot) => slot.key);
  assert.deepEqual(keys, ["loonheffing", "werknemersverzekeringen", "zvw"]);
  const loonheffing = slots[0]!;
  assert.equal(loonheffing.components.length, 1);
  assert.match(loonheffing.components[0]!.name, /Loonbelasting\/premie volksverzekeringen/);
  assert.equal(loonheffing.components[0]!.assessedOn, "taxable_income");
  assert.equal(loonheffing.components[0]!.remittance, "tax_authority");
  // Employer SV is employer-side only: WW/WIA/ZW plus the werkgeversheffing Zvw.
  const employer = slots.flatMap((slot) => slot.components)
    .filter((component) => component.kind === "employer_contribution");
  assert.deepEqual(
    employer.map((component) => component.systemKey),
    ["ww", "wia", "zw", "zvw"],
  );
  for (const component of employer) {
    assert.equal(component.assessedOn, "earnings");
    assert.equal(component.remittance, "tax_authority");
  }
});

test("the NL pack lists NL as known and refuses it by name until the witte tabellen land", () => {
  assert.deepEqual([...NL_PAYROLL_PACK.regions.known], ["NL"]);
  assert.deepEqual([...NL_PAYROLL_PACK.regions.supported], []);
  assert.match(NL_PAYROLL_PACK.regions.unsupportedReason, /witte loonbelastingtabellen/);
});

test("the NL pack declares the real certificate, and it passes generic validation", () => {
  const declared = NL_PAYROLL_PACK.certificates();
  assert.equal(declared.country, "NL");
  assert.equal(declared.certificates.length, 1);
  const [form] = declared.certificates;
  assert.equal(form!.key, "nl_loonheffingen");
  assert.equal(form!.form, "Model opgaaf gegevens voor de loonheffingen");
  assert.equal(form!.storage, "certificate_rows");
  assert.ok(
    form!.fields.some((field) => field.key === "apply_loonheffingskorting" && field.kind === "flag"),
    "the loonheffingskorting question is declared",
  );
  for (const certificate of declared.certificates) {
    assert.equal(certificateDeclarationProblem(certificate), null, certificate.key);
  }
});

test("the NL withholding declaration passes the generic registration", () => {
  registerPayrollWithholding(NL_WITHHOLDING);
  try {
    const region = NL_WITHHOLDING.regions[0]!;
    assert.equal(region.implemented, false);
    assert.match(region.unimplementedReason ?? "", /2026 witte loonbelastingtabellen/);
    assert.equal(region.certificateKey, "nl_loonheffingen");
  } finally {
    unregisterPayrollWithholding("NL");
  }
});

test("2026 is refused by name: no published edition covers it", () => {
  assert.equal(NL_TAX_YEARS.country, "NL");
  assert.equal(NL_TAX_YEARS.ratesModule, "engine/src/payroll/nl/rates.ts");
  const published2026 = NL_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 0, "2026 must stay untranscribed until sourced tables land");
});

test("the NL filings declare the loonaangifte programme and a jaaropgaaf that refuses", async () => {
  const filings = NL_PAYROLL_PACK.filings();
  assert.equal(filings.country, "NL");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["nl_loonheffingen"],
  );
  assert.equal(filings.yearEnd.length, 1);
  const jaaropgaaf = filings.yearEnd[0]!;
  assert.equal(jaaropgaaf.key, "jaaropgaaf");
  assert.equal(jaaropgaaf.cadence, "annual");
  assert.equal(jaaropgaaf.parseRowId("anything"), null);
  assert.equal(jaaropgaaf.amendment.supported, false);
  await assert.rejects(() => filings.yearEnd[0]!.population("org", 2026), /not transcribed/);
});

test("the NL statutory engine refuses before it can compute", async () => {
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory({} as never), PayrollError);
  await assert.rejects(
    () => NL_PAYROLL_PACK.computeStatutory({} as never),
    /2026 witte loonbelastingtabellen/,
  );
});
