/**
 * JP 2026 pure-engine tests: NTA 月額表 gold parity, pension grade parity,
 * and the four gold-parity mechanisms.
 *
 * Mechanism 1 (published-table rows, no excuse for skipping): rows straight
 * off the NTA 月額表 and the JPS 料額表, asserting the engine reproduces
 * them exactly — plus the 求め方's own worked example (80,750円 → 2,473円).
 * Mechanism 2 (hand-worked cases with arithmetic shown): full payslips with
 * every subtraction on display. Mechanism 3 (year resolver throws both
 * sides): in pack.test.ts, through the adapter that owns the year gate.
 * Mechanism 4 (sweeps): at, below and above every bracket and every grade
 * boundary, plus monotonicity both ways — and the grade STEP trap: both
 * sides of each step, and pay rising within one grade never moving the
 * premium.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollPackError } from "../payroll-error.ts";
import { JP_PENSION_GRADES_2026 } from "./pension-2026.ts";
import { JP_GENSEN_MONTHLY_2026 } from "./tables-2026.ts";
import {
  calculateJp2026,
  healthHalfShare,
  lookupGensenKo,
  lookupGensenOtsu,
  pensionGradeForPay,
  pensionGradeForStandard,
} from "./withholding-2026.ts";

// ---------------------------------------------------------------------------
// Mechanism 1a: NTA 月額表 rows, straight off the published table.
// ---------------------------------------------------------------------------

test("NTA row 1: 105,000–107,000円 prices 170 at 0人, 0 above, 乙 3,800", () => {
  assert.equal(lookupGensenKo(105000n, 0), 170n);
  assert.equal(lookupGensenKo(106999n, 0), 170n);
  assert.equal(lookupGensenKo(105000n, 1), 0n);
  assert.equal(lookupGensenKo(105000n, 7), 0n);
  assert.equal(lookupGensenOtsu(105000n), 3800n);
});

test("NTA row 59: 221,000–224,000円 prices 5,150/3,520/1,910/300", () => {
  assert.equal(lookupGensenKo(221000n, 0), 5150n);
  assert.equal(lookupGensenKo(223999n, 1), 3520n);
  assert.equal(lookupGensenKo(222500n, 2), 1910n);
  assert.equal(lookupGensenKo(221000n, 3), 300n);
  assert.equal(lookupGensenKo(221000n, 4), 0n);
  assert.equal(lookupGensenOtsu(223999n), 26400n);
});

test("NTA row 85: 299,000–302,000円 prices the full 0–4人 ladder", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((dependents) => lookupGensenKo(300000n, dependents)),
    [7930n, 6320n, 4700n, 3080n, 1470n, 0n],
  );
  assert.equal(lookupGensenOtsu(299000n), 53600n);
});

test("NTA row 114: first nonzero at 7人 (386,000–389,000円 → 170)", () => {
  assert.equal(lookupGensenKo(387000n, 7), 170n);
  assert.equal(lookupGensenKo(387000n, 6), 1790n);
  assert.equal(lookupGensenKo(385999n, 7), 0n);
});

test("NTA row 231 (last): 737,000–740,000円 prices 71,380 at 0人", () => {
  assert.equal(lookupGensenKo(737000n, 0), 71380n);
  assert.equal(lookupGensenKo(739999n, 7), 26110n);
  assert.equal(lookupGensenOtsu(739999n), 257700n);
});

test("below the floor: under 105,000円 every 甲 column is 0", () => {
  for (let dependents = 0; dependents <= 7; dependents++) {
    assert.equal(lookupGensenKo(0n, dependents), 0n, `0円/${dependents}人`);
    assert.equal(lookupGensenKo(104999n, dependents), 0n, `104,999円/${dependents}人`);
  }
});

test("求め方 worked example: 乙 80,750円 → 2,473円 (3.063%, sub-yen truncated)", () => {
  // 月額表の求め方: 「2,473円（80,750円×3.063%、1円未満の端数は切り捨て
  // ます。)」 — 80,750 × 0.03063 = 2,473.3725 → 2,473.
  assert.equal(lookupGensenOtsu(80750n), 2473n);
  assert.equal(lookupGensenOtsu(0n), 0n);
  assert.equal(lookupGensenOtsu(104999n), 3216n);
});

// ---------------------------------------------------------------------------
// Mechanism 1b: JPS 料額表 grades — bottom, middle, top.
// ---------------------------------------------------------------------------

test("JPS grades: bottom, middle and top half-shares reproduce the table", () => {
  assert.equal(pensionGradeForStandard(88000n).half, 8052n);
  assert.equal(pensionGradeForStandard(88000n).grade, 1);
  assert.equal(pensionGradeForStandard(300000n).half, 27450n);
  assert.equal(pensionGradeForStandard(300000n).grade, 19);
  assert.equal(pensionGradeForStandard(650000n).half, 59475n);
  assert.equal(pensionGradeForStandard(650000n).grade, 32);
});

test("every transcribed grade: full is twice the half, half is 9.15% of standard", () => {
  assert.equal(JP_PENSION_GRADES_2026.length, 32);
  for (const grade of JP_PENSION_GRADES_2026) {
    assert.equal(grade.full, grade.half * 2n, `grade ${grade.grade} full`);
    assert.equal(grade.half * 10000n, grade.standard * 915n, `grade ${grade.grade} 9.15%`);
  }
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked payslips, arithmetic shown.
// ---------------------------------------------------------------------------

test("hand-worked 甲 payslip: 300,000円 gross, grade 300,000, 0人, Tokyo 9.85%", () => {
  // Pension: grade 19 → 27,450 (折半額). Health: 300,000 × 9.85% = 29,550,
  // half 14,775. Gensen base: 300,000 − 27,450 − 14,775 = 257,775 →
  // row 71 (257,000–260,000) 0人 → 6,430.
  const result = calculateJp2026({ grossMonthly: 300000n, standard: 300000n, dependents: 0, healthRate: "9.85" });
  assert.equal(result.pension, 27450n);
  assert.equal(result.pensionEmployer, 27450n);
  assert.equal(result.health, 14775n);
  assert.equal(result.healthEmployer, 14775n);
  assert.equal(result.gensenBase, 257775n);
  assert.equal(result.gensen, 6430n);
});

test("hand-worked 甲 payslip with dependents: same pay, 2人 → 3,200", () => {
  // Same base 257,775 → row 71, 2人 column → 3,200.
  const result = calculateJp2026({ grossMonthly: 300000n, standard: 300000n, dependents: 2, healthRate: "9.85" });
  assert.equal(result.gensenBase, 257775n);
  assert.equal(result.gensen, 3200n);
});

test("hand-worked 乙 payslip: no declaration → 乙欄 38,600 on the same base", () => {
  const result = calculateJp2026({ grossMonthly: 300000n, standard: 300000n, dependents: null, healthRate: "9.85" });
  assert.equal(result.gensenBase, 257775n);
  assert.equal(result.gensen, 38600n);
});

test("hand-worked low payslip: 150,000円 gross, grade 150,000, 0人, 9.85%", () => {
  // Pension grade 9 → 13,725. Health: 150,000 × 9.85% = 14,775, half
  // exactly 7,387.5 → 50銭以下切り捨て → 7,387. Base:
  // 150,000 − 13,725 − 7,387 = 128,888 → row 12 (127,000–129,000) 0人 → 1,300.
  const result = calculateJp2026({ grossMonthly: 150000n, standard: 150000n, dependents: 0, healthRate: "9.85" });
  assert.equal(result.pension, 13725n);
  assert.equal(result.health, 7387n);
  assert.equal(result.gensenBase, 128888n);
  assert.equal(result.gensen, 1300n);
});

// ---------------------------------------------------------------------------
// Health 50銭 rule, both arms plus the exact boundary.
// ---------------------------------------------------------------------------

test("health half-share: exact halves, the 50銭 boundary, and above it", () => {
  assert.equal(healthHalfShare(88000n, "9.85"), 4334n);
  assert.equal(healthHalfShare(300000n, "9.85"), 14775n);
  // Full 9,801 → half 4,900.5: exactly 50銭 → 切り捨て → 4,900.
  assert.equal(healthHalfShare(100000n, "9.801"), 4900n);
  // Full 9,801.02 → half 4,900.51: 50銭超 → 切り上げ → 4,901.
  assert.equal(healthHalfShare(100000n, "9.80102"), 4901n);
  // Full 9,800.98 → half 4,900.49 → 4,900.
  assert.equal(healthHalfShare(100000n, "9.80098"), 4900n);
  assert.throws(() => healthHalfShare(300000n, "nine"), PayrollPackError);
  assert.throws(() => healthHalfShare(300000n, ""), PayrollPackError);
});

// ---------------------------------------------------------------------------
// Mechanism 4a: sweeps at, below and above every 月額表 bracket.
// ---------------------------------------------------------------------------

test("sweep: every row boundary resolves to the correct row on both sides", () => {
  assert.equal(JP_GENSEN_MONTHLY_2026.length, 231);
  for (let i = 0; i < JP_GENSEN_MONTHLY_2026.length; i++) {
    const row = JP_GENSEN_MONTHLY_2026[i]!;
    // At lo and just below hi: this row, every column.
    for (let dependents = 0; dependents <= 7; dependents++) {
      assert.equal(lookupGensenKo(row.lo, dependents), row.ko[dependents], `row ${row.n} lo`);
      assert.equal(lookupGensenKo(row.hi - 1n, dependents), row.ko[dependents], `row ${row.n} hi-1`);
    }
    assert.equal(lookupGensenOtsu(row.lo), row.otsu, `row ${row.n} otsu lo`);
    assert.equal(lookupGensenOtsu(row.hi - 1n), row.otsu, `row ${row.n} otsu hi-1`);
    // Just below lo: the previous row (or the sub-floor rules for row 1).
    if (i === 0) {
      for (let dependents = 0; dependents <= 7; dependents++) {
        assert.equal(lookupGensenKo(row.lo - 1n, dependents), 0n, "below row 1 is 0");
      }
      assert.equal(lookupGensenOtsu(row.lo - 1n), ((row.lo - 1n) * 3063n) / 100000n, "below row 1 is 3.063%");
    } else {
      const prev = JP_GENSEN_MONTHLY_2026[i - 1]!;
      assert.equal(prev.hi, row.lo, `rows ${prev.n}/${row.n} contiguous`);
      for (let dependents = 0; dependents <= 7; dependents++) {
        assert.equal(lookupGensenKo(row.lo - 1n, dependents), prev.ko[dependents], `below row ${row.n}`);
      }
      assert.equal(lookupGensenOtsu(row.lo - 1n), prev.otsu, `below row ${row.n} otsu`);
    }
  }
});

test("gensen refuses at and above 740,000円 (formula rows untranscribed)", () => {
  for (const amount of [740000n, 790000n, 1000000n]) {
    assert.throws(() => lookupGensenKo(amount, 0), /740,000/);
    assert.throws(() => lookupGensenOtsu(amount), /740,000/);
  }
});

test("monotonicity: tax never falls as pay rises, never rises as dependents rise", () => {
  for (let dependents = 0; dependents <= 7; dependents++) {
    let prev = -1n;
    for (const row of JP_GENSEN_MONTHLY_2026) {
      assert.ok(row.ko[dependents]! >= prev, `ko/${dependents} dips at row ${row.n}`);
      prev = row.ko[dependents]!;
    }
  }
  let prevOtsu = -1n;
  for (const row of JP_GENSEN_MONTHLY_2026) {
    assert.ok(row.otsu >= prevOtsu, `otsu dips at row ${row.n}`);
    prevOtsu = row.otsu;
  }
  for (const row of JP_GENSEN_MONTHLY_2026) {
    for (let dependents = 0; dependents < 7; dependents++) {
      assert.ok(
        row.ko[dependents + 1]! <= row.ko[dependents]!,
        `row ${row.n}: ${dependents + 1}人 exceeds ${dependents}人`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Mechanism 4b: grade STEP sweeps — both sides of every step, invariance within.
// ---------------------------------------------------------------------------

test("sweep: both sides of every grade step, and invariance within each grade", () => {
  assert.equal(JP_PENSION_GRADES_2026.length, 32);
  for (let i = 0; i < JP_PENSION_GRADES_2026.length; i++) {
    const grade = JP_PENSION_GRADES_2026[i]!;
    // Within the grade the premium does not move.
    const loPay = grade.lo ?? 0n;
    const hiPay = grade.hi ?? grade.lo! + 100000n;
    for (const pay of [loPay, (loPay + hiPay) / 2n, hiPay - 1n]) {
      assert.equal(pensionGradeForPay(pay).grade, grade.grade, `pay ${pay} stays in grade ${grade.grade}`);
      assert.equal(pensionGradeForPay(pay).half, grade.half, `pay ${pay} premium invariant`);
    }
    // The step: just below the next grade's floor is still this grade.
    if (i + 1 < JP_PENSION_GRADES_2026.length) {
      const next = JP_PENSION_GRADES_2026[i + 1]!;
      assert.equal(next.lo! - 1n >= 0n ? pensionGradeForPay(next.lo! - 1n).grade : grade.grade, grade.grade);
      assert.equal(pensionGradeForPay(next.lo!).grade, next.grade);
      assert.notEqual(next.half, grade.half, `grades ${grade.grade}/${next.grade} step`);
    }
  }
  // Grade 1 takes everything below 93,000; grade 32 has no ceiling.
  assert.equal(pensionGradeForPay(0n).grade, 1);
  assert.equal(pensionGradeForPay(92999n).grade, 1);
  assert.equal(pensionGradeForPay(635000n).grade, 32);
  assert.equal(pensionGradeForPay(2000000n).grade, 32);
  assert.equal(pensionGradeForPay(2000000n).half, 59475n);
});

test("unknown 標準報酬月額 refuses (copy it off the JPS notice)", () => {
  assert.throws(() => pensionGradeForStandard(99000n), PayrollPackError);
  assert.throws(() => lookupGensenKo(9007199254740993n, 0), /9007199254740993/);
  assert.throws(() => calculateJp2026({ grossMonthly: 300000n, standard: 99000n, dependents: 0, healthRate: "9.85" }), PayrollPackError);
});

test("negative gensen base refuses rather than looking up a negative amount", () => {
  assert.throws(
    () => calculateJp2026({ grossMonthly: 10000n, standard: 88000n, dependents: 0, healthRate: "9.85" }),
    /negative/,
  );
});
