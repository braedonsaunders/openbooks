/**
 * BR 2024 goldens and sweeps: the pure INSS + IRRF calculators over the
 * 2024 tables, plus the within-year edition selector.
 *
 * Every figure below is hand-worked from the transcribed instruments:
 * - INSS: Portaria Interministerial MPS/MF nº 2, de 11/1/2024, ANEXO II
 *   (faixa a faixa, per-slice truncation to cents — the eSocial rule the
 *   2026 module documents);
 * - IRRF January: Lei 14.663/2023, art. 5º, item X (May 2023–Jan 2024);
 * - IRRF February–December: Lei 14.848/2024, art. 1º, item XI;
 * - deductions: R$ 189,59 per dependent, simplified 25% of the zero band
 *   (RFB official 2024 tabelas page: 528,00 Jan / 564,80 from Feb).
 * No art. 3º-A reduction existed before Lei 15.270/2025 (effects 1/1/2026),
 * so every 2024 golden asserts reducao "0.00".
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateBrInssFromTables } from "./inss-year.ts";
import { calculateBrIrrfFromTables } from "./irrf-year.ts";
import {
  BR_2024_DEPENDENTE,
  BR_2024_INSS_BRACKETS,
  BR_2024_INSS_TETO,
  BR_2024_IRRF_FEB,
  BR_2024_IRRF_JAN,
} from "./tax-year-2024.ts";
import { brTablesForPayDate } from "./year-tables.ts";

const inss = (salario: string): string =>
  calculateBrInssFromTables(
    { brackets: BR_2024_INSS_BRACKETS, teto: BR_2024_INSS_TETO, tag: "BR 2024 INSS" },
    { salarioContribuicao: salario },
  ).contribuicao;

/** IRRF through one named 2024 monthly edition (simplified arm, no INSS). */
const irrfJan = (rendimentos: string) =>
  calculateBrIrrfFromTables(
    {
      bands: BR_2024_IRRF_JAN.bands,
      simplificado: BR_2024_IRRF_JAN.simplificado,
      dependente: BR_2024_DEPENDENTE,
      tag: "BR 2024 IRRF (jan)",
    },
    { rendimentos, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  );

const irrfFeb = (rendimentos: string) =>
  calculateBrIrrfFromTables(
    {
      bands: BR_2024_IRRF_FEB.bands,
      simplificado: BR_2024_IRRF_FEB.simplificado,
      dependente: BR_2024_DEPENDENTE,
      tag: "BR 2024 IRRF (feb-dec)",
    },
    { rendimentos, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  );

test("INSS 2024 sweeps every bracket edge and the teto", () => {
  // Hand-worked, slice by slice, truncated:
  // 1412,00 × 7,5% = 105,90 exact.
  assert.equal(inss("1412.00"), "105.90");
  // One centavo into the 9% slice prices nothing extra (0,01 × 9% truncates).
  assert.equal(inss("1412.01"), "105.90");
  // 1254,68 × 9% = 112,9212 → 112,92; total 218,82.
  assert.equal(inss("2666.68"), "218.82");
  assert.equal(inss("2666.69"), "218.82");
  // 1333,35 × 12% = 160,002 → 160,00; total 378,82.
  assert.equal(inss("4000.03"), "378.82");
  assert.equal(inss("4000.04"), "378.82");
  // 3785,99 × 14% = 530,0386 → 530,03; teto total 908,85.
  assert.equal(inss("7786.02"), "908.85");
  // Above the teto prices nothing more.
  assert.equal(inss("7786.03"), "908.85");
  assert.equal(inss("20000.00"), "908.85");
});

test("INSS 2024 is sliced progressively, never flat-rated at the top rate", () => {
  // The classic error: 3.000,00 × 12% = 360,00. The sliced truth:
  // 105,90 + 112,92 + (333,32 × 12% = 39,9984 → 39,99) = 258,81.
  const result = calculateBrInssFromTables(
    { brackets: BR_2024_INSS_BRACKETS, teto: BR_2024_INSS_TETO, tag: "BR 2024 INSS" },
    { salarioContribuicao: "3000.00" },
  );
  assert.equal(result.contribuicao, "258.81");
  assert.deepEqual(result.fatias, ["105.90", "112.92", "39.99"]);
  assert.notEqual(result.contribuicao, "360.00");
});

test("IRRF January 2024 prices the Lei 14.663 table", () => {
  // R$ 3.000 simplificado: base 3000 − 528,00 = 2472,00;
  // 2472,00 × 7,5% = 185,40 − 158,40 = 27,00. No reduction in 2024.
  const result = irrfJan("3000.00");
  assert.equal(result.deducaoVia, "simplificado");
  assert.equal(result.deducaoAplicada, "528.00");
  assert.equal(result.baseCalculo, "2472.00");
  assert.equal(result.impostoBruto, "27.00");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "27.00");
});

test("IRRF January 2024 is continuous at the top joint", () => {
  // With legal deductions winning (inss 1000), base R − 1000:
  // base 4664,68: 1049,55 − 651,73 = 397,82;
  // base 4664,69: 1282,78 − 884,96 = 397,82 — the published deducts join cleanly.
  const bruto = (r: string): string =>
    calculateBrIrrfFromTables(
      {
        bands: BR_2024_IRRF_JAN.bands,
        simplificado: BR_2024_IRRF_JAN.simplificado,
        dependente: BR_2024_DEPENDENTE,
        tag: "BR 2024 IRRF (jan)",
      },
      { rendimentos: r, inss: "1000.00", dependentes: 0, pensaoMensal: "0.00" },
    ).impostoBruto;
  assert.equal(bruto("5664.68"), "397.82");
  assert.equal(bruto("5664.69"), "397.82");
});

test("IRRF February–December 2024 prices the Lei 14.848 table", () => {
  // R$ 3.000 simplificado: base 3000 − 564,80 = 2435,20;
  // 2435,20 × 7,5% = 182,64 − 169,44 = 13,20. No reduction in 2024.
  const result = irrfFeb("3000.00");
  assert.equal(result.deducaoVia, "simplificado");
  assert.equal(result.deducaoAplicada, "564.80");
  assert.equal(result.baseCalculo, "2435.20");
  assert.equal(result.impostoBruto, "13.20");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "13.20");
});

test("IRRF February–December 2024 is continuous at the top joint", () => {
  // Base 4664,68: 1049,55 − 662,77 = 386,78;
  // base 4664,69: 1282,78 − 896,00 = 386,78.
  const bruto = (r: string): string =>
    calculateBrIrrfFromTables(
      {
        bands: BR_2024_IRRF_FEB.bands,
        simplificado: BR_2024_IRRF_FEB.simplificado,
        dependente: BR_2024_DEPENDENTE,
        tag: "BR 2024 IRRF (feb-dec)",
      },
      { rendimentos: r, inss: "1000.00", dependentes: 0, pensaoMensal: "0.00" },
    ).impostoBruto;
  assert.equal(bruto("5664.68"), "386.78");
  assert.equal(bruto("5664.69"), "386.78");
});

test("IRRF 2024 never reduces: R$ 6.000 pays the full table tax", () => {
  // Base 6000 − 564,80 = 5435,20 × 27,5% = 1494,68 − 896,00 = 598,68 —
  // the figure the 2026 reduction would have cut to 394,54 via 179,75.
  const result = irrfFeb("6000.00");
  assert.equal(result.impostoBruto, "598.68");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "598.68");
});

test("2024 pay dates resolve to the edition in force that month", () => {
  // Lei 14.663 item X runs "May 2023–January 2024"; Lei 14.848 item XI runs
  // "a partir do mês de fevereiro" 2024 — the RFB 2024 tabelas page prints
  // both ranges verbatim.
  assert.equal(brTablesForPayDate(2024, "2024-01-01").irrfLabel, BR_2024_IRRF_JAN.label);
  assert.equal(brTablesForPayDate(2024, "2024-01-31").irrfLabel, BR_2024_IRRF_JAN.label);
  assert.equal(brTablesForPayDate(2024, "2024-02-01").irrfLabel, BR_2024_IRRF_FEB.label);
  assert.equal(brTablesForPayDate(2024, "2024-12-31").irrfLabel, BR_2024_IRRF_FEB.label);
  assert.throws(() => brTablesForPayDate(2024, "2023-12-31"), /no transcribed tables for pay date/);
  assert.throws(() => brTablesForPayDate(2024, "2025-01-01"), /no transcribed tables for pay date/);
  assert.throws(() => brTablesForPayDate(2024, "15/01/2024"), /not an ISO date/);
});
