/**
 * BR cross-year discrimination: ONE unchanged input priced in every
 * transcribed year produces a DIFFERENT liability per year — proving the
 * years are genuinely selected and priced, rather than new years silently
 * falling through to the year that already worked.
 *
 * - Same R$ 6.000 rendimentos, simplified arm, no INSS: IRRF 598,68 (2024
 *   Feb–Dec) vs 574,29 (2025 May–Dec) vs 394,54 (2026, after the art. 3º-A
 *   reduction) — hand-worked in tax-year-2024.test.ts, tax-year-2025.test.ts
 *   and tax-year-2026.test.ts respectively.
 * - Same R$ 3.000 salary-de-contribuição: INSS 258,81 (2024) vs 253,40
 *   (2025) vs 248,58 (2026).
 * - Same R$ 3.000 inside 2025: IRRF 13,20 (Jan–Apr) vs 0,00 (May–Dec) —
 *   the within-year editions are distinct too.
 * - End to end: computeBrStatutoryWithRates returns the same distinct IRRF
 *   figures through the adapter path, so the engine selects the year rather
 *   than falling through to 2026.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBrStatutoryWithRates,
  type BrEmployerRates,
} from "./compute-statutory.ts";
import { calculateBrInss2026 } from "./inss-2026.ts";
import { calculateBrInssFromTables } from "./inss-year.ts";
import { calculateBrIrrf2026 } from "./irrf-2026.ts";
import { calculateBrIrrfFromTables } from "./irrf-year.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  BR_2024_DEPENDENTE,
  BR_2024_INSS_BRACKETS,
  BR_2024_INSS_TETO,
  BR_2024_IRRF_FEB,
} from "./tax-year-2024.ts";
import {
  BR_2025_DEPENDENTE,
  BR_2025_INSS_BRACKETS,
  BR_2025_INSS_TETO,
  BR_2025_IRRF_EARLY,
  BR_2025_IRRF_LATE,
} from "./tax-year-2025.ts";
import { brTablesForPayDate } from "./year-tables.ts";

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

test("same R$ 6.000 prices three different IRRF liabilities across years", () => {
  const irrf2024 = calculateBrIrrfFromTables(
    {
      bands: BR_2024_IRRF_FEB.bands,
      simplificado: BR_2024_IRRF_FEB.simplificado,
      dependente: BR_2024_DEPENDENTE,
      tag: "BR 2024 IRRF (feb-dec)",
    },
    { rendimentos: "6000.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  ).irrf;
  const irrf2025 = calculateBrIrrfFromTables(
    {
      bands: BR_2025_IRRF_LATE.bands,
      simplificado: BR_2025_IRRF_LATE.simplificado,
      dependente: BR_2025_DEPENDENTE,
      tag: "BR 2025 IRRF (may-dec)",
    },
    { rendimentos: "6000.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  ).irrf;
  const irrf2026 = calculateBrIrrf2026(
    { rendimentos: "6000.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  ).irrf;
  assert.equal(irrf2024, "598.68");
  assert.equal(irrf2025, "574.29");
  assert.equal(irrf2026, "394.54");
  assert.notEqual(new Set([irrf2024, irrf2025, irrf2026]).size, 1);
});

test("same R$ 3.000 salary prices three different INSS contributions", () => {
  const inss2024 = calculateBrInssFromTables(
    { brackets: BR_2024_INSS_BRACKETS, teto: BR_2024_INSS_TETO, tag: "BR 2024 INSS" },
    { salarioContribuicao: "3000.00" },
  ).contribuicao;
  const inss2025 = calculateBrInssFromTables(
    { brackets: BR_2025_INSS_BRACKETS, teto: BR_2025_INSS_TETO, tag: "BR 2025 INSS" },
    { salarioContribuicao: "3000.00" },
  ).contribuicao;
  const inss2026 = calculateBrInss2026({ salarioContribuicao: "3000.00" }).contribuicao;
  assert.equal(inss2024, "258.81");
  assert.equal(inss2025, "253.40");
  assert.equal(inss2026, "248.58");
});

test("same R$ 3.000 inside 2025 prices differently either side of 1 May", () => {
  const april = brTablesForPayDate(2025, "2025-04-30");
  const may = brTablesForPayDate(2025, "2025-05-01");
  const price = (tables: typeof may) =>
    calculateBrIrrfFromTables(tables.irrf, {
      rendimentos: "3000.00",
      inss: "0.00",
      dependentes: 0,
      pensaoMensal: "0.00",
    }).irrf;
  assert.equal(april.irrfLabel, BR_2025_IRRF_EARLY.label);
  assert.equal(may.irrfLabel, BR_2025_IRRF_LATE.label);
  assert.equal(price(april), "13.20");
  assert.equal(price(may), "0.00");
});

test("the adapter prices the same payslip distinctly per year, no fall-through", async () => {
  // R$ 6.000 salary, no dependents: INSS is deductible, so the legal arm
  // wins in every year and the IRRF figures below are full-payslip values,
  // not the no-INSS unit goldens above.
  const price = async (taxYear: number, payDate: string): Promise<Record<string, string>> =>
    computeBrStatutoryWithRates(
      brContext({ taxYear, run: { pay_date: payDate } }),
      RATES,
    );
  const y2024 = await price(2024, "2024-06-15");
  const y2025 = await price(2025, "2025-06-15");
  const y2026 = await price(2026, "2026-03-15");
  // Hand-worked through each year's tables (INSS slices, then the IRRF
  // table on the net base, no pre-2026 reduction):
  // 2024: INSS 105,90+112,92+160,00+(1999,97×14%=279,99)=658,81;
  //   base 5341,19 ×27,5%=1468,82−896,00=572,82.
  assert.equal(y2024["BR_INSS"], "658.8100");
  assert.equal(y2024["BR_IRRF"], "572.8200");
  assert.equal(y2024["BR_REDUCAO"], "0.0000");
  // 2025: INSS 113,85+114,82+167,63+(1809,17×14%=253,28)=649,58;
  //   base 5350,42 ×27,5%=1471,36−908,73=562,63.
  assert.equal(y2025["BR_INSS"], "649.5800");
  assert.equal(y2025["BR_IRRF"], "562.6300");
  assert.equal(y2025["BR_REDUCAO"], "0.0000");
  // 2026 (the untouched path — adapter-goldens.test.ts proves 385,10):
  // INSS 641,50; base 5358,50 → bruto 564,85; redutor 179,75.
  assert.equal(y2026["BR_INSS"], "641.5000");
  assert.equal(y2026["BR_IRRF"], "385.1000");
  assert.equal(y2026["BR_REDUCAO"], "179.7500");
});
