/**
 * ES payroll skeleton tests: the pack declares, the engine refuses.
 *
 * No DB, no registry side effects: the ES modules below are pure
 * declarations, and the one registry touched (tax years) is registered and
 * unregistered inside the test. Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ES_PAYROLL_PACK } from "./es/pack.ts";
import { ES_CERTIFICATES } from "./es/certificates.ts";
import { ES_WITHHOLDING } from "./es/withholding.ts";
import { ES_PACK_RATES, ES_TAX_YEARS } from "./es/rates.ts";
import { esPackFilings } from "./es/filings.ts";
import { computeEsStatutory } from "./es/compute-statutory.ts";
import {
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "./tax-years.ts";
import { PayrollPackError } from "./packs.ts";

test("ES pack exists as an uninstallable skeleton in euro on a calendar year", () => {
  assert.equal(ES_PAYROLL_PACK.country, "ES");
  assert.equal(ES_PAYROLL_PACK.installable, false);
  assert.equal(ES_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.equal(ES_PAYROLL_PACK.taxYear.basis, "calendar");
  assert.equal(ES_PAYROLL_PACK.statutoryEngineLabel, "AEAT");
  // Payroll settings only store cra/rq. Inventing aeatRemittancePartyId looks wired.
  assert.equal(ES_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // A PLACEHOLDER holiday-pay rule would compute. Null refuses until sourced.
  assert.equal(ES_PAYROLL_PACK.jurisdictions[0]?.holidayPay, null);
});

test("ES slots name IRPF withholding and Seguridad Social, employee plus employer", () => {
  const keys = ES_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["irpf", "seguridad_social"]);
  const systems = ES_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
    slot.components.map((component) => component.systemKey),
  );
  assert.deepEqual(systems, ["irpf", "ss_cc", "ss_cc"]);
  const kinds = ES_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
    slot.components.map((component) => component.kind),
  );
  assert.deepEqual(kinds, ["deduction", "deduction", "employer_contribution"]);
});

test("ES regions list all 19 communities and support none yet", () => {
  const { regions } = ES_PAYROLL_PACK;
  assert.equal(regions.known.length, 19);
  for (const code of ["AN", "CT", "MD", "NC", "PV", "CE", "ML"]) {
    assert.ok(regions.known.includes(code), code);
  }
  assert.deepEqual([...regions.supported], []);
});

test("ES foral territories are refused by name, never covered by AEAT", () => {
  const reasons = ES_PAYROLL_PACK.regions.unsupportedReasons ?? {};
  assert.match(reasons["NC"] ?? "", /Navarra/);
  const pv = reasons["PV"] ?? "";
  for (const name of ["Álava", "Gipuzkoa", "Bizkaia"]) {
    assert.match(pv, new RegExp(name), "PV names " + name);
  }
  const withholding = new Map(ES_WITHHOLDING.regions.map((region) => [region.region, region]));
  for (const code of ["NC", "PV"]) {
    assert.equal(withholding.get(code)?.implemented, false, code);
  }
  assert.match(withholding.get("PV")?.unimplementedReason ?? "", /Bizkaia/);
});

test("ES certificate is the real Modelo 145, not a W-4/TD1 clone", () => {
  assert.equal(ES_CERTIFICATES.country, "ES");
  assert.equal(ES_CERTIFICATES.certificates.length, 1);
  const certificate = ES_CERTIFICATES.certificates[0]!;
  assert.equal(certificate.form, "145");
  assert.equal(certificate.key, "es_145");
  assert.equal(certificate.storage, "certificate_rows");
  const fields = new Map(certificate.fields.map((field) => [field.key, field]));
  const situacion = fields.get("situacion_familiar");
  assert.equal(situacion?.kind, "choice");
  assert.deepEqual(
    situacion?.choices?.map((choice) => choice.value),
    ["1", "2", "3"],
  );
  for (const cloned of ["filing_status", "allowances", "claim_code", "multiple_jobs"]) {
    assert.equal(fields.has(cloned), false, "no W-4/TD1 field " + cloned);
  }
  assert.equal(ES_PAYROLL_PACK.certificates(), ES_CERTIFICATES);
});

test("ES 2026 is refused by name on taxYears", () => {
  registerPayrollTaxYears(ES_TAX_YEARS);
  try {
    assert.deepEqual(ES_PAYROLL_PACK.taxYears.editions, []);
    const problem = payrollTaxYearProblem("ES", 2026);
    assert.notEqual(problem, null);
    assert.equal(problem?.kind, "missing");
    assert.match(problem?.message ?? "", /2026/);
    assert.match(problem?.message ?? "", /engine\/src\/payroll\/es\/rates\.ts/);
  } finally {
    unregisterPayrollTaxYears("ES");
  }
});

test("ES filings declare the TGSS account and build no year-end return yet", () => {
  const filings = esPackFilings();
  assert.equal(filings.country, "ES");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["es_tgss_ccc"],
  );
  assert.deepEqual([...filings.yearEnd], []);
  assert.deepEqual(ES_PAYROLL_PACK.filings(), filings);
});

test("ES statutory rates carry no tenant slots: every rate is a published constant", () => {
  assert.equal(ES_PACK_RATES.country, "ES");
  assert.deepEqual([...ES_PACK_RATES.slots], []);
});

test("ES computeStatutory refuses instead of inventing money", async () => {
  await assert.rejects(
    () => computeEsStatutory(),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /2026/);
      assert.match((error as Error).message, /Bizkaia/);
      return true;
    },
  );
});
