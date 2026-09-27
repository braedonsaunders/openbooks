/**
 * BR conformance goldens, 2024–2026: the pure INSS + IRRF calculators and
 * full monthly payslips through the adapter push path.
 *
 * Every figure is hand-worked from the transcribed instruments with
 * per-slice/per-amount truncation to cents (the eSocial rule), never engine
 * output. INSS prices "faixa a faixa" from the January portaria. IRRF uses
 * the monthly table in force for the pay month, R$ 189,59 per dependent and
 * the simplified 25% of the zero band (528,00 Jan 2024; 564,80 Feb 2024–Apr
 * 2025; 607,20 from May 2025). The art. 3º-A reduction exists only from
 * 1/1/2026 (Lei 15.270/2025), so every pre-2026 row asserts reducao zero.
 *
 * Payslip rows run `computeBrStatutoryWithRates` through the real
 * `createPushStatutory` (country "BR" against the registered pack), so an
 * undeclared systemKey throws exactly as in a live run; only the component
 * row lookup is stubbed, because unit tests have no database.
 *
 * The same R$ 6.000 / R$ 3.000 inputs appear in every year with different
 * figures, so a year silently falling through to another's tables fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeBrStatutoryWithRates, type BrEmployerRates } from "./compute-statutory.ts";
import { calculateBrInssFromTables } from "./inss-year.ts";
import { calculateBrIrrfFromTables } from "./irrf-year.ts";
import { BR_2024_IRRF_FEB, BR_2024_IRRF_JAN } from "./tax-year-2024.ts";
import { BR_2025_IRRF_EARLY, BR_2025_IRRF_LATE } from "./tax-year-2025.ts";
import { brTablesForPayDate } from "./year-tables.ts";
import type { PayrollStatutoryComputeContext, StubLine } from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

type Year = 2024 | 2025 | 2026;
type Input =
  | { salario: string }
  | { rendimentos: string; inss?: string; dependentes?: number; pensaoMensal?: string; payDate?: string }
  | { payslip: string; payDate: string; rates?: Partial<BrEmployerRates> };
interface Golden { year: Year; label: string; input: Input; expected: Record<string, unknown>; citation: string }

const INSS_CITE: Record<Year, string> = {
  2024: "Portaria Interministerial MPS/MF nº 2/2024, Anexo II",
  2025: "Portaria Interministerial MPS/MF nº 6/2025, Anexo II",
  2026: "Portaria Interministerial MPS/MF nº 13/2026, Anexo I",
};
const L14663 = "Lei 14.663/2023, art. 5º, X (January 2024)";
const L14848 = "Lei 14.848/2024, art. 1º, XI";
const L15191 = "Lei 15.191/2025, art. 2º, XII";
const IRRF_2026 = "Lei 11.482/2007 art. 1º, XII (MP 1.294/2025) + Lei 15.270/2025 art. 3º-A";
const RECEITA = "Receita Federal official 2026 example";
const PAYSLIP = "INSS + IRRF as above; Lei 8.212/1991 art. 22 (patronal 20%, RAT × FAP); terceiros; Lei 8.036/1990 art. 15 (FGTS 8%)";
const RATES: BrEmployerRates = { ratPct: "2", fap: "1", terceirosPct: "5.8", regimeTributario: "geral" };

const irrfResult = (deducaoVia: string, deducaoAplicada: string, baseCalculo: string, impostoBruto: string, reducao: string, irrf: string) =>
  ({ deducaoVia, deducaoAplicada, baseCalculo, impostoBruto, reducao, irrf });

/** INSS bracket-edge sweep: one row per salário-de-contribuição. */
const inssSweep = (year: Year, points: ReadonlyArray<readonly [string, string]>): Golden[] =>
  points.map(([salario, contribuicao]) => ({
    year, label: `INSS edge R$ ${salario}`, input: { salario }, expected: { contribuicao }, citation: INSS_CITE[year],
  }));

/** Top IRRF band joint with legal deductions winning (inss 1000): base R − 1000. */
const joint = (year: Year, payDate: string, citation: string, below: string, above: string): Golden[] =>
  ([["5664.68", below], ["5664.69", above]] as const).map(([rendimentos, impostoBruto]) => ({
    year, label: `IRRF top joint R$ ${rendimentos}`, input: { rendimentos, inss: "1000.00", payDate }, expected: { impostoBruto }, citation,
  }));

const GOLDENS: Golden[] = [
  // INSS: one centavo into a slice prices nothing extra; above the teto nothing more.
  ...inssSweep(2024, [["1412.00", "105.90"], ["1412.01", "105.90"], ["2666.68", "218.82"], ["2666.69", "218.82"],
    ["4000.03", "378.82"], ["4000.04", "378.82"], ["7786.02", "908.85"], ["7786.03", "908.85"], ["20000.00", "908.85"]]),
  ...inssSweep(2025, [["1518.00", "113.85"], ["1518.01", "113.85"], ["2793.88", "228.67"], ["2793.89", "228.67"],
    ["4190.83", "396.30"], ["4190.84", "396.30"], ["8157.41", "951.62"], ["8157.42", "951.62"], ["20000.00", "951.62"]]),
  ...inssSweep(2026, [["1621.00", "121.57"], ["1621.01", "121.57"], ["2902.84", "236.93"], ["2902.85", "236.93"],
    ["4354.27", "411.10"], ["4354.28", "411.10"], ["8475.55", "988.07"], ["8475.56", "988.07"]]),
  { year: 2026, label: "INSS R$ 20.000 caps at the teto", input: { salario: "20000.00" }, expected: { contribuicao: "988.07", baseTributavel: "8475.55" }, citation: INSS_CITE[2026] },
  // Sliced progressively, never 3.000,00 × 12% = 360,00. 2026 also pins
  // truncation: exact-then-round would give 248,60.
  { year: 2024, label: "INSS R$ 3.000 sliced progressively", input: { salario: "3000.00" }, expected: { contribuicao: "258.81", fatias: ["105.90", "112.92", "39.99"] }, citation: INSS_CITE[2024] },
  { year: 2025, label: "INSS R$ 3.000 sliced progressively", input: { salario: "3000.00" }, expected: { contribuicao: "253.40", fatias: ["113.85", "114.82", "24.73"] }, citation: INSS_CITE[2025] },
  { year: 2026, label: "INSS R$ 3.000 sliced progressively", input: { salario: "3000.00" }, expected: { contribuicao: "248.58", fatias: ["121.57", "115.36", "11.65"] }, citation: INSS_CITE[2026] },

  // IRRF 2024. January: 2472,00 × 7,5% = 185,40 − 158,40 = 27,00.
  { year: 2024, label: "IRRF January R$ 3.000 simplificado", input: { rendimentos: "3000.00", payDate: "2024-01-15" }, expected: irrfResult("simplificado", "528.00", "2472.00", "27.00", "0.00", "27.00"), citation: L14663 },
  ...joint(2024, "2024-01-15", L14663, "397.82", "397.82"),
  // February–December: 2435,20 × 7,5% = 182,64 − 169,44 = 13,20.
  { year: 2024, label: "IRRF Feb–Dec R$ 3.000 simplificado", input: { rendimentos: "3000.00", payDate: "2024-06-15" }, expected: irrfResult("simplificado", "564.80", "2435.20", "13.20", "0.00", "13.20"), citation: L14848 },
  ...joint(2024, "2024-06-15", L14848, "386.78", "386.78"),
  { year: 2024, label: "IRRF R$ 6.000 never reduces", input: { rendimentos: "6000.00", payDate: "2024-06-15" }, expected: { impostoBruto: "598.68", reducao: "0.00", irrf: "598.68" }, citation: L14848 },

  // IRRF 2025: the same R$ 3.000 either side of 1 May (Jan–Apr is the Lei 14.848 table).
  { year: 2025, label: "IRRF 30 April R$ 3.000 simplificado", input: { rendimentos: "3000.00", payDate: "2025-04-30" }, expected: irrfResult("simplificado", "564.80", "2435.20", "13.20", "0.00", "13.20"), citation: L14848 },
  // 2392,80 × 7,5% = 179,46 − 182,16 < 0: the May widening zeroes what April taxed.
  { year: 2025, label: "IRRF 1 May R$ 3.000 simplificado", input: { rendimentos: "3000.00", payDate: "2025-05-01" }, expected: irrfResult("simplificado", "607.20", "2392.80", "0.00", "0.00", "0.00"), citation: L15191 },
  // 374,05 sits one centavo BELOW its neighbour: the published 908,73 deduct, transcribed not smoothed.
  ...joint(2025, "2025-06-15", L15191, "374.06", "374.05"),
  { year: 2025, label: "IRRF R$ 6.000 never reduces", input: { rendimentos: "6000.00", payDate: "2025-06-15" }, expected: { baseCalculo: "5392.80", impostoBruto: "574.29", reducao: "0.00", irrf: "574.29" }, citation: L15191 },

  // IRRF 2026 band edges (inss 1000 > 607,20, so base = R − 1000); 3751,05/3751,06 price the same centavo.
  ...([["3826.65", "29.83"], ["4751.05", "168.49"], ["4751.06", "168.49"], ["5664.68", "374.06"], ["5664.69", "374.05"]] as const)
    .map(([rendimentos, impostoBruto]): Golden => ({
      year: 2026, label: `IRRF band edge R$ ${rendimentos}`, input: { rendimentos, inss: "1000.00" }, expected: { impostoBruto }, citation: IRRF_2026,
    })),
  { year: 2026, label: "IRRF Maria R$ 5.000 simplified zeroes exactly", input: { rendimentos: "5000.00" }, expected: irrfResult("simplificado", "607.20", "4392.80", "312.89", "312.89", "0.00"), citation: `${RECEITA} (Maria)` },
  // Redutor 978,62 − 0,133145 × 6000 = 179,75.
  { year: 2026, label: "IRRF R$ 6.000 bruto 574,29, redutor 179,75, final 394,54", input: { rendimentos: "6000.00" }, expected: { baseCalculo: "5392.80", impostoBruto: "574.29", reducao: "179.75", irrf: "394.54" }, citation: `${RECEITA} (R$ 6.000)` },
  { year: 2026, label: "IRRF R$ 4.800 fully absorbed, floored at zero", input: { rendimentos: "4800.00" }, expected: { impostoBruto: "267.89", reducao: "267.89", irrf: "0.00" }, citation: IRRF_2026 },
  { year: 2026, label: "IRRF legal deductions beat the simplified", input: { rendimentos: "6000.00", inss: "641.50" }, expected: irrfResult("legal", "641.50", "5358.50", "564.85", "179.75", "385.10"), citation: IRRF_2026 },
  { year: 2026, label: "IRRF dependents and pensão join the legal arm", input: { rendimentos: "6000.00", inss: "500.00", dependentes: 1, pensaoMensal: "200.00" }, expected: { deducaoVia: "legal", deducaoAplicada: "889.59", baseCalculo: "5110.41", impostoBruto: "496.63", irrf: "316.88" }, citation: IRRF_2026 },
  // 5000,01: the formula gives 312,90 but the tax caps it. 7350,00: the formula
  // leaves 0,01 (978,62 − 978,61); one centavo later the reduction is gone.
  ...([["5000.01", "0.00"], ["7350.00", "945.53"], ["7350.01", "945.54"], ["8000.00", "1124.29"]] as const)
    .map(([rendimentos, irrf]): Golden => ({
      year: 2026, label: `IRRF transition joint R$ ${rendimentos}`, input: { rendimentos }, expected: { irrf }, citation: IRRF_2026,
    })),

  // Payslips. 2026 R$ 6.000: INSS 641,50 > 607,20 so the legal arm wins.
  {
    year: 2026, label: "payslip R$ 6.000 pushes IRRF + INSS + all four employer lines", input: { payslip: "6000.00", payDate: "2026-03-15" },
    expected: {
      BR_INSS: "641.5000", BR_DEDUCAO_VIA: "legal", BR_BASE_IRRF: "5358.5000", BR_IMPOSTO_BRUTO: "564.8500", BR_REDUCAO: "179.7500", BR_IRRF: "385.1000",
      BR_PATRONAL: "1200.0000", BR_RAT: "120.0000", BR_TERCEIROS: "348.0000", BR_FGTS: "480.0000",
      // IRRF moves with pre-tax deductions; everything else is rate × base. FGTS is never a deduction.
      lines: [
        ["irrf:deduction", "deduction", "IRRF", "385.1000", 110, "taxable_income"],
        ["inss:deduction", "deduction", "INSS (segurado)", "641.5000", 120, "earnings"],
        ["inss_patronal:employer_contribution", "employer_contribution", "INSS patronal (20%)", "1200.0000", 210, "earnings"],
        ["inss_rat:employer_contribution", "employer_contribution", "RAT × FAP", "120.0000", 211, "earnings"],
        ["inss_terceiros:employer_contribution", "employer_contribution", "Terceiros", "348.0000", 212, "earnings"],
        ["fgts:employer_contribution", "employer_contribution", "FGTS (8%)", "480.0000", 220, "earnings"],
      ],
    },
    citation: PAYSLIP,
  },
  // A zeroed IRRF pushes NO line: five lines, the irrf key absent rather than zero-valued.
  {
    year: 2026, label: "payslip R$ 5.000 Maria: IRRF zeroes, INSS and employer cost remain", input: { payslip: "5000.00", payDate: "2026-03-15" },
    expected: {
      BR_INSS: "501.5000", BR_IRRF: "0.0000", BR_REDUCAO: "312.8900", BR_PATRONAL: "1000.0000", BR_RAT: "100.0000", BR_TERCEIROS: "290.0000", BR_FGTS: "400.0000",
      componentIds: ["fgts:employer_contribution", "inss:deduction", "inss_patronal:employer_contribution", "inss_rat:employer_contribution", "inss_terceiros:employer_contribution"],
    },
    citation: `${RECEITA} (Maria); ${PAYSLIP}`,
  },
  // INSS 105,90 + 112,92 + 160,00 + (1999,97 × 14% = 279,99) = 658,81; base 5341,19 × 27,5% = 1468,82 − 896,00.
  { year: 2024, label: "payslip R$ 6.000 prices through the 2024 tables", input: { payslip: "6000.00", payDate: "2024-06-15" }, expected: { BR_INSS: "658.8100", BR_IRRF: "572.8200", BR_REDUCAO: "0.0000" }, citation: `${INSS_CITE[2024]}; ${L14848}` },
  // INSS 113,85 + 114,82 + 167,63 + (1809,17 × 14% = 253,28) = 649,58; base 5350,42 × 27,5% = 1471,36 − 908,73.
  { year: 2025, label: "payslip R$ 6.000 prices through the 2025 tables", input: { payslip: "6000.00", payDate: "2025-06-15" }, expected: { BR_INSS: "649.5800", BR_IRRF: "562.6300", BR_REDUCAO: "0.0000" }, citation: `${INSS_CITE[2025]}; ${L15191}` },
];

interface Refusal { year: Year; label: string; input: Input; refusal: RegExp }
const REFUSALS: Refusal[] = [
  { year: 2026, label: "undeclared RAT rate", input: { payslip: "6000.00", payDate: "2026-03-15", rates: { ratPct: null } }, refusal: /br_rat/ },
  { year: 2026, label: "undeclared FAP", input: { payslip: "6000.00", payDate: "2026-03-15", rates: { fap: null } }, refusal: /br_fap/ },
  { year: 2026, label: "undeclared terceiros rate", input: { payslip: "6000.00", payDate: "2026-03-15", rates: { terceirosPct: null } }, refusal: /br_terceiros/ },
  { year: 2024, label: "pay date before 2024", input: { rendimentos: "3000.00", payDate: "2023-12-31" }, refusal: /no transcribed tables for pay date/ },
  { year: 2024, label: "pay date after 2024", input: { rendimentos: "3000.00", payDate: "2025-01-01" }, refusal: /no transcribed tables for pay date/ },
  { year: 2024, label: "non-ISO pay date", input: { rendimentos: "3000.00", payDate: "15/01/2024" }, refusal: /not an ISO date/ },
  { year: 2025, label: "pay date before 2025", input: { rendimentos: "3000.00", payDate: "2024-12-31" }, refusal: /no transcribed tables for pay date/ },
  { year: 2025, label: "pay date after 2025", input: { rendimentos: "3000.00", payDate: "2026-01-01" }, refusal: /no transcribed tables for pay date/ },
  { year: 2026, label: "negative dependentes", input: { rendimentos: "5000.00", dependentes: -1 }, refusal: /dependentes as a non-negative integer/ },
  { year: 2026, label: "fractional dependentes", input: { rendimentos: "5000.00", dependentes: 1.5 }, refusal: /dependentes as a non-negative integer/ },
  { year: 2026, label: "non-numeric rendimentos", input: { rendimentos: "abc" }, refusal: /rendimentos as a non-negative decimal amount/ },
];

async function price(year: Year, input: Input): Promise<object> {
  if ("salario" in input) {
    const i = { salarioContribuicao: input.salario };
    return calculateBrInssFromTables(brTablesForPayDate(year, `${year}-01-01`).inss, i);
  }
  if ("rendimentos" in input) {
    const { payDate, ...rest } = input;
    const i = { inss: "0.00", dependentes: 0, pensaoMensal: "0.00", ...rest };
    return calculateBrIrrfFromTables(brTablesForPayDate(year, payDate ?? `${year}-01-01`).irrf, i);
  }
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "BR",
    lines,
    emittedEarningsAssessed: new Set<string>(),
    // The component row is a stub (no database); the statutoryAssessment
    // consult inside createPushStatutory is real.
    need: (systemKey: string, kind: string): Record<string, unknown> => ({ id: `${systemKey}:${kind}` }),
  });
  const ctx = {
    taxYear: year, region: "BR", run: { pay_date: input.payDate }, emp: { br_dependentes: "0" },
    income: input.payslip, nonPeriodic: "", pensionable: input.payslip, insurable: input.payslip,
    periodsPerYear: 12, filingAccountId: null, pushStatutory, certificateFor: () => null, assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  const result = await computeBrStatutoryWithRates(ctx, { ...RATES, ...input.rates });
  return {
    ...result,
    lines: lines.map((l) => [l.componentId, l.kind, l.description, l.amount, l.sequence, l.assessedOn]),
    componentIds: lines.map((l) => l.componentId).sort(),
  };
}

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, async () => {
    const actual = (await price(row.year, row.input)) as Record<string, unknown>;
    for (const [key, want] of Object.entries(row.expected)) {
      assert.deepEqual(actual[key], want, `${row.year} ${row.label} (${row.citation}): ${key}`);
    }
  });
}

for (const row of REFUSALS) {
  test(`${row.year} refuses: ${row.label}`, async () => {
    await assert.rejects(async () => price(row.year, row.input), row.refusal, `${row.year} ${row.label}`);
  });
}

test("prior-year pay dates resolve to the IRRF edition in force that month", () => {
  // Lei 14.848 runs from February 2024; Lei 15.191 from May 2025 (RFB tabelas pages print both ranges).
  for (const [year, payDate, edition] of [
    [2024, "2024-01-01", BR_2024_IRRF_JAN], [2024, "2024-01-31", BR_2024_IRRF_JAN], [2024, "2024-02-01", BR_2024_IRRF_FEB],
    [2024, "2024-12-31", BR_2024_IRRF_FEB], [2025, "2025-01-01", BR_2025_IRRF_EARLY], [2025, "2025-04-30", BR_2025_IRRF_EARLY],
    [2025, "2025-05-01", BR_2025_IRRF_LATE], [2025, "2025-12-31", BR_2025_IRRF_LATE],
  ] as const) {
    assert.equal(brTablesForPayDate(year, payDate).irrfLabel, edition.label, payDate);
  }
});

test("2026 INSS and IRRF are monotone in pay, flat past the teto and never negative", () => {
  const cents = (amount: string): bigint => BigInt(amount.replace(".", ""));
  const tables = brTablesForPayDate(2026, "2026-01-01");
  const salaries = ["0.00", "1000.00", "1621.00", "2500.00", "4354.27", "6000.00", "8475.55", "8475.56", "30000.00"];
  const inss = salaries.map((s) => cents(calculateBrInssFromTables(tables.inss, { salarioContribuicao: s }).contribuicao));
  const pays = ["0.00", "1000.00", "3000.00", "5000.00", "5500.00", "6000.00", "7350.00", "20000.00"];
  const irrf = pays.map((r) => cents(calculateBrIrrfFromTables(tables.irrf, { rendimentos: r, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" }).irrf));
  for (let i = 1; i < inss.length; i++) assert.ok(inss[i]! >= inss[i - 1]!, `INSS ${salaries[i]} prices below ${salaries[i - 1]}`);
  for (let i = 1; i < irrf.length; i++) assert.ok(irrf[i]! >= irrf[i - 1]!, `IRRF ${pays[i]} withholds below ${pays[i - 1]}`);
  assert.ok(inss[5]! > inss[4]!, "INSS still rising below the teto");
  assert.equal(inss[7], inss[6], "INSS flat past the teto");
  for (const amount of irrf) assert.ok(amount >= 0n, "negative withholding");
});
