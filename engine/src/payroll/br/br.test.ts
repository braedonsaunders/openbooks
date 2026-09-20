/**
 * BR payroll pack tests: declarations, regions, editions, certificates,
 * and the computeStatutory refusal guards.
 *
 * No DB, no registry side effects: the BR modules below are pure
 * declarations, and the one registry touched (tax years) is registered and
 * unregistered inside the test. Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BR_PAYROLL_PACK } from "./pack.ts";
import { BR_CERTIFICATES } from "./certificates.ts";
import { BR_WITHHOLDING } from "./withholding.ts";
import { BR_PACK_RATES, BR_TAX_YEARS } from "./rates.ts";
import { brPackFilings } from "./filings.ts";
import {
  brRateLookupScope,
  computeBrStatutoryWithRates,
  type BrEmployerRates,
} from "./compute-statutory.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  jurisdictionKey,
  payrollJurisdictionDeclared,
  payrollTaxYearProblem,
  registerPayrollTaxYears,
  unregisterPayrollTaxYears,
} from "../packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "../holidays.ts";
import { buildResolution } from "../statutory-rates.ts";

const RATES: BrEmployerRates = { ratPct: "2", fap: "1", terceirosPct: "5.8" };

function brContext(overrides: Record<string, unknown> = {}): PayrollStatutoryComputeContext {
  return {
    taxYear: 2026,
    region: "BR",
    run: { pay_date: "2026-03-15" },
    emp: { br_dependentes: "0" },
    income: "6000.00",
    nonPeriodic: "",
    pensionable: "6000.00",
    insurable: "6000.00",
    periodsPerYear: 12,
    filingAccountId: null,
    pushStatutory: () => {},
    certificateFor: () => null,
    assertRegionSupported: () => {},
    ...overrides,
  } as unknown as PayrollStatutoryComputeContext;
}

test("BR pack exists as an installable 2026 pack in reais on a calendar year", () => {
  assert.equal(BR_PAYROLL_PACK.country, "BR");
  // installable since the adapter golden proves a full monthly payslip
  // computes AND pushes all six lines through the declaration-enforcing
  // push path (adapter-goldens.test.ts), with BR slot labels landed.
  assert.equal(BR_PAYROLL_PACK.installable, true);
  assert.equal(BR_PAYROLL_PACK.statutoryCurrency, "BRL");
  assert.equal(BR_PAYROLL_PACK.taxYear.basis, "calendar");
  assert.equal(BR_PAYROLL_PACK.statutoryEngineLabel, "IRRF/INSS");
  // Three authorities share the money (Receita, RGPS, Caixa). A key naming
  // a field that does not exist looks wired.
  assert.equal(BR_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // A PLACEHOLDER holiday-pay rule would compute. Null refuses until sourced.
  assert.equal(BR_PAYROLL_PACK.jurisdictions[0]?.holidayPay, null);
});

test("BR slots name IRRF, INSS and FGTS; every pushed key declared", () => {
  const keys = BR_PAYROLL_PACK.statutorySlots.map((slot) => slot.key);
  assert.deepEqual(keys, ["irrf", "inss", "fgts"]);
  const systems = BR_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
    slot.components.map((component) => component.systemKey));
  // Exactly the six keys compute-statutory.ts pushes. The engine pushes
  // inss_patronal, never employer-side inss, hence the distinct key — and
  // FGTS rides its own slot because it settles at the Caixa, not with tax.
  assert.deepEqual(systems, [
    "irrf",
    "inss", "inss_patronal", "inss_rat", "inss_terceiros",
    "fgts",
  ]);
  const bySystem = new Map(
    BR_PAYROLL_PACK.statutorySlots.flatMap((slot) => slot.components.map((c) => [c.systemKey, c])),
  );
  // Only IRRF moves with pre-tax deductions; FGTS is employer cost, never a
  // deduction — declaring it otherwise would withhold it from net pay.
  assert.equal(bySystem.get("irrf")?.assessedOn, "taxable_income");
  assert.equal(bySystem.get("fgts")?.kind, "employer_contribution");
});

test("BR regions and withholding agree: one national region, implemented", () => {
  // installable and supported are one fact stated twice — Link 4 refuses
  // every employee of a pack whose supported is empty.
  assert.deepEqual(BR_PAYROLL_PACK.regions.known, ["BR"]);
  assert.deepEqual(BR_PAYROLL_PACK.regions.supported, ["BR"]);
  assert.deepEqual(
    BR_WITHHOLDING.regions.map((region) => [region.region, region.implemented]),
    [["BR", true]],
  );
});

test("BR declares no withholding certificate and one eSocial program type", () => {
  // No employee-filed form exists for IRRF/INSS. Since 0191 the pack
  // declares exactly one certificate, and it is explicitly NOT a form: the
  // employer-held cadastre facts made explicit, because the profile-column
  // channel validates against the typed declarations. A second declaration
  // — or a row-backed one, which the certificates API would serve as
  // fileable — fails this test.
  assert.equal(BR_CERTIFICATES.country, "BR");
  assert.deepEqual(
    BR_CERTIFICATES.certificates.map((certificate) => [
      certificate.key,
      certificate.storage,
    ]),
    [["br_cadastro", "profile_columns"]],
  );
  const filings = brPackFilings();
  assert.deepEqual(filings.programTypes.map((program) => program.key), ["br_cnpj_esocial"]);
  assert.deepEqual(filings.yearEnd, []);
});

test("BR 2026 is the only supported year; both sides refuse", async () => {
  // BR_TAX_YEARS ships on the registered BR pack, so the declaration is
  // already visible via the registry; register only when it is not.
  let registered = false;
  try {
    registerPayrollTaxYears(BR_TAX_YEARS);
    registered = true;
  } catch (error) {
    assert.match(
      (error as Error).message,
      /already declared/,
      "BR tax years must come from exactly one declaration",
    );
  }
  try {
    assert.equal(payrollTaxYearProblem("BR", 2026), null);
    assert.equal(payrollTaxYearProblem("BR", 2025)?.kind, "missing");
    assert.equal(payrollTaxYearProblem("BR", 2027)?.kind, "missing");
  } finally {
    if (registered) unregisterPayrollTaxYears("BR");
  }
  await assert.rejects(computeBrStatutoryWithRates(brContext({ taxYear: 2025 }), RATES), /2025.*has not been transcribed/);
  await assert.rejects(computeBrStatutoryWithRates(brContext({ taxYear: 2027 }), RATES), /2027.*has not been transcribed/);
});

test("BR refuses non-monthly periods, missing dependents and non-CLT regimes", async () => {
  await assert.rejects(
    computeBrStatutoryWithRates(brContext({ periodsPerYear: 13 }), RATES),
    /periodsPerYear 13 is refused/,
  );
  await assert.rejects(
    computeBrStatutoryWithRates(brContext({ emp: {} }), RATES),
    /br_dependentes is missing/,
  );
  await assert.rejects(
    computeBrStatutoryWithRates(brContext({ emp: { br_dependentes: "2.5" } }), RATES),
    /not a non-negative integer/,
  );
  await assert.rejects(
    computeBrStatutoryWithRates(brContext({ emp: { br_dependentes: "0", br_regime: "aprendiz" } }), RATES),
    /not standard monthly CLT/,
  );
  // Absent regime means standard CLT; an explicit clt agrees.
  await computeBrStatutoryWithRates(brContext({ emp: { br_dependentes: "0", br_regime: "clt" } }), RATES);
});

test("BR tenant slots cover RAT, FAP and terceiros on the eSocial account", () => {
  assert.deepEqual(BR_PACK_RATES.slots.map((slot) => slot.key), ["br_rat", "br_fap", "br_terceiros"]);
  for (const slot of BR_PACK_RATES.slots) {
    assert.equal(slot.scope, "filing_account");
    assert.equal(slot.programType, "br_cnpj_esocial");
  }
});

test("BR profile jurisdiction resolves to a declared employment calendar", () => {
  // The profile always names the single national region, so the engine
  // resolves jurisdictionKey("BR", "BR") = "BR-BR". A bare "BR" key
  // declares a calendar no employee reaches, and the undeclared-jurisdiction
  // gate then refuses every period containing a mandatory holiday (FR/IE
  // precedent: one region, one-line key fix).
  assert.equal(jurisdictionKey("BR", "BR"), "BR-BR");
  assert.equal(payrollJurisdictionDeclared("BR-BR"), true);
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "BR",
      jurisdiction: "BR-BR",
      from: "2026-01-01",
      to: "2026-01-31",
    }),
    null,
  );
});

test("BR rate lookup carries the region, or no saved rate resolves", () => {
  // Every br_* row carries a region (the schema forbids an account-scoped
  // row without one), so the scope the pack hands the resolution must carry
  // it too: a lookup of { filingAccountId } alone matches no row and the
  // whole pack refuses with rates on file. That was the shipped shape.
  const account = "11111111-1111-1111-1111-111111111111";
  const rows = [
    { id: "r1", country: "BR", rateKey: "br_rat", region: "BR", filingAccountId: null, taxYear: 2026, values: { aliquota: "2.00" }, supersededOn: null },
    { id: "r2", country: "BR", rateKey: "br_rat", region: "BR", filingAccountId: account, taxYear: 2026, values: { aliquota: "3.00" }, supersededOn: null },
  ];
  const resolution = buildResolution({ country: "BR", taxYear: 2026, pack: BR_PACK_RATES, rows, legacy: [] });
  const scope = brRateLookupScope({ region: "BR", filingAccountId: account });
  assert.deepEqual(scope, { region: "BR", filingAccountId: account });
  // The establishment's own row answers first; the region-wide row covers
  // employees on no named account.
  assert.equal(resolution.values("br_rat", scope)?.["aliquota"], "3.00");
  assert.equal(
    resolution.values("br_rat", brRateLookupScope({ region: "BR", filingAccountId: null }))?.["aliquota"],
    "2.00",
  );
  // The pre-fix shape — account but no region — resolves nothing, which is
  // the refusal a live run reported with both rows on file.
  assert.equal(resolution.values("br_rat", { filingAccountId: account }), null);
});
