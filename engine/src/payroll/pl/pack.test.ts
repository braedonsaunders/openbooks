import assert from "node:assert/strict";
import test from "node:test";
import { certificateDeclarationProblem } from "../certificates.ts";
import type { PayrollCertificateField } from "../certificates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { PL_PAYROLL_PACK } from "./pack.ts";
import {
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "../packs.ts";
import { PL_TAX_YEARS } from "./rates.ts";

/** Minimal adapter context: PIT-2 filed, KUP 250, birth year 1990. */
function makeCtx(taxYear: number): PayrollStatutoryComputeContext {
  return {
    tx: null as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test",
    taxYear,
    country: "PL",
    region: "PL",
    run: { pay_date: "2026-06-15" },
    emp: { pl_rok_urodzenia: "1990" },
    filingAccountId: null,
    periodsPerYear: 12,
    income: "8000.00",
    nonPeriodic: "0",
    pensionable: "8000.00",
    insurable: "0",
    deduction: () => "0",
    pushStatutory: () => {},
    storedCertificates: [],
    certificateFor: (key: string) =>
      key === "pl_pit2"
        ? { answers: { pomniejszenie: "1/12", kup: "miejscowy" } }
        : null,
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
  } as unknown as PayrollStatutoryComputeContext;
}

test("PL pack computes the full 2026 payslip and is installable", () => {
  assert.equal(PL_PAYROLL_PACK.country, "PL");
  // The monthly PIT-2-filed employment payslip (advance + standard
  // ZUS/NFZ/FP/FS/FGŚP) is proven by the parity harnesses, so the pack is
  // installable AND its one region is supported — one fact stated twice.
  assert.equal(PL_PAYROLL_PACK.installable, true);
  assert.equal(PL_PAYROLL_PACK.statutoryCurrency, "PLN");
  assert.deepEqual(PL_PAYROLL_PACK.taxYear, {
    basis: "calendar",
    startMonth: 1,
    startDay: 1,
    namedBy: "opening_year",
  });
  assert.equal(PL_PAYROLL_PACK.statutoryEngineLabel, "PIT/ZUS");
  assert.equal(PL_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  assert.equal(PL_PAYROLL_PACK.retroactivePayTreatment, "periodic");
  assert.equal(PL_PAYROLL_PACK.employeeUnionDuesTaxTreatment, null);
});

test("PL statutory slots are named, assessed, and routable", () => {
  const keys = PL_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["pit", "zus_ee", "zus_zdr", "zus_er", "fundusze_er"]);
  const bySystemKey = new Map(
    PL_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((c) => [c.systemKey + "|" + c.kind, c] as const),
    ),
  );
  // The PIT advance moves with pre-tax deductions; every contribution is
  // rate × base.
  assert.equal(bySystemKey.get("pit|deduction")?.assessedOn, "taxable_income");
  for (const key of ["zus_emeryt|deduction", "zus_rent|deduction", "zus_chor|deduction", "zus_zdr|deduction", "zus_emeryt_er|employer_contribution", "zus_rent_er|employer_contribution", "wypadkowe_er|employer_contribution", "fp_er|employer_contribution", "fs_er|employer_contribution", "fgsp_er|employer_contribution"]) {
    assert.equal(bySystemKey.get(key)?.assessedOn, "earnings", key);
  }
  assert.equal(bySystemKey.get("pit|deduction")?.remittance, "tax_authority");
  assert.equal(bySystemKey.get("zus_zdr|deduction")?.remittance, "tax_authority");
});

test("PL regions are national: one known region, and it is supported", () => {
  assert.deepEqual([...PL_PAYROLL_PACK.regions.known], ["PL"]);
  // installable and supported are one fact stated twice: Link 4 of
  // resolveEmployeePayrollContext gates EVERY employee on this list, so an
  // installable pack with an empty list could pay nobody. Per-employee gaps
  // (under-26, the FP 55–60 band) refuse by name in compute-statutory.ts.
  assert.deepEqual([...PL_PAYROLL_PACK.regions.supported], ["PL"]);
});

test("PL certificate declares the PIT-2 answers, not a W-4 clone", () => {
  const declared = PL_PAYROLL_PACK.certificates();
  assert.equal(declared.country, "PL");
  assert.equal(declared.certificates.length, 1);
  const cert = declared.certificates[0];
  assert.ok(cert);
  assert.equal(cert.key, "pl_pit2");
  assert.equal(cert.form, "PIT-2");
  assert.equal(cert.purpose, "withholding");
  assert.equal(cert.scope.level, "country");
  assert.ok(!/W-4|TD1/i.test(`${cert.form} ${cert.label}`));
  const pomn = cert.fields.find((field) => field.key === "pomniejszenie");
  assert.equal(pomn?.kind, "choice");
  assert.deepEqual(
    pomn?.choices?.map((choice) => choice.value),
    ["1/12", "1/24", "1/36", "nie"],
  );
  assert.equal(certificateDeclarationProblem(cert), null);
  // Both answers are required choices with NO default: the 300 zł reduction
  // applies only on a filed statement, and the KUP amounts differ — an
  // undeclared answer must not fall through to either.
  for (const key of ["pomniejszenie", "kup"] as const) {
    const found: PayrollCertificateField | undefined = cert.fields.find(
      (candidate) => candidate.key === key,
    );
    assert.equal(found?.kind, "choice");
    assert.equal(found?.default, undefined, key);
    assert.equal(found?.required, true, key);
  }
  const kup = cert.fields.find((field) => field.key === "kup");
  assert.deepEqual(
    kup?.choices?.map((choice) => choice.value),
    ["miejscowy", "dojazd"],
  );
});

test("PL withholding declares one national region, implemented", () => {
  const declared = PL_PAYROLL_PACK.withholding();
  assert.equal(declared.regions.length, 1);
  const region = declared.regions[0];
  assert.ok(region);
  assert.equal(region.region, "PL");
  assert.equal(region.implemented, true);
  assert.equal(region.residentWithholdingImplemented, true);
  assert.equal(region.unimplementedReason, undefined);
  assert.equal(region.certificateKey, "pl_pit2");
  assert.ok(region.citation.length > 0);
});

test("PL 2026 is transcribed, with citations", () => {
  const published = PL_TAX_YEARS.editions.filter((edition) => edition.status === "published");
  assert.equal(published.length, 1);
  assert.deepEqual(
    published.map((edition) => [edition.year, edition.effectiveFrom]),
    [[2026, "2026-01-01"]],
  );
  for (const edition of published) {
    assert.match(edition.citation, /Dz\.U\./);
  }
  // PL_TAX_YEARS ships on the registered PL pack, so the declaration is
  // already visible via the registry; register only when it is not.
  let registered = false;
  try {
    registerPayrollTaxYears(PL_TAX_YEARS);
    registered = true;
  } catch (error) {
    assert.match(
      (error as Error).message,
      /already declared/,
      "PL tax years must come from exactly one declaration",
    );
  }
  try {
    assert.equal(payrollTaxYearProblem("PL", 2026), null);
    for (const year of [2025, 2027]) {
      const problem = payrollTaxYearProblem("PL", year);
      assert.equal(problem?.kind, "missing", `${year} refuses`);
      assert.match(problem?.message ?? "", new RegExp(String(year)));
    }
  } finally {
    if (registered) unregisterPayrollTaxYears("PL");
  }
});

test("PL computeStatutory prices the standard month and refuses the gaps", async () => {
  const result = await PL_PAYROLL_PACK.computeStatutory(makeCtx(2026));
  assert.equal(result["ZALICZKA"], "498.0000");
  assert.equal(result["ZDR"], "621.2900");
  assert.equal(result["FP"], "80.0000");
  // No certificate on file must not fall through to either the 300 zł
  // reduction or the 250 zł KUP — the adapter refuses the first undeclared
  // answer it reaches (KUP), naming the certificate.
  const noCert = {
    ...makeCtx(2026),
    certificateFor: () => null,
  } as unknown as PayrollStatutoryComputeContext;
  await assert.rejects(
    () => PL_PAYROLL_PACK.computeStatutory(noCert),
    /pl_pit2/,
  );
  await assert.rejects(
    () => PL_PAYROLL_PACK.computeStatutory(makeCtx(2027)),
    /has not been transcribed/,
  );
});

test("PL tenant-declared rate: wypadkowe rides the org", () => {
  const slots = PL_PAYROLL_PACK.statutoryRates.slots;
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  const slot = byKey.get("pl_wypadkowe");
  assert.ok(slot);
  // Per payer (PKD risk category or ZUS notification): one rate per employer
  // entity, never a published table — so org scope, not a table constant.
  assert.equal(slot?.scope, "org");
  assert.deepEqual(slot?.regions, ["PL"]);
  assert.deepEqual(slot?.systemKeys, ["wypadkowe_er"]);
});

test("PL employment calendar: 12 statutory days off, no pay computation", () => {
  const byKey = new Map(PL_PAYROLL_PACK.jurisdictions.map((j) => [j.key, j]));
  assert.equal(byKey.get("PL")?.holidays.length, 12);
  assert.ok(
    byKey.get("PL")?.holidays.some((h) => h.key === "pl_corpus_christi"),
  );
  assert.equal(PL_PAYROLL_PACK.jurisdictions.every((j) => j.holidayPay === null), true);
});
