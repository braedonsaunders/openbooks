/**
 * JP 2026 pure-engine goldens: NTA 月額表 cells and the 求め方's worked example,
 * JPS grades, the 協会けんぽ 50銭 rule and hand-worked payslips in one table;
 * refusals in another; then sweeps across every bracket and grade step. The
 * year gate is proven in pack.test.ts, through the adapter that owns it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JP_PENSION_GRADES_2026 } from "./pension-2026.ts";
import { JP_GENSEN_MONTHLY_2026 } from "./tables-2026.ts";
import {
  calculateJp2026, healthHalfShare, lookupGensenKo, lookupGensenOtsu, pensionGradeForPay, pensionGradeForStandard,
} from "./withholding-2026.ts";

type Input =
  | { kind: "gensen"; pay: bigint; dependents: number | null }
  | { kind: "grade-for-standard" | "grade-for-pay"; amount: bigint }
  | { kind: "health"; standard: bigint; rate: string }
  | { kind: "payslip"; gross: bigint; standard: bigint; dependents: number | null };

interface Golden { year: number; label: string; input: Input; expected: Record<string, bigint | number>; citation: string }

const yen = (amount: bigint) => `${amount.toLocaleString("en-US")}円`;
const NTA = (row: number) => `NTA 月額表 row ${row}`;
const JPS = "JPS 厚生年金保険料額表 (折半額)";

/** One 月額表 cell: `dependents` null reads the 乙欄. */
const gensen = (citation: string, pay: bigint, dependents: number | null, tax: bigint): Golden => ({
  year: 2026, label: `${yen(pay)} ${dependents === null ? "乙欄" : `甲欄 ${dependents}人`}`,
  input: { kind: "gensen", pay, dependents }, expected: { gensen: tax }, citation,
});
const grade = (kind: "grade-for-standard" | "grade-for-pay", amount: bigint, expected: Golden["expected"], citation: string): Golden => ({
  year: 2026, label: `${kind === "grade-for-standard" ? "標準報酬月額" : "報酬月額"} ${yen(amount)}`, input: { kind, amount }, expected, citation,
});
const slip = (label: string, gross: bigint, standard: bigint, dependents: number | null, expected: Golden["expected"], citation: string): Golden =>
  ({ year: 2026, label, input: { kind: "payslip", gross, standard, dependents }, expected, citation });
const health = (standard: bigint, rate: string, half: bigint, citation: string): Golden => ({
  year: 2026, label: `health half-share ${yen(standard)} at ${rate}%`, input: { kind: "health", standard, rate }, expected: { half }, citation,
});

const GOLDENS: readonly Golden[] = [
  gensen(NTA(1), 105000n, 0, 170n), gensen(NTA(1), 106999n, 0, 170n), gensen(NTA(1), 105000n, 1, 0n),
  gensen(NTA(1), 105000n, 7, 0n), gensen(NTA(1), 105000n, null, 3800n),
  gensen(NTA(59), 221000n, 0, 5150n), gensen(NTA(59), 223999n, 1, 3520n), gensen(NTA(59), 222500n, 2, 1910n),
  gensen(NTA(59), 221000n, 3, 300n), gensen(NTA(59), 221000n, 4, 0n), gensen(NTA(59), 223999n, null, 26400n),
  ...[7930n, 6320n, 4700n, 3080n, 1470n, 0n].map((tax, dependents) => gensen(NTA(85), 300000n, dependents, tax)),
  gensen(NTA(85), 299000n, null, 53600n),
  gensen(`${NTA(114)}: first nonzero 7人 cell`, 387000n, 7, 170n), gensen(NTA(114), 387000n, 6, 1790n),
  gensen(`${NTA(114)}: just below it, 7人 is still 0`, 385999n, 7, 0n),
  gensen(`${NTA(231)} (last)`, 737000n, 0, 71380n), gensen(`${NTA(231)} (last)`, 739999n, 7, 26110n),
  gensen(`${NTA(231)} (last)`, 739999n, null, 257700n),
  gensen("月額表の求め方: 「2,473円（80,750円×3.063%、1円未満の端数は切り捨てます。)」", 80750n, null, 2473n),
  gensen("月額表: 乙欄 below 105,000円 is 3.063%", 0n, null, 0n),
  gensen("月額表: 乙欄 below 105,000円 is 3.063%, truncated", 104999n, null, 3216n),
  grade("grade-for-standard", 88000n, { grade: 1, half: 8052n }, `${JPS}: bottom grade`),
  grade("grade-for-standard", 300000n, { grade: 19, half: 27450n }, `${JPS}: middle grade`),
  grade("grade-for-standard", 650000n, { grade: 32, half: 59475n }, `${JPS}: top grade`),
  grade("grade-for-pay", 0n, { grade: 1 }, `${JPS}: grade 1 takes everything below 93,000円`),
  grade("grade-for-pay", 92999n, { grade: 1 }, `${JPS}: grade 1 takes everything below 93,000円`),
  grade("grade-for-pay", 635000n, { grade: 32 }, `${JPS}: grade 32 from 635,000円`),
  grade("grade-for-pay", 2000000n, { grade: 32, half: 59475n }, `${JPS}: grade 32 has no ceiling`),
  health(88000n, "9.85", 4334n, "協会けんぽ 9.85%"),
  health(300000n, "9.85", 14775n, "協会けんぽ 9.85%: 29,550 halved exactly"),
  health(100000n, "9.801", 4900n, "50銭以下切り捨て: half 4,900.5 is exactly 50銭"),
  health(100000n, "9.80102", 4901n, "50銭超切り上げ: half 4,900.51"),
  health(100000n, "9.80098", 4900n, "50銭未満: half 4,900.49"),
  slip("甲 payslip: 300,000円, grade 300,000, 0人, 9.85%", 300000n, 300000n, 0,
    { pension: 27450n, pensionEmployer: 27450n, health: 14775n, healthEmployer: 14775n, gensenBase: 257775n, gensen: 6430n },
    `hand-worked: grade 19 → 27,450; 300,000 × 9.85% / 2 = 14,775; base 257,775 → ${NTA(71)} 0人`),
  slip("甲 payslip: same pay, 2人", 300000n, 300000n, 2, { gensenBase: 257775n, gensen: 3200n }, `hand-worked: ${NTA(71)} 2人`),
  slip("乙 payslip: no declaration, same base", 300000n, 300000n, null, { gensenBase: 257775n, gensen: 38600n }, `hand-worked: ${NTA(71)} 乙欄`),
  slip("甲 payslip: 150,000円, grade 150,000, 0人, 9.85%", 150000n, 150000n, 0, { pension: 13725n, health: 7387n, gensenBase: 128888n, gensen: 1300n },
    `hand-worked: grade 9 → 13,725; half 7,387.5 → 50銭以下切り捨て 7,387; base 128,888 → ${NTA(12)} 0人`),
];

/** A resident payslip at the 9.85% health rate, before the 2026-04 child contributions. */
const payslip = (gross: bigint, standard: bigint, dependents: number | null) => calculateJp2026({
  grossMonthly: gross, standard, dependents, healthRate: "9.85", childContributionsEffective: false, taxResidence: "resident",
});

function compute(input: Input): Record<string, bigint | number> {
  if (input.kind === "gensen") {
    return { gensen: input.dependents === null ? lookupGensenOtsu(input.pay) : lookupGensenKo(input.pay, input.dependents) };
  }
  if (input.kind === "health") return { half: healthHalfShare(input.standard, input.rate) };
  if (input.kind === "payslip") return { ...payslip(input.gross, input.standard, input.dependents) };
  const priced = (input.kind === "grade-for-pay" ? pensionGradeForPay : pensionGradeForStandard)(input.amount);
  return { grade: priced.grade, half: priced.half };
}

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const actual = compute(row.input);
    for (const [field, figure] of Object.entries(row.expected)) {
      assert.equal(actual[field], figure, `${row.year} ${row.label}: ${field} — ${row.citation}`);
    }
  });
}

const REFUSALS: readonly { label: string; input: () => unknown; refusal: RegExp }[] = [
  ...[740000n, 790000n, 1000000n].flatMap((amount) => [
    { label: `甲欄 at ${yen(amount)}: formula rows untranscribed`, input: () => lookupGensenKo(amount, 0), refusal: /740,000/ },
    { label: `乙欄 at ${yen(amount)}: formula rows untranscribed`, input: () => lookupGensenOtsu(amount), refusal: /740,000/ },
  ]),
  { label: "an amount past Number precision is named exactly", input: () => lookupGensenKo(9007199254740993n, 0), refusal: /9007199254740993/ },
  { label: "a health rate that is not a number", input: () => healthHalfShare(300000n, "nine"), refusal: /health rate "nine" is not a percent number/ },
  { label: "an empty health rate", input: () => healthHalfShare(300000n, ""), refusal: /health rate "" is not a percent number/ },
  { label: "an unpublished 標準報酬月額", input: () => pensionGradeForStandard(99000n),
    refusal: /99000円 matches no 厚生年金 grade.*copy the grade off the JPS notice/ },
  { label: "a payslip on an unpublished 標準報酬月額", input: () => payslip(300000n, 99000n, 0), refusal: /99000円 matches no 厚生年金 grade/ },
  { label: "premiums exceeding pay", input: () => payslip(10000n, 88000n, 0), refusal: /gensen base is negative/ },
];

for (const { label, input, refusal } of REFUSALS) {
  test(`refused: ${label}`, () => assert.throws(input, refusal, label));
}

const COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7];

test("sweep: every 月額表 row boundary on both sides, monotone in pay and in dependents", () => {
  assert.equal(JP_GENSEN_MONTHLY_2026.length, 231);
  JP_GENSEN_MONTHLY_2026.forEach((row, index) => {
    const prev = JP_GENSEN_MONTHLY_2026[index - 1];
    if (prev) assert.equal(prev.hi, row.lo, `rows ${prev.n}/${row.n} contiguous`);
    for (const dependents of COLUMNS) {
      const cell = row.ko[dependents]!;
      assert.equal(lookupGensenKo(row.lo, dependents), cell, `row ${row.n} lo`);
      assert.equal(lookupGensenKo(row.hi - 1n, dependents), cell, `row ${row.n} hi-1`);
      // Below row 1 every 甲 column is 0, down to 0円.
      assert.equal(lookupGensenKo(row.lo - 1n, dependents), prev ? prev.ko[dependents] : 0n, `below row ${row.n}`);
      if (!prev) assert.equal(lookupGensenKo(0n, dependents), 0n, `0円/${dependents}人`);
      if (prev) assert.ok(cell >= prev.ko[dependents]!, `ko/${dependents} dips at row ${row.n}`);
      if (dependents > 0) assert.ok(cell <= row.ko[dependents - 1]!, `row ${row.n}: ${dependents}人 exceeds ${dependents - 1}人`);
    }
    assert.equal(lookupGensenOtsu(row.lo), row.otsu, `row ${row.n} otsu lo`);
    assert.equal(lookupGensenOtsu(row.hi - 1n), row.otsu, `row ${row.n} otsu hi-1`);
    assert.equal(lookupGensenOtsu(row.lo - 1n), prev ? prev.otsu : ((row.lo - 1n) * 3063n) / 100000n, `below row ${row.n} otsu`);
    if (prev) assert.ok(row.otsu >= prev.otsu, `otsu dips at row ${row.n}`);
  });
});

test("sweep: every grade is 9.15% (折半), invariant within, and steps on both sides", () => {
  assert.equal(JP_PENSION_GRADES_2026.length, 32);
  JP_PENSION_GRADES_2026.forEach((current, index) => {
    assert.equal(current.full, current.half * 2n, `grade ${current.grade} full`);
    assert.equal(current.half * 10000n, current.standard * 915n, `grade ${current.grade} 9.15%`);
    const loPay = current.lo ?? 0n;
    const hiPay = current.hi ?? current.lo! + 100000n;
    for (const pay of [loPay, (loPay + hiPay) / 2n, hiPay - 1n]) {
      assert.equal(pensionGradeForPay(pay).grade, current.grade, `pay ${pay} stays in grade ${current.grade}`);
      assert.equal(pensionGradeForPay(pay).half, current.half, `pay ${pay} premium invariant`);
    }
    const next = JP_PENSION_GRADES_2026[index + 1];
    if (next) {
      assert.equal(pensionGradeForPay(next.lo! - 1n).grade, current.grade, `just below grade ${next.grade}`);
      assert.equal(pensionGradeForPay(next.lo!).grade, next.grade, `at grade ${next.grade}`);
      assert.notEqual(next.half, current.half, `grades ${current.grade}/${next.grade} step`);
    }
  });
});
