/**
 * ES payroll pack tests: declarations, regions, certificates, editions,
 * and the computeStatutory refusal guards.
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
import { ES_PACK_RATES, ES_TAX_YEARS, ratesForPayDate } from "./es/rates.ts";
import { esPackFilings } from "./es/filings.ts";
import { computeEsStatutory } from "./es/compute-statutory.ts";
import {
  PayrollPackError,
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "./packs.ts";

test("ES pack exists as an installable 2026 pack in euro on a calendar year", () => {
  assert.equal(ES_PAYROLL_PACK.country, "ES");
  // installable since the adapter golden proves a full monthly payslip
  // computes AND pushes all ten lines through the declaration-enforcing
  // push path (adapter-goldens.test.ts), with ES slot labels landed.
  assert.equal(ES_PAYROLL_PACK.installable, true);
  assert.equal(ES_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.equal(ES_PAYROLL_PACK.taxYear.basis, "calendar");
  assert.equal(ES_PAYROLL_PACK.statutoryEngineLabel, "AEAT");
  // Payroll settings only store cra/rq. Inventing aeatRemittancePartyId looks wired.
  assert.equal(ES_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // A PLACEHOLDER holiday-pay rule would compute. Null refuses until sourced.
  assert.equal(ES_PAYROLL_PACK.jurisdictions[0]?.holidayPay, null);
});

test("ES slots name IRPF withholding and Seguridad Social, every pushed key declared", () => {
  const keys = ES_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["irpf", "seguridad_social"]);
  const systems = ES_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
    slot.components.map((component) => component.systemKey),
  );
  // Exactly the ten keys compute-statutory.ts pushes — one slot for all SS
  // lines, so no new slot labels were needed. The engine pushes ss_cc_er,
  // never employer-side ss_cc, hence the distinct employer keys.
  assert.deepEqual(systems, [
    "irpf",
    "ss_cc", "ss_des", "ss_for", "ss_mei",
    "ss_cc_er", "ss_des_er", "ss_fogasa_er", "ss_for_er", "ss_mei_er",
  ]);
  const kinds = ES_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
    slot.components.map((component) => component.kind),
  );
  assert.deepEqual(kinds, [
    "deduction",
    "deduction", "deduction", "deduction", "deduction",
    "employer_contribution", "employer_contribution", "employer_contribution",
    "employer_contribution", "employer_contribution",
  ]);
  // IRPF moves with pre-tax deductions; every SS cuota is rate × base.
  const assessed = new Map(
    ES_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((component) =>
        [`${component.systemKey}|${component.kind}`, component.assessedOn] as const),
    ),
  );
  assert.equal(assessed.get("irpf|deduction"), "taxable_income");
  for (const key of [...assessed.keys()].filter((k) => k !== "irpf|deduction")) {
    assert.equal(assessed.get(key), "earnings", key);
  }
});

test("ES regions list all 19 communities and support the 17 AEAT ones", () => {
  const { regions } = ES_PAYROLL_PACK;
  assert.equal(regions.known.length, 19);
  for (const code of ["AN", "CT", "MD", "NC", "PV", "CE", "ML"]) {
    assert.ok(regions.known.includes(code), code);
  }
  assert.deepEqual([...regions.supported].sort(), [
    "AN", "AR", "AS", "CB", "CE", "CL", "CM", "CN", "CT", "EX", "GA",
    "IB", "MC", "MD", "ML", "RI", "VC",
  ]);
  const withholding = new Map(ES_WITHHOLDING.regions.map((region) => [region.region, region]));
  for (const code of [...regions.supported]) {
    assert.equal(withholding.get(code)?.implemented, true, code);
  }
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

test("ES 2026 is transcribed with two editions split at 10 September", () => {
  // ES_TAX_YEARS now ships on the registered ES pack, so the declaration is
  // already visible via the registry; register only when it is not.
  let registered = false;
  try {
    registerPayrollTaxYears(ES_TAX_YEARS);
    registered = true;
  } catch (error) {
    assert.match(
      (error as Error).message,
      /already declared/,
      "ES tax years must come from exactly one declaration",
    );
  }
  try {
    assert.equal(ES_PAYROLL_PACK.taxYears.editions.length, 2);
    assert.equal(payrollTaxYearProblem("ES", 2026), null);
    // A date either side of the September boundary resolves differently.
    assert.equal(ratesForPayDate("2026-09-09").edition, "2026-early");
    assert.equal(ratesForPayDate("2026-09-10").edition, "2026");
    assert.equal(ratesForPayDate("2026-09-09").laPalmaExcepcional, false);
    assert.equal(ratesForPayDate("2026-09-10").laPalmaExcepcional, true);
    // Both sides outside 2026 throw — never extrapolate, never clamp.
    assert.throws(() => ratesForPayDate("2025-12-31"), /no transcribed tables/);
    assert.throws(() => ratesForPayDate("2027-01-01"), /no transcribed tables/);
  } finally {
    if (registered) unregisterPayrollTaxYears("ES");
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

test("ES computeStatutory refuses foral regions, off-year runs and off-monthly payroll", async () => {
  const pushed: Array<{ key: string; amount: string }> = [];
  const base = {
    taxYear: 2026,
    region: "MD",
    run: { pay_date: "2026-03-15" },
    emp: { es_situacion_laboral: "activo", es_grupo_cotizacion: "7", es_ano_nacimiento: "1990" },
    income: "2000.00",
    nonPeriodic: "",
    pensionable: "2000.00",
    insurable: "2000.00",
    periodsPerYear: 12,
    pushStatutory: (key: string, _kind: string, _label: string, amount: string) => {
      pushed.push({ key, amount });
    },
    certificateFor: () => null,
    assertRegionSupported: (region: string) => {
      if (!ES_PAYROLL_PACK.regions.supported.includes(region)) {
        throw new PayrollPackError(`unsupported region ${region}`);
      }
    },
  } as unknown as Parameters<typeof computeEsStatutory>[0];
  const good = await computeEsStatutory(base);
  assert.match(good["ES_TIPO_IRPF"] ?? "", /^\d+\.\d\d$/);
  assert.ok(pushed.some((line) => line.key === "irpf"));

  await assert.rejects(
    () => computeEsStatutory({ ...base, region: "PV" }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /foral/);
      return true;
    },
  );
  await assert.rejects(
    () => computeEsStatutory({ ...base, taxYear: 2025 }),
    /has not been transcribed/,
  );
  await assert.rejects(
    () => computeEsStatutory({ ...base, periodsPerYear: 52 }),
    /intrinsically monthly/,
  );
});
