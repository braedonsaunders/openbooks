/**
 * PL goldens: the transcribed 2024, 2025 and 2026 tables price a monthly
 * PIT-2-filed employment payslip (ZUS/NFZ lines, then the PIT advance), and
 * the adapter pushes the same payslip through the real declaration consult.
 *
 * Every figure is hand-priced from the operative sentences quoted in the
 * year's ./tables-YYYY.ts — never from running the engine. PIT rows price
 * with KUP miejscowy (250 zł) and the 1/12 reduction (300 zł) on the row's
 * own brut, pay date and ZUS employee total.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePlPit2024,
  calculatePlPit2025,
  calculatePlPit2026,
  calculatePlZus2024,
  calculatePlZus2025,
  calculatePlZus2026,
  computePlStatutory,
  type PlPitCalcInput,
  type PlPitCalcResult,
  type PlZusCalcInput,
  type PlZusCalcResult,
} from "./compute-statutory.ts";
import type { PayrollStatutoryComputeContext, StubLine } from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

type Year = 2024 | 2025 | 2026;
// Each year's own entry point: 2026 runs the landed pay-date gate first.
const CALC = {
  2024: { zus: calculatePlZus2024, pit: calculatePlPit2024 },
  2025: { zus: calculatePlZus2025, pit: calculatePlPit2025 },
  2026: { zus: calculatePlZus2026, pit: calculatePlPit2026 },
} as const;

const PIT_2024 = "PIT art. 27 / 31b / 22 ust. 2 pkt 1 (Dz.U. 2024 poz. 226)";
const PIT_2025_26 = "PIT art. 27 / 31b / 22 ust. 2 pkt 1 (Dz.U. 2025 poz. 163)";
const ZUS_2024 = `ZUS art. 16 / 22; zdrowotna art. 79; funds Dz.U. 2024 poz. 122; ${PIT_2024}`;
const ZUS_2025 = `ZUS art. 16 / 22; zdrowotna art. 79; funds Dz.U. 2025 poz. 63; ${PIT_2025_26}`;
const ZUS_2026 = `ZUS Dz.U. 2026 poz. 199; zdrowotna art. 79; funds Dz.U. 2026 poz. 62; ${PIT_2025_26}`;

interface Golden {
  year: Year;
  label: string;
  citation: string;
  input: Omit<PlZusCalcInput, "periodsPerYear">;
  expectedZus: Partial<PlZusCalcResult>;
  /** Present when the row also prices the PIT advance from the row's zusEe. */
  expectedPit?: Partial<PlPitCalcResult>;
}

// The 8 000 zł June payslip is frozen across the transcribed years: no cap
// binds (6 × 8 000 = 48 000); 8 000 × 9,76 % = 780,80; zdrowotna
// (8 000 − 1 096,80) × 9 % = 621,288 → 621,29; dochód 6 653; 6 653 × 12 % − 300 → 498.
const JUNE_8000_ZUS: Partial<PlZusCalcResult> = {
  podstawaSpoleczne: "8000.0000", emerytEe: "780.8000", emerytEr: "780.8000",
  rentEe: "120.0000", rentEr: "520.0000", chorEe: "196.0000", zusEe: "1096.8000",
  podstawaZdrowotna: "6903.2000", zdrowotna: "621.2900", fpNalezne: true,
  fpZwolnioneWiek: false, fp: "80.0000", fs: "116.0000", fgsp: "8.0000", wypadkoweEr: "0.0000",
};
const JUNE_8000_PIT: Partial<PlPitCalcResult> = {
  kup: "250.0000", dochod: "6653.0000", podstawa12: "6653.0000", podstawa32: "0.0000",
  pomniejszenieKwota: "300.0000", zaliczka: "498.0000",
};
const SENIOR: Partial<PlZusCalcResult> = {
  fpNalezne: false, fpZwolnioneWiek: true, fp: "0.0000", fs: "0.0000", fgsp: "0.0000",
};
const june = (year: Year, extra: Partial<PlZusCalcInput> = {}) =>
  ({ brut: "8000.00", payDate: `${year}-06-15`, rokUrodzenia: 1990, ...extra });

const GOLDENS: readonly Golden[] = [
  // ── 2026 ──
  { year: 2026, label: "standard June payslip: 8 000 zł prices every line (4 806 zł threshold cleared, age 36)",
    citation: `M.P. 2025 poz. 1206 limit; Dz.U. 2025 poz. 1242 minimum wage; ${ZUS_2026}`,
    input: june(2026), expectedZus: JUNE_8000_ZUS, expectedPit: JUNE_8000_PIT },
  { year: 2026, label: "December sweep: the 282 600 zł room binds emerytalne/rentowe only",
    citation: `M.P. 2025 poz. 1206 limit (282 600 zł); ${ZUS_2026}`,
    // Prior 11 × 25 000 = 275 000 → room 7 600; zdrowotna uncapped;
    // dochód 25 000 − 1 468,26 − 250 → 23 282, all at 32 %: 7 450,24 − 300 → 7 150.
    input: { brut: "25000.00", payDate: "2026-12-15", rokUrodzenia: 1985 },
    expectedZus: {
      podstawaSpoleczne: "7600.0000", emerytEe: "741.7600", emerytEr: "741.7600", rentEe: "114.0000",
      rentEr: "494.0000", chorEe: "612.5000", zusEe: "1468.2600", podstawaZdrowotna: "23531.7400",
      zdrowotna: "2117.8600",
    },
    expectedPit: { dochod: "23282.0000", podstawa12: "0.0000", podstawa32: "23282.0000", zaliczka: "7150.0000" } },
  { year: 2026, label: "June crossing month splits the PIT base at 120 000 zł",
    citation: ZUS_2026,
    // Dochód 25 000 − 3 427,50 − 250 = 21 322,50 → 21 323; prior 5 × 21 323 = 106 615:
    // 13 385 at 12 % + 7 938 at 32 % − 300 = 3 846,36 → 3 846.
    input: { brut: "25000.00", payDate: "2026-06-15", rokUrodzenia: 1985 },
    expectedZus: { podstawaSpoleczne: "25000.0000", zusEe: "3427.5000", zdrowotna: "1941.5300" },
    expectedPit: { dochod: "21323.0000", podstawa12: "13385.0000", podstawa32: "7938.0000", zaliczka: "3846.0000" } },
  { year: 2026, label: "4 000 zł clears no FP/FS threshold; FGŚP still priced",
    citation: "Dz.U. 2025 poz. 1242 minimum wage; Dz.U. 2025 poz. 620 art. 259 ust. 1",
    input: { brut: "4000.00", payDate: "2026-06-15", rokUrodzenia: 1990, wymiarEtatu: "1" },
    expectedZus: { fpNalezne: false, fpZwolnioneWiek: false, fp: "0.0000", fs: "0.0000", fgsp: "4.0000" } },
  { year: 2026, label: "born 1960: FP/FS and FGŚP age-barred to zero",
    citation: "labour-market art. 261; claims-protection art. 9b ust. 2 (Dz.U. 2026 poz. 186)",
    input: june(2026, { rokUrodzenia: 1960 }), expectedZus: SENIOR },
  { year: 2026, label: "declared 1,67 % wypadkowe prices the full revenue: 133,60",
    citation: "ZUS-notified wypadkowe rate on the full przychód",
    input: june(2026, { wypadkowePct: "1.67" }), expectedZus: { wypadkoweEr: "133.6000" } },

  // ── 2025 ──
  { year: 2025, label: "standard June payslip: 8 000 zł prices every line (4 666 zł threshold cleared, age 35)",
    citation: `M.P. 2024 poz. 1051 limit; Dz.U. 2024 poz. 1362 minimum wage; ${ZUS_2025}`,
    input: june(2025), expectedZus: JUNE_8000_ZUS, expectedPit: JUNE_8000_PIT },
  { year: 2025, label: "December sweep: prior 275 000 zł exhausts the 260 190 zł room",
    citation: `M.P. 2024 poz. 1051 limit (260 190 zł); ${ZUS_2025}`,
    // Chorobowe 612,50 on the full 25 000; zdrowotna (25 000 − 612,50) × 9 % = 2 194,875 → 2 194,88;
    // dochód 24 137,50 → 24 138, all at 32 %: 7 724,16 − 300 → 7 424.
    input: { brut: "25000.00", payDate: "2025-12-15", rokUrodzenia: 1985 },
    expectedZus: {
      podstawaSpoleczne: "0.0000", emerytEe: "0.0000", emerytEr: "0.0000", rentEe: "0.0000", rentEr: "0.0000",
      chorEe: "612.5000", zusEe: "612.5000", podstawaZdrowotna: "24387.5000", zdrowotna: "2194.8800",
    },
    expectedPit: { dochod: "24138.0000", podstawa12: "0.0000", podstawa32: "24138.0000", zaliczka: "7424.0000" } },
  { year: 2025, label: "4 250 zł clears no 4 666 zł threshold; FGŚP still priced",
    citation: "Dz.U. 2024 poz. 1362 minimum wage",
    input: { brut: "4250.00", payDate: "2025-06-15", rokUrodzenia: 1990, wymiarEtatu: "1" },
    expectedZus: { fpNalezne: false, fpZwolnioneWiek: false, fp: "0.0000", fs: "0.0000", fgsp: "4.2500" } },
  { year: 2025, label: "born 1960: FP/FS and FGŚP age-barred to zero",
    citation: "art. 104b ust. 2 / art. 261; claims-protection art. 9b ust. 2",
    input: june(2025, { rokUrodzenia: 1960 }), expectedZus: SENIOR },
  { year: 2025, label: "declared 1,67 % wypadkowe prices the full revenue, fraction intact: 133,60",
    citation: "ZUS-notified wypadkowe rate on the full przychód",
    input: june(2025, { wypadkowePct: "1.67" }), expectedZus: { wypadkoweEr: "133.6000" } },

  // ── 2024 ──
  { year: 2024, label: "standard June payslip: 8 000 zł prices every line (4 242 zł threshold cleared, age 34)",
    citation: `M.P. 2023 poz. 1356 limit; Dz.U. 2023 poz. 1893 minimum wage; ${ZUS_2024}`,
    input: june(2024), expectedZus: JUNE_8000_ZUS, expectedPit: JUNE_8000_PIT },
  { year: 2024, label: "December sweep: prior 275 000 zł exhausts the 234 720 zł room",
    citation: `M.P. 2023 poz. 1356 limit (234 720 zł); ${ZUS_2024}`,
    // Same arithmetic as 2025: chorobowe 612,50; zdrowotna 2 194,88; dochód 24 138 → 7 424.
    input: { brut: "25000.00", payDate: "2024-12-15", rokUrodzenia: 1985 },
    expectedZus: {
      podstawaSpoleczne: "0.0000", emerytEe: "0.0000", rentEe: "0.0000", chorEe: "612.5000",
      zusEe: "612.5000", podstawaZdrowotna: "24387.5000", zdrowotna: "2194.8800",
    },
    expectedPit: { dochod: "24138.0000", podstawa12: "0.0000", podstawa32: "24138.0000", zaliczka: "7424.0000" } },
  // The 1 July minimum-wage step (4 242 → 4 300) moves FP/FS for the same pay;
  // social lines and PIT do not move: 4 250 − 582,68 − 250 → 3 417; 410,04 − 300 → 110.
  { year: 2024, label: "February 4 250 zł ≥ 4 242 zł: FP/FS due on the full revenue",
    citation: `Dz.U. 2023 poz. 1893 (first-half minimum wage); ${ZUS_2024}`,
    input: { brut: "4250.00", payDate: "2024-02-15", rokUrodzenia: 1990 },
    expectedZus: { fpNalezne: true, fp: "42.5000", fs: "61.6300", fgsp: "4.2500",
      zusEe: "582.6800", podstawaZdrowotna: "3667.3200", zdrowotna: "330.0600" },
    expectedPit: { dochod: "3417.0000", zaliczka: "110.0000" } },
  { year: 2024, label: "July 4 250 zł < 4 300 zł: the same pay prices no FP/FS; FGŚP stays",
    citation: `Dz.U. 2023 poz. 1893 (second-half minimum wage from 2024-07-01); ${ZUS_2024}`,
    input: { brut: "4250.00", payDate: "2024-07-15", rokUrodzenia: 1990, wymiarEtatu: "1" },
    expectedZus: { fpNalezne: false, fp: "0.0000", fs: "0.0000", fgsp: "4.2500",
      zusEe: "582.6800", podstawaZdrowotna: "3667.3200", zdrowotna: "330.0600" },
    expectedPit: { dochod: "3417.0000", zaliczka: "110.0000" } },
  { year: 2024, label: "January 4 242,00 zł meets the threshold exactly: FS 61,509 → 61,51",
    citation: "Dz.U. 2023 poz. 1893 minimum wage; funds Dz.U. 2024 poz. 122",
    input: { brut: "4242.00", payDate: "2024-01-15", rokUrodzenia: 1990 },
    expectedZus: { fpNalezne: true, fp: "42.4200", fs: "61.5100" } },
  { year: 2024, label: "January 4 241,99 zł, one grosz under: no FP/FS; FGŚP 4,24199 → 4,24",
    citation: "Dz.U. 2023 poz. 1893 minimum wage; funds Dz.U. 2024 poz. 122",
    input: { brut: "4241.99", payDate: "2024-01-15", rokUrodzenia: 1990, wymiarEtatu: "1" },
    expectedZus: { fpNalezne: false, fp: "0.0000", fs: "0.0000", fgsp: "4.2400" } },
  { year: 2024, label: "born 1960: FP/FS and FGŚP age-barred to zero",
    citation: "art. 104b ust. 2; claims-protection art. 9b ust. 2",
    input: june(2024, { rokUrodzenia: 1960 }), expectedZus: SENIOR },
  { year: 2024, label: "declared 1,67 % wypadkowe prices the full revenue, fraction intact: 133,60",
    citation: "ZUS-notified wypadkowe rate on the full przychód",
    input: june(2024, { wypadkowePct: "1.67" }), expectedZus: { wypadkoweEr: "133.6000" } },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const at = `${row.year} ${row.label} [${row.citation}]`;
    const zus = CALC[row.year].zus({ ...row.input, periodsPerYear: 12 });
    for (const [key, want] of Object.entries(row.expectedZus)) {
      assert.equal(zus[key as keyof PlZusCalcResult], want, `${at}: ZUS ${key}`);
    }
    if (!row.expectedPit) return;
    const pit = CALC[row.year].pit({
      brut: row.input.brut, zusEe: zus.zusEe, kup: "miejscowy", pomniejszenie: "1/12",
      payDate: row.input.payDate, periodsPerYear: 12,
    });
    for (const [key, want] of Object.entries(row.expectedPit)) {
      assert.equal(pit[key as keyof PlPitCalcResult], want, `${at}: PIT ${key}`);
    }
  });
}

interface Refusal {
  year: Year;
  label: string;
  /** Which calculator, and the fields that differ from the June 8 000 zł base. */
  input: { zus: Partial<PlZusCalcInput> } | { pit: Partial<PlPitCalcInput> };
  refusal: RegExp;
}

const REFUSALS: readonly Refusal[] = [
  { year: 2026, label: "turns 21: ulga dla młodych refused by name", input: { zus: { rokUrodzenia: 2005 } }, refusal: /ulga dla młodych/ },
  { year: 2025, label: "turns 20: ulga dla młodych refused by name", input: { zus: { rokUrodzenia: 2005 } }, refusal: /ulga dla młodych/ },
  { year: 2024, label: "turns 20: ulga dla młodych refused by name", input: { zus: { rokUrodzenia: 2004 } }, refusal: /ulga dla młodych/ },
  { year: 2026, label: "turns 58: the 55–60 sex-split band refused by name", input: { zus: { rokUrodzenia: 1968 } }, refusal: /55–60/ },
  { year: 2025, label: "turns 57: the 55–60 sex-split band refused by name", input: { zus: { rokUrodzenia: 1968 } }, refusal: /55–60/ },
  { year: 2025, label: "the 55–60 refusal cites promotion-act art. 104b", input: { zus: { rokUrodzenia: 1968 } }, refusal: /104b/ },
  { year: 2024, label: "turns 56: the 55–60 sex-split band refused by name", input: { zus: { rokUrodzenia: 1968 } }, refusal: /55–60/ },
  { year: 2024, label: "the 55–60 refusal cites promotion-act art. 104b", input: { zus: { rokUrodzenia: 1968 } }, refusal: /104b/ },
  ...([2024, 2025, 2026] as const).flatMap((year): Refusal[] => [
    { year, label: "ZUS refuses non-monthly periodicity", input: { zus: { periodsPerYear: 13 } }, refusal: /monthly/ },
    { year, label: "PIT refuses non-monthly periodicity", input: { pit: { periodsPerYear: 4 } }, refusal: /monthly/ },
    { year, label: "a non-numeric wypadkowe rate is refused", input: { zus: { wypadkowePct: "abc" } }, refusal: /percent/ },
  ]),
  { year: 2026, label: "a 2025 pay date has no 2026 figures", input: { zus: { payDate: "2025-06-15" } }, refusal: /no transcribed figures/ },
  { year: 2025, label: "a 2026 pay date has no 2025 figures", input: { zus: { payDate: "2026-06-15" } }, refusal: /no transcribed figures/ },
  { year: 2024, label: "a 2025 pay date has no 2024 figures", input: { zus: { payDate: "2025-01-15" } }, refusal: /no transcribed figures/ },
];

for (const row of REFUSALS) {
  test(`${row.year} refusal: ${row.label}`, () => {
    const base = { ...june(row.year), periodsPerYear: 12 };
    const { input } = row;
    const run = "zus" in input
      ? () => CALC[row.year].zus({ ...base, ...input.zus } as PlZusCalcInput)
      : () => CALC[row.year].pit({
          brut: base.brut, zusEe: "1096.8000", kup: "miejscowy", pomniejszenie: "1/12",
          payDate: base.payDate, periodsPerYear: 12, ...input.pit,
        });
    assert.throws(run, row.refusal, `${row.year} ${row.label}`);
  });
}

// ── Adapter: computePlStatutory through the real createPushStatutory ──
// Only the component-row lookup (`need`) is stubbed — unit tests have no
// database. The statutoryAssessment consult is real, so an undeclared
// (systemKey, kind) throws PayrollPackError here exactly as in a live run.
function adapterContext(payDate: string, overrides: Record<string, unknown> = {}) {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "PL",
    lines,
    emittedEarningsAssessed: new Set<string>(),
    need: (systemKey: string, kind: string): Record<string, unknown> => ({ id: `${systemKey}:${kind}` }),
  });
  const ctx = {
    taxYear: 2026,
    region: "PL",
    run: { pay_date: payDate },
    emp: { pl_rok_urodzenia: "1990" },
    income: "8000.00",
    nonPeriodic: "",
    pensionable: "8000.00",
    insurable: "0",
    periodsPerYear: 12,
    resolveStatutoryRates: async () => ({
      values: (key: string) => key === "pl_wypadkowe" ? { stopa: "1.67" } : null,
    }),
    pushStatutory,
    certificateFor: (key: string) =>
      key === "pl_pit2" ? { answers: { pomniejszenie: "1/12", kup: "miejscowy" } } : null,
    assertRegionSupported: () => {},
    ...overrides,
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

test("2026 adapter: June payslip pushes PIT plus all ten ZUS lines, assessed honestly", async () => {
  const { ctx, lines } = adapterContext("2026-06-15");
  const result = await computePlStatutory(ctx);
  // The standard June row above, plus wypadkowe 133,60 at the payer's ZUS-notified 1,67 % rate
  // (ZUS, 2026 guidance: https://www.zus.pl/documents/10182/167567/poradnik_wypadkowe.pdf/15281e1b-c3f3-472a-81b3-7d10e1a434c8).
  const keys = ["ZALICZKA", "ZUS_EE", "ZDR", "EMERYT_ER", "RENT_ER", "FP", "FS", "FGSP", "WYP_ER"];
  assert.deepEqual(
    Object.fromEntries(keys.map((key) => [key, result[key]])),
    {
      ZALICZKA: "498.0000", ZUS_EE: "1096.8000", ZDR: "621.2900", EMERYT_ER: "780.8000", RENT_ER: "520.0000",
      FP: "80.0000", FS: "116.0000", FGSP: "8.0000", WYP_ER: "133.6000",
    },
    "2026 adapter June payslip: result factors",
  );
  // PIT moves with pre-tax deductions; every contribution is rate × base.
  assert.deepEqual(
    lines.map((line) => [line.componentId, line.kind, line.description, line.amount, line.sequence, line.assessedOn]),
    [
      ["pit:deduction", "deduction", "Zaliczka na podatek dochodowy (PIT)", "498.0000", 110, "taxable_income"],
      ["zus_emeryt:deduction", "deduction", "Składka emerytalna (pracownik)", "780.8000", 120, "earnings"],
      ["zus_rent:deduction", "deduction", "Składka rentowa (pracownik)", "120.0000", 121, "earnings"],
      ["zus_chor:deduction", "deduction", "Składka chorobowa (pracownik)", "196.0000", 122, "earnings"],
      ["zus_zdr:deduction", "deduction", "Składka zdrowotna (NFZ)", "621.2900", 123, "earnings"],
      ["zus_emeryt_er:employer_contribution", "employer_contribution", "Składka emerytalna (pracodawca)", "780.8000", 210, "earnings"],
      ["zus_rent_er:employer_contribution", "employer_contribution", "Składka rentowa (pracodawca)", "520.0000", 211, "earnings"],
      ["fp_er:employer_contribution", "employer_contribution", "Fundusz Pracy (pracodawca)", "80.0000", 212, "earnings"],
      ["fs_er:employer_contribution", "employer_contribution", "Fundusz Solidarnościowy (pracodawca)", "116.0000", 213, "earnings"],
      ["fgsp_er:employer_contribution", "employer_contribution", "FGŚP (pracodawca)", "8.0000", 214, "earnings"],
      ["wypadkowe_er:employer_contribution", "employer_contribution", "Składka wypadkowa (pracodawca)", "133.6000", 215, "earnings"],
    ],
    "2026 adapter June payslip: pushed lines",
  );
});

const ADAPTER_REFUSALS: readonly { label: string; payDate: string; input: Record<string, unknown>; refusal: RegExp }[] = [
  { label: "a missing ZUS wypadkowe rate is refused instead of omitting WYP-ER", payDate: "2026-06-15",
    input: { resolveStatutoryRates: async () => ({ values: () => null }) },
    refusal: /PL wypadkowe refuses.*ZUS-notified rate.*Payroll Setup/ },
  // Prior months are priced as (month − 1) × this month: a bonus would imply every
  // prior month paid it too, collapsing the ZUS room and pushing PIT to 32 %.
  { label: "a December bonus is refused instead of annualised into YTD", payDate: "2026-12-15",
    input: { nonPeriodic: "20000.00" },
    refusal: /PL refuses a bonus\/uneven versement.*no pack channel carries YTD/ },
  // No certificate must not fall through to the 300 zł reduction or the 250 zł KUP.
  { label: "no PIT-2 certificate on file is refused by name", payDate: "2026-06-15",
    input: { certificateFor: () => null }, refusal: /pl_pit2/ },
  { label: "no birth year on file is refused by name", payDate: "2026-06-15",
    input: { emp: {} }, refusal: /pl_rok_urodzenia/ },
  { label: "an untranscribed tax year is refused", payDate: "2026-06-15",
    input: { taxYear: 2027 }, refusal: /has not been transcribed/ },
];

for (const row of ADAPTER_REFUSALS) {
  test(`adapter refusal: ${row.label}`, async () => {
    const { ctx, lines } = adapterContext(row.payDate, row.input);
    await assert.rejects(() => computePlStatutory(ctx), row.refusal, row.label);
    assert.deepEqual(lines, [], `${row.label}: a refused run pushes nothing`);
  });
}
