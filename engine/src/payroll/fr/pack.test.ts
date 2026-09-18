import assert from "node:assert/strict";
import test from "node:test";
import { certificateDeclarationProblem } from "../certificates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { FR_PAYROLL_PACK } from "./pack.ts";
import {
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "../packs.ts";
import { FR_TAX_YEARS } from "./rates.ts";
import { frPasEditionForVersement } from "./tables-2026.ts";

/** Minimal adapter context: no certificates answered, June versement. */
function makeCtx(taxYear: number): PayrollStatutoryComputeContext {
  return {
    tx: null as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test",
    taxYear,
    country: "FR",
    region: "FR",
    run: { pay_date: "2026-06-15" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: "2000.00",
    nonPeriodic: "0",
    pensionable: "2000.00",
    insurable: "0",
    deduction: () => "0",
    pushStatutory: () => {},
    storedCertificates: [],
    certificateFor: () => null,
    bool: () => false,
    assertRegionSupported: () => {},
    employerLevies: {
      wcbAmount: "0",
      wcbAssessable: "0",
      ehtAmount: "0",
      ehtEarnings: "0",
      hsfAmount: "0",
      hsfEarnings: "0",
    },
  };
}

test("FR pack computes the full 2026 payslip and is installable", () => {
  assert.equal(FR_PAYROLL_PACK.country, "FR");
  // PAS + URSSAF + AGIRC-ARRCO prove out in the parity harnesses. This waited on
  // packAccounts.FR.slots.* — those landed in all seven locales, so the flip is
  // live. The catalog gate is what keeps this honest: if a future slot arrives
  // without labels, messages-catalog goes red before this does.
  assert.equal(FR_PAYROLL_PACK.installable, true);
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
  for (const key of ["vieillesse|deduction", "csg|deduction", "arrco|deduction", "ceg|deduction", "cet|deduction", "atmp|employer_contribution", "vieillesse_er|employer_contribution", "ags_er|employer_contribution", "cdn_er|employer_contribution", "arrco|employer_contribution", "ceg|employer_contribution", "cet|employer_contribution"]) {
    assert.equal(bySystemKey.get(key)?.assessedOn, "earnings", key);
  }
  assert.equal(bySystemKey.get("ceg|deduction")?.remittance, "external");
  assert.equal(bySystemKey.get("cet|employer_contribution")?.remittance, "external");
  // AGIRC-ARRCO goes to the employer's own caisse, never the statutory vendor.
  assert.equal(bySystemKey.get("arrco|deduction")?.remittance, "external");
  assert.equal(bySystemKey.get("pas|deduction")?.remittance, "tax_authority");
});

test("FR regions are national: one known region, none supported (F-fr-001)", () => {
  assert.deepEqual([...FR_PAYROLL_PACK.regions.known], ["FR"]);
  // supported stays [] even though the pack is installable: DOM domiciles
  // use untranscribed grilles II/III, so no region's income tax computes
  // for every domicile it legitimately carries. Never regress this.
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
  // Domicile is a required choice with NO default: the three grilles differ
  // and an undeclared domicile must not fall through to grille I.
  const domicile = cert.fields.find((field) => field.key === "domicile");
  assert.equal(domicile?.kind, "choice");
  assert.equal(domicile?.default, undefined);
  assert.equal(domicile?.required, true);
  assert.deepEqual(
    domicile?.choices?.map((choice) => choice.value),
    ["metropole_hors_france", "guadeloupe_reunion_martinique", "guyane_mayotte"],
  );
});

test("FR withholding declares one national region, implemented for grille I", () => {
  const declared = FR_PAYROLL_PACK.withholding();
  assert.equal(declared.regions.length, 1);
  const region = declared.regions[0];
  assert.ok(region);
  assert.equal(region.region, "FR");
  assert.equal(region.implemented, true);
  assert.equal(region.residentWithholdingImplemented, true);
  assert.equal(region.unimplementedReason, undefined);
  assert.equal(region.certificateKey, "fr_pas_option");
  assert.ok(region.citation.length > 0);
});

test("FR 2026 is transcribed, with both edition boundaries and citations", () => {
  const published = FR_TAX_YEARS.editions.filter((edition) => edition.status === "published");
  assert.equal(published.length, 2);
  assert.deepEqual(
    published.map((edition) => [edition.year, edition.effectiveFrom]),
    [[2026, "2026-01-01"], [2026, "2026-05-01"]],
  );
  for (const edition of published) {
    assert.match(edition.citation, /BOI-BAREME-000037/);
  }
  // FR_TAX_YEARS now ships on the registered FR pack, so the declaration is
  // already visible via the registry; register only when it is not (a pack
  // test importing ./pack.ts directly without the registry must keep working).
  let registered = false;
  try {
    registerPayrollTaxYears(FR_TAX_YEARS);
    registered = true;
  } catch (error) {
    assert.match(
      (error as Error).message,
      /already declared/,
      "FR tax years must come from exactly one declaration",
    );
  }
  try {
    assert.equal(payrollTaxYearProblem("FR", 2026), null);
    for (const year of [2025, 2027]) {
      const problem = payrollTaxYearProblem("FR", year);
      assert.equal(problem?.kind, "missing", `${year} refuses`);
      assert.match(problem?.message ?? "", new RegExp(String(year)));
    }
  } finally {
    if (registered) unregisterPayrollTaxYears("FR");
  }
});

test("FR edition resolution: May-2025 grids Jan–Apr, May-2026 grids from May", () => {
  assert.equal(frPasEditionForVersement("2026-01-01"), "may2025");
  assert.equal(frPasEditionForVersement("2026-04-30"), "may2025");
  assert.equal(frPasEditionForVersement("2026-05-01"), "may2026");
  assert.equal(frPasEditionForVersement("2026-12-31"), "may2026");
  assert.throws(() => frPasEditionForVersement("2025-12-31"));
  assert.throws(() => frPasEditionForVersement("2027-01-01"));
});

test("FR computeStatutory refuses untranscribed years and undeclared domiciles", async () => {
  // No domicile may fall through to grille I: the adapter refuses first.
  await assert.rejects(
    () => FR_PAYROLL_PACK.computeStatutory(makeCtx(2026)),
    /domicile/,
  );
  await assert.rejects(
    () => FR_PAYROLL_PACK.computeStatutory(makeCtx(2027)),
    /has not been transcribed/,
  );
});

test("FR tenant-declared rates: AT/MP and versement mobilité ride the SIRET account", () => {
  const slots = FR_PAYROLL_PACK.statutoryRates.slots;
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  for (const key of ["fr_atmp", "fr_versement_mobilite"]) {
    const slot = byKey.get(key);
    assert.ok(slot, key);
    assert.equal(slot?.scope, "filing_account");
    assert.equal(slot?.programType, "fr_siret");
    assert.deepEqual(slot?.regions, ["FR"]);
  }
  assert.deepEqual(byKey.get("fr_atmp")?.systemKeys, ["atmp"]);
  assert.deepEqual(byKey.get("fr_versement_mobilite")?.systemKeys, ["cdn_er"]);
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
