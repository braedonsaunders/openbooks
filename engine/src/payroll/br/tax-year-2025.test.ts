/**
 * BR 2025 goldens and sweeps: the pure INSS + IRRF calculators over the
 * 2025 tables, plus the within-year edition selector.
 *
 * Every figure below is hand-worked from the transcribed instruments:
 * - INSS: Portaria Interministerial MPS/MF nº 6, de 10/1/2025, ANEXO II
 *   (faixa a faixa, per-slice truncation to cents);
 * - IRRF January–April: Lei 14.848/2024, art. 1º, item XI (same table as
 *   Feb–Dec 2024);
 * - IRRF May–December: Lei 15.191/2025, art. 2º, item XII (conversion of
 *   MP 1.294/2025);
 * - deductions: R$ 189,59 per dependent, simplified 25% of the zero band
 *   (RFB official 2025 tabelas page: 564,80 Jan–Apr / 607,20 from May).
 * No art. 3º-A reduction existed before Lei 15.270/2025 (effects 1/1/2026),
 * so every 2025 golden asserts reducao "0.00".
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateBrInssFromTables } from "./inss-year.ts";
import { calculateBrIrrfFromTables } from "./irrf-year.ts";
import {
  BR_2025_DEPENDENTE,
  BR_2025_INSS_BRACKETS,
  BR_2025_INSS_TETO,
  BR_2025_IRRF_EARLY,
  BR_2025_IRRF_LATE,
} from "./tax-year-2025.ts";
import { brTablesForPayDate } from "./year-tables.ts";

const inss = (salario: string): string =>
  calculateBrInssFromTables(
    { brackets: BR_2025_INSS_BRACKETS, teto: BR_2025_INSS_TETO, tag: "BR 2025 INSS" },
    { salarioContribuicao: salario },
  ).contribuicao;

/** IRRF through one named 2025 monthly edition (simplified arm, no INSS). */
const irrfEarly = (rendimentos: string) =>
  calculateBrIrrfFromTables(
    {
      bands: BR_2025_IRRF_EARLY.bands,
      simplificado: BR_2025_IRRF_EARLY.simplificado,
      dependente: BR_2025_DEPENDENTE,
      tag: "BR 2025 IRRF (jan-apr)",
    },
    { rendimentos, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  );

const irrfLate = (rendimentos: string) =>
  calculateBrIrrfFromTables(
    {
      bands: BR_2025_IRRF_LATE.bands,
      simplificado: BR_2025_IRRF_LATE.simplificado,
      dependente: BR_2025_DEPENDENTE,
      tag: "BR 2025 IRRF (may-dec)",
    },
    { rendimentos, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" },
  );

test("INSS 2025 sweeps every bracket edge and the teto", () => {
  // Hand-worked, slice by slice, truncated:
  // 1518,00 × 7,5% = 113,85 exact.
  assert.equal(inss("1518.00"), "113.85");
  // One centavo into the 9% slice prices nothing extra (0,01 × 9% truncates).
  assert.equal(inss("1518.01"), "113.85");
  // 1275,88 × 9% = 114,8292 → 114,82; total 228,67.
  assert.equal(inss("2793.88"), "228.67");
  assert.equal(inss("2793.89"), "228.67");
  // 1396,95 × 12% = 167,634 → 167,63; total 396,30.
  assert.equal(inss("4190.83"), "396.30");
  assert.equal(inss("4190.84"), "396.30");
  // 3966,58 × 14% = 555,3212 → 555,32; teto total 951,62.
  assert.equal(inss("8157.41"), "951.62");
  // Above the teto prices nothing more.
  assert.equal(inss("8157.42"), "951.62");
  assert.equal(inss("20000.00"), "951.62");
});

test("INSS 2025 is sliced progressively, never flat-rated at the top rate", () => {
  // The classic error: 3.000,00 × 12% = 360,00. The sliced truth:
  // 113,85 + 114,82 + (206,12 × 12% = 24,7344 → 24,73) = 253,40.
  const result = calculateBrInssFromTables(
    { brackets: BR_2025_INSS_BRACKETS, teto: BR_2025_INSS_TETO, tag: "BR 2025 INSS" },
    { salarioContribuicao: "3000.00" },
  );
  assert.equal(result.contribuicao, "253.40");
  assert.deepEqual(result.fatias, ["113.85", "114.82", "24.73"]);
  assert.notEqual(result.contribuicao, "360.00");
});

test("IRRF January–April 2025 prices the Lei 14.848 table", () => {
  // R$ 3.000 simplificado: base 3000 − 564,80 = 2435,20;
  // 2435,20 × 7,5% = 182,64 − 169,44 = 13,20. No reduction in 2025.
  const result = irrfEarly("3000.00");
  assert.equal(result.deducaoVia, "simplificado");
  assert.equal(result.deducaoAplicada, "564.80");
  assert.equal(result.baseCalculo, "2435.20");
  assert.equal(result.impostoBruto, "13.20");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "13.20");
});

test("IRRF May–December 2025 prices the Lei 15.191 table", () => {
  // R$ 3.000 simplificado: base 3000 − 607,20 = 2392,80;
  // 2392,80 × 7,5% = 179,46 − 182,16 < 0 → 0,00. The May widening zeroes
  // the very input April taxed at 13,20 — the editions are genuinely distinct.
  const result = irrfLate("3000.00");
  assert.equal(result.deducaoVia, "simplificado");
  assert.equal(result.deducaoAplicada, "607.20");
  assert.equal(result.baseCalculo, "2392.80");
  assert.equal(result.impostoBruto, "0.00");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "0.00");
});

test("IRRF May–December 2025 is continuous at the top joint", () => {
  // With legal deductions winning (inss 1000), base R − 1000:
  // base 4664,68: 1049,55 − 675,49 = 374,06;
  // base 4664,69: 1282,78 − 908,73 = 374,05 — one centavo BELOW its
  // neighbour, the same published-908,73 trace the 2026 module documents.
  // Transcribed, not smoothed.
  const bruto = (r: string): string =>
    calculateBrIrrfFromTables(
      {
        bands: BR_2025_IRRF_LATE.bands,
        simplificado: BR_2025_IRRF_LATE.simplificado,
        dependente: BR_2025_DEPENDENTE,
        tag: "BR 2025 IRRF (may-dec)",
      },
      { rendimentos: r, inss: "1000.00", dependentes: 0, pensaoMensal: "0.00" },
    ).impostoBruto;
  assert.equal(bruto("5664.68"), "374.06");
  assert.equal(bruto("5664.69"), "374.05");
});

test("IRRF 2025 never reduces: R$ 6.000 pays the full table tax", () => {
  // Base 6000 − 607,20 = 5392,80 × 27,5% = 1483,02 − 908,73 = 574,29 —
  // the bruto the 2026 reduction cuts to 394,54 via 179,75. In 2025 the
  // whole 574,29 is withheld.
  const result = irrfLate("6000.00");
  assert.equal(result.baseCalculo, "5392.80");
  assert.equal(result.impostoBruto, "574.29");
  assert.equal(result.reducao, "0.00");
  assert.equal(result.irrf, "574.29");
});

test("2025 pay dates resolve to the edition in force that month", () => {
  // Lei 14.848 item XI runs "February 2024–April 2025"; Lei 15.191 item XII
  // runs "a partir do mês de maio" 2025 — the RFB 2025 tabelas page prints
  // both ranges ("De janeiro a abril de 2025" / "A partir de maio de 2025").
  assert.equal(brTablesForPayDate(2025, "2025-01-01").irrfLabel, BR_2025_IRRF_EARLY.label);
  assert.equal(brTablesForPayDate(2025, "2025-04-30").irrfLabel, BR_2025_IRRF_EARLY.label);
  assert.equal(brTablesForPayDate(2025, "2025-05-01").irrfLabel, BR_2025_IRRF_LATE.label);
  assert.equal(brTablesForPayDate(2025, "2025-12-31").irrfLabel, BR_2025_IRRF_LATE.label);
  assert.throws(() => brTablesForPayDate(2025, "2024-12-31"), /no transcribed tables for pay date/);
  assert.throws(() => brTablesForPayDate(2025, "2026-01-01"), /no transcribed tables for pay date/);
});
