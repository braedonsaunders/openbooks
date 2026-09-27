/**
 * SG CPF/SDL conformance goldens, 2024–2026 — pure, no database.
 *
 * Every expected figure is read out of the CPF Board's own publications and
 * hand-worked independently of the engine, never pasted from engine output:
 * each year's Table 1 (55 & below: "[37% (OW)]* + 37% (AW)" / "[20% (OW)]*",
 * total half-up to the dollar, employee share floored, employer the
 * difference) against that year's OW ceiling ($6,800 / $7,400 / $8,000), the
 * Board's "Examples for computation of Additional Wage (AW) Ceiling", the 2026
 * Tables 1–5 for the other age bands and SPR schedules, and the SDL example
 * table (A $609.50 → $2 minimum; B $2,000 → $5; C $4,500 → $11.25; D $4,502.03
 * → $11.25 maximum; frozen since 1 Oct 2008). The $9,000 rows price one
 * unchanged input in every year, so a year falling through to another
 * year's tables cannot pass. Everything not transcribed is refused by name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import { calculateSgStatutory, type SgStatutoryInput, type SgStatutoryResult } from "./cpf.ts";

type Input = Partial<SgStatutoryInput> & { ordinaryWages: string };
interface Golden {
  year: 2024 | 2025 | 2026;
  label: string;
  input: Input;
  expected: Partial<SgStatutoryResult>;
  citation: string;
}

const AW_2024 = "CPF Board, Examples for computation of AW Ceiling (2024 edition)";
const T1_2024 = "CPF Board Table 1, CPF_contribution_rates_from_1_Jan_2024.pdf";
const T1_2025 = "CPF Board Table 1, CPF_contribution_rates_from_1_Jan_2025.pdf";
const AW_2026 = "CPF Board, Examples for computation of AW Ceiling (2026 edition)";
const T_2026 = "CPF Board Tables 1–5, CPFcontributionratesfrom1Jan2026.pdf";
const SDL = "CPF Board, Skills Development Levy page, example table";

const cpf = (totalCents: bigint, employeeCents: bigint, employerCents: bigint, owSubjectCents?: bigint) =>
  ({ totalCents, employeeCents, employerCents, ...(owSubjectCents === undefined ? {} : { owSubjectCents }) });

const GOLDENS: Golden[] = [
  // 2024: the Board prints the OW rows of all three AW-ceiling examples.
  { year: 2024, label: "ex. 1: $7,000 OW prices on the $6,800 ceiling", input: { ordinaryWages: "7000.00" }, expected: cpf(251600n, 136000n, 115600n, 680000n), citation: `${AW_2024}, example 1` },
  { year: 2024, label: "ex. 2: $4,500 OW prices whole", input: { ordinaryWages: "4500.00" }, expected: cpf(166500n, 90000n, 76500n, 450000n), citation: `${AW_2024}, example 2` },
  // Example 3, April–December months: 17% × 6,000 and 20% × 6,000.
  { year: 2024, label: "ex. 3: $6,000 OW prices whole", input: { ordinaryWages: "6000.00" }, expected: cpf(222000n, 120000n, 102000n, 600000n), citation: `${AW_2024}, example 3` },
  { year: 2024, label: "$9,000 OW binds the $6,800 ceiling", input: { ordinaryWages: "9000.00" }, expected: cpf(251600n, 136000n, 115600n), citation: `${T1_2024}, 55 & below` },
  // 2025: 37% × 7,400 = 2,738; 20% × 7,400 = 1,480; employer 1,258.
  { year: 2025, label: "$9,000 OW prices on the $7,400 ceiling", input: { ordinaryWages: "9000.00" }, expected: cpf(273800n, 148000n, 125800n, 740000n), citation: `${T1_2025}, "* Max. of $2,738 / * Max. of $1,480"` },
  { year: 2025, label: "$4,500 OW prices whole", input: { ordinaryWages: "4500.00" }, expected: cpf(166500n, 90000n, 76500n, 450000n), citation: `${T1_2025}, 55 & below` },
  // "> $500 to $750: 17% (TW) + 0.6 (TW - $500)": $600 → 102 + 60 = $162.
  { year: 2025, label: "$600 prices the $500–$750 0.6 slope", input: { ordinaryWages: "600.00" }, expected: cpf(16200n, 6000n, 10200n), citation: `${T1_2025}, "> $500 to $750"` },
  // 2026.
  { year: 2026, label: "$9,000 OW prices on the $8,000 ceiling", input: { ordinaryWages: "9000.00" }, expected: cpf(296000n, 160000n, 136000n, 800000n), citation: `${AW_2026}, §1` },
  { year: 2026, label: "$4,500 OW prices whole", input: { ordinaryWages: "4500.00" }, expected: cpf(166500n, 90000n, 76500n, 450000n), citation: `${AW_2026}, §2` },
  { year: 2026, label: "the $2,960 / $1,600 maxima bind above the ceiling", input: { ordinaryWages: "20000.00" }, expected: cpf(296000n, 160000n, 136000n, 800000n), citation: `${T_2026}, Table 1` },
  { year: 2026, label: "$50 or less of OW is Nil", input: { ordinaryWages: "50.00" }, expected: cpf(0n, 0n, 0n), citation: `${T_2026}, Table 1` },
  { year: 2026, label: "$400 prices 17% total with a Nil employee share", input: { ordinaryWages: "400.00" }, expected: cpf(6800n, 0n, 6800n), citation: `${T_2026}, Table 1 "> $50 to $500"` },
  { year: 2026, label: "$600 prices the $500–$750 0.6 slope", input: { ordinaryWages: "600.00" }, expected: cpf(16200n, 6000n, 10200n), citation: `${T_2026}, Table 1 "> $500 to $750"` },
  ...([
    ["citizen", "b55_60", "3000.00", 102000n, 54000n], ["citizen", "b60_65", "3000.00", 75000n, 37500n],
    ["citizen", "b65_70", "3000.00", 49500n, 22500n], ["citizen", "gt70", "3000.00", 37500n, 15000n],
    ["spr_1st_year", "le55", "600.00", 3900n, 1500n], ["spr_1st_year", "le55", "3000.00", 27000n, 15000n],
    ["spr_2nd_year", "b60_65", "3000.00", 33000n, 22500n],
    ["spr_1st_year_full_employer", "b55_60", "3000.00", 63000n, 15000n],
    ["spr_2nd_year_full_employer", "b65_70", "3000.00", 42000n, 15000n],
  ] as const).map(([cpfStatus, ageBand, ordinaryWages, totalCents, employeeCents]): Golden => ({
    year: 2026, label: `${cpfStatus}/${ageBand} $${ordinaryWages}`, input: { cpfStatus, ageBand, ordinaryWages },
    expected: { totalCents, employeeCents }, citation: T_2026,
  })),
  // Foreigners are outside CPF but still pay SDL.
  { year: 2026, label: "foreigner: no CPF, SDL still due", input: { cpfStatus: "foreigner", ordinaryWages: "2000.00" }, expected: { cpfApplicable: false, owSubjectCents: 0n, employeeCents: 0n, employerCents: 0n, sdlCents: 500n }, citation: "CPF Board, saving-as-an-employee (foreigners exempt); SDL example B" },
  // SDL: 0.25% / $2 floor / $11.25 cap, pinned per year so an "unfreeze" argues with a row.
  ...([2024, 2025, 2026] as const).flatMap((year) => ([
    ["A $609.50 → $2 minimum", "609.50", 200n], ["B $2,000 → $5", "2000.00", 500n], ["C $4,500 → $11.25", "4500.00", 1125n],
    ["D $4,502.03 → $11.25 maximum", "4502.03", 1125n], ["E $10,000 → $11.25 cap", "10000.00", 1125n],
  ] as const).map(([label, ordinaryWages, sdlCents]): Golden => ({
    year, label: `SDL ${label}`, input: { ordinaryWages }, expected: { sdlCents }, citation: SDL,
  }))),
  { year: 2026, label: "SDL $100 → $2 floor below $800", input: { ordinaryWages: "100.00" }, expected: { sdlCents: 200n }, citation: SDL },
];

interface Refusal { label: string; input: SgStatutoryInput; refusal: RegExp }
const citizen = (taxYear: number, ordinaryWages: string, additionalWages?: string): SgStatutoryInput =>
  ({ taxYear, cpfStatus: "citizen", ageBand: "le55", ordinaryWages, additionalWages });

// Each year's AW refusal names that year's own at-full-OW ceiling, never a carried one.
const REFUSALS: Refusal[] = [
  { label: "2023 is not transcribed", input: citizen(2023, "4500.00"), refusal: /no transcribed CPF tables for 2023/ },
  { label: "2027 is not transcribed", input: citizen(2027, "4500.00"), refusal: /no transcribed CPF tables for 2027/ },
  // "$102,000 – ($6,800 x 12) = $20,400" (AW-ceiling examples, 2024, example 1).
  { label: "2024 AW names the 2024 ceiling", input: citizen(2024, "6800.00", "500.00"), refusal: /refuses Additional Wages.*2024 AW ceiling.*\$102,000.*\$20,400/ },
  // $102,000 − ($7,400 × 12) = $13,200 (IRAS CPF-relief page, 2025 inputs).
  { label: "2025 AW names the 2025 ceiling", input: citizen(2025, "7400.00", "500.00"), refusal: /refuses Additional Wages.*2025 AW ceiling.*\$102,000.*\$13,200/ },
  { label: "2026 AW is refused", input: citizen(2026, "4500.00", "500.00"), refusal: /refuses Additional Wages.*\$102,000/ },
  { label: "an unknown age band is refused", input: { ...citizen(2026, "4500.00"), ageBand: "xx" as never }, refusal: /age band/ },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const result = calculateSgStatutory({ taxYear: row.year, cpfStatus: "citizen", ageBand: "le55", ...row.input });
    for (const [key, want] of Object.entries(row.expected)) {
      assert.equal(result[key as keyof SgStatutoryResult], want, `${row.year} ${row.label} (${row.citation}): ${key}`);
    }
  });
}

for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, () => {
    assert.throws(() => calculateSgStatutory(row.input), (error: Error) => {
      assert.ok(error instanceof PayrollError, `${row.label}: ${error.message}`);
      assert.match(error.message, row.refusal, row.label);
      return true;
    });
  });
}

test("a 3rd-year SPR prices the same Table 1 row as a citizen", () => {
  // Table 1 header: "for Singapore Citizens or Singapore Permanent Residents (3rd year onwards)".
  for (const [taxYear, ordinaryWages] of [[2025, "7400.00"], [2026, "4500.00"]] as const) {
    const input = { taxYear, ageBand: "le55", ordinaryWages } as const;
    assert.deepEqual(calculateSgStatutory({ ...input, cpfStatus: "spr_3rd_year" }), calculateSgStatutory({ ...input, cpfStatus: "citizen" }), `${taxYear}`);
  }
});
