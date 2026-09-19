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
  assert.equal(lookupGensenKo(105000, 0), 170);
  assert.equal(lookupGensenKo(106999, 0), 170);
  assert.equal(lookupGensenKo(105000, 1), 0);
  assert.equal(lookupGensenKo(105000, 7), 0);
  assert.equal(lookupGensenOtsu(105000), 3800);
});

test("NTA row 59: 221,000–224,000円 prices 5,150/3,520/1,910/300", () => {
  assert.equal(lookupGensenKo(221000, 0), 5150);
  assert.equal(lookupGensenKo(223999, 1), 3520);
  assert.equal(lookupGensenKo(222500, 2), 1910);
  assert.equal(lookupGensenKo(221000, 3), 300);
  assert.equal(lookupGensenKo(221000, 4), 0);
  assert.equal(lookupGensenOtsu(223999), 26400);
});

test("NTA row 85: 299,000–302,000円 prices the full 0–4人 ladder", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((dependents) => lookupGensenKo(300000, dependents)),
    [7930, 6320, 4700, 3080, 1470, 0],
  );
  assert.equal(lookupGensenOtsu(299000), 53600);
});

test("NTA row 114: first nonzero at 7人 (386,000–389,000円 → 170)", () => {
  assert.equal(lookupGensenKo(387000, 7), 170);
  assert.equal(lookupGensenKo(387000, 6), 1790);
  assert.equal(lookupGensenKo(385999, 7), 0);
});

test("NTA row 231 (last): 737,000–740,000円 prices 71,380 at 0人", () => {
  assert.equal(lookupGensenKo(737000, 0), 71380);
  assert.equal(lookupGensenKo(739999, 7), 26110);
  assert.equal(lookupGensenOtsu(739999), 257700);
});

test("below the floor: under 105,000円 every 甲 column is 0", () => {
  for (let dependents = 0; dependents <= 7; dependents++) {
    assert.equal(lookupGensenKo(0, dependents), 0, `0円/${dependents}人`);
    assert.equal(lookupGensenKo(104999, dependents), 0, `104,999円/${dependents}人`);
  }
});

test("求め方 worked example: 乙 80,750円 → 2,473円 (3.063%, sub-yen truncated)", () => {
  // 月額表の求め方: 「2,473円（80,750円×3.063%、1円未満の端数は切り捨て
  // ます。)」 — 80,750 × 0.03063 = 2,473.3725 → 2,473.
  assert.equal(lookupGensenOtsu(80750), 2473);
  assert.equal(lookupGensenOtsu(0), 0);
  assert.equal(lookupGensenOtsu(104999), 3216);
});

// ---------------------------------------------------------------------------
// Mechanism 1b: JPS 料額表 grades — bottom, middle, top.
// ---------------------------------------------------------------------------

test("JPS grades: bottom, middle and top half-shares reproduce the table", () => {
  assert.equal(pensionGradeForStandard(88000).half, 8052);
  assert.equal(pensionGradeForStandard(88000).grade, 1);
  assert.equal(pensionGradeForStandard(300000).half, 27450);
  assert.equal(pensionGradeForStandard(300000).grade, 19);
  assert.equal(pensionGradeForStandard(650000).half, 59475);
  assert.equal(pensionGradeForStandard(650000).grade, 32);
});

test("every transcribed grade: full is twice the half, half is 9.15% of standard", () => {
  assert.equal(JP_PENSION_GRADES_2026.length, 32);
  for (const grade of JP_PENSION_GRADES_2026) {
    assert.equal(grade.full, grade.half * 2, `grade ${grade.grade} full`);
    assert.equal(grade.half * 10000, grade.standard * 915, `grade ${grade.grade} 9.15%`);
  }
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked payslips, arithmetic shown.
// ---------------------------------------------------------------------------

test("hand-worked 甲 payslip: 300,000円 gross, grade 300,000, 0人, Tokyo 9.85%", () => {
  // Pension: grade 19 → 27,450 (折半額). Health: 300,000 × 9.85% = 29,550,
  // half 14,775. Gensen base: 300,000 − 27,450 − 14,775 = 257,775 →
  // row 71 (257,000–260,000) 0人 → 6,430.
  const result = calculateJp2026({ grossMonthly: 300000, standard: 300000, dependents: 0, healthRate: "9.85" });
  assert.equal(result.pension, 27450);
  assert.equal(result.pensionEmployer, 27450);
  assert.equal(result.health, 14775);
  assert.equal(result.healthEmployer, 14775);
  assert.equal(result.gensenBase, 257775);
  assert.equal(result.gensen, 6430);
});

test("hand-worked 甲 payslip with dependents: same pay, 2人 → 3,200", () => {
  // Same base 257,775 → row 71, 2人 column → 3,200.
  const result = calculateJp2026({ grossMonthly: 300000, standard: 300000, dependents: 2, healthRate: "9.85" });
  assert.equal(result.gensenBase, 257775);
  assert.equal(result.gensen, 3200);
});

test("hand-worked 乙 payslip: no declaration → 乙欄 38,600 on the same base", () => {
  const result = calculateJp2026({ grossMonthly: 300000, standard: 300000, dependents: null, healthRate: "9.85" });
  assert.equal(result.gensenBase, 257775);
  assert.equal(result.gensen, 38600);
});

test("hand-worked low payslip: 150,000円 gross, grade 150,000, 0人, 9.85%", () => {
  // Pension grade 9 → 13,725. Health: 150,000 × 9.85% = 14,775, half
  // exactly 7,387.5 → 50銭以下切り捨て → 7,387. Base:
  // 150,000 − 13,725 − 7,387 = 128,888 → row 12 (127,000–129,000) 0人 → 1,300.
  const result = calculateJp2026({ grossMonthly: 150000, standard: 150000, dependents: 0, healthRate: "9.85" });
  assert.equal(result.pension, 13725);
  assert.equal(result.health, 7387);
  assert.equal(result.gensenBase, 128888);
  assert.equal(result.gensen, 1300);
});

// ---------------------------------------------------------------------------
// Health 50銭 rule, both arms plus the exact boundary.
// ---------------------------------------------------------------------------

test("health half-share: exact halves, the 50銭 boundary, and above it", () => {
  assert.equal(healthHalfShare(88000, "9.85"), 4334);
  assert.equal(healthHalfShare(300000, "9.85"), 14775);
  // Full 9,801 → half 4,900.5: exactly 50銭 → 切り捨て → 4,900.
  assert.equal(healthHalfShare(100000, "9.801"), 4900);
  // Full 9,801.02 → half 4,900.51: 50銭超 → 切り上げ → 4,901.
  assert.equal(healthHalfShare(100000, "9.80102"), 4901);
  // Full 9,800.98 → half 4,900.49 → 4,900.
  assert.equal(healthHalfShare(100000, "9.80098"), 4900);
  assert.throws(() => healthHalfShare(300000, "nine"), PayrollPackError);
  assert.throws(() => healthHalfShare(300000, ""), PayrollPackError);
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
      assert.equal(lookupGensenKo(row.hi - 1, dependents), row.ko[dependents], `row ${row.n} hi-1`);
    }
    assert.equal(lookupGensenOtsu(row.lo), row.otsu, `row ${row.n} otsu lo`);
    assert.equal(lookupGensenOtsu(row.hi - 1), row.otsu, `row ${row.n} otsu hi-1`);
    // Just below lo: the previous row (or the sub-floor rules for row 1).
    if (i === 0) {
      for (let dependents = 0; dependents <= 7; dependents++) {
        assert.equal(lookupGensenKo(row.lo - 1, dependents), 0, "below row 1 is 0");
      }
      assert.equal(lookupGensenOtsu(row.lo - 1), Math.floor((row.lo - 1) * 3063 / 100000), "below row 1 is 3.063%");
    } else {
      const prev = JP_GENSEN_MONTHLY_2026[i - 1]!;
      assert.equal(prev.hi, row.lo, `rows ${prev.n}/${row.n} contiguous`);
      for (let dependents = 0; dependents <= 7; dependents++) {
        assert.equal(lookupGensenKo(row.lo - 1, dependents), prev.ko[dependents], `below row ${row.n}`);
      }
      assert.equal(lookupGensenOtsu(row.lo - 1), prev.otsu, `below row ${row.n} otsu`);
    }
  }
});

test("gensen refuses at and above 740,000円 (formula rows untranscribed)", () => {
  for (const amount of [740000, 790000, 1000000]) {
    assert.throws(() => lookupGensenKo(amount, 0), /740,000/);
    assert.throws(() => lookupGensenOtsu(amount), /740,000/);
  }
});

test("monotonicity: tax never falls as pay rises, never rises as dependents rise", () => {
  for (let dependents = 0; dependents <= 7; dependents++) {
    let prev = -1;
    for (const row of JP_GENSEN_MONTHLY_2026) {
      assert.ok(row.ko[dependents]! >= prev, `ko/${dependents} dips at row ${row.n}`);
      prev = row.ko[dependents]!;
    }
  }
  let prevOtsu = -1;
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
    const loPay = grade.lo ?? 0;
    const hiPay = grade.hi ?? grade.lo! + 100000;
    for (const pay of [loPay, Math.floor((loPay + hiPay) / 2), hiPay - 1]) {
      assert.equal(pensionGradeForPay(pay).grade, grade.grade, `pay ${pay} stays in grade ${grade.grade}`);
      assert.equal(pensionGradeForPay(pay).half, grade.half, `pay ${pay} premium invariant`);
    }
    // The step: just below the next grade's floor is still this grade.
    if (i + 1 < JP_PENSION_GRADES_2026.length) {
      const next = JP_PENSION_GRADES_2026[i + 1]!;
      assert.equal(next.lo! - 1 >= 0 ? pensionGradeForPay(next.lo! - 1).grade : grade.grade, grade.grade);
      assert.equal(pensionGradeForPay(next.lo!).grade, next.grade);
      assert.notEqual(next.half, grade.half, `grades ${grade.grade}/${next.grade} step`);
    }
  }
  // Grade 1 takes everything below 93,000; grade 32 has no ceiling.
  assert.equal(pensionGradeForPay(0).grade, 1);
  assert.equal(pensionGradeForPay(92999).grade, 1);
  assert.equal(pensionGradeForPay(635000).grade, 32);
  assert.equal(pensionGradeForPay(2000000).grade, 32);
  assert.equal(pensionGradeForPay(2000000).half, 59475);
});

test("unknown 標準報酬月額 refuses (copy it off the JPS notice)", () => {
  assert.throws(() => pensionGradeForStandard(99000), PayrollPackError);
  assert.throws(() => pensionGradeForStandard(0), PayrollPackError);
  assert.throws(() => calculateJp2026({ grossMonthly: 300000, standard: 99000, dependents: 0, healthRate: "9.85" }), PayrollPackError);
});

test("negative gensen base refuses rather than looking up a negative amount", () => {
  assert.throws(
    () => calculateJp2026({ grossMonthly: 10000, standard: 88000, dependents: 0, healthRate: "9.85" }),
    /negative/,
  );
});
