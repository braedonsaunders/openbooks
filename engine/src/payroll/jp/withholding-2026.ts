/**
 * The JP pack's pure 2026 calculators: NTA 月額表 lookup, pension grade
 * pricing, and health half-share arithmetic. Proven by goldens; the adapter
 * (./compute-statutory.ts) maps the generic run context onto them.
 *
 * Method (agency-stated where the agency speaks):
 * - 甲欄: the 社会保険料等控除後の給与等の金額 selects the row (以上
 *   inclusive, 未満 exclusive), the 扶養親族等の数 selects the column —
 *   NTA No.2511: 「税額表に当てはめる給与等の金額は、その月（日）分の給与
 *   等の金額から厚生年金保険料、健康保険料及び雇用保険料などの社会保険料
 *   等を控除した後の金額によります」. The engine's base deducts the two
 *   premiums it computes (厚生年金 + 健康保険); 雇用保険 is untranscribed,
 *   so the base is stated gross-minus-two, not true gross-minus-three
 *   (see JP_REFUSED_2026 — a named gap, never a guessed deduction).
 * - 105,000円未満: every 甲 column is 0 (the table's first row).
 * - 乙欄 below 105,000円: 「その月の社会保険料等控除後の給与等の金額の
 *   3.063%に相当する金額」, with 「1円未満の端数は切り捨てます」
 *   (月額表の求め方 worked example: 80,750円 → 2,473円).
 * - 740,000円 and above: the table switches to 加算 formula rows
 *   (20.42%/23.483%/33.693%/40.84%/45.945%) — NOT transcribed, refused by
 *   name. The lookup domain is [0, 740,000).
 * - 扶養親族等の数 above 7: the table's 1,610円-per-person subtraction is
 *   NOT transcribed, refused by name. Domain is 0–7.
 * - Pension: the 標準報酬月額 arrives as an operator-entered fact from the
 *   JPS notice and must equal one of the 32 published grade values; the
 *   premium is the table's 折半額, both shares (折半).
 * - Health: 標準報酬月額 × tenant rate, halved per the 協会けんぽ 料額表
 *   rule (quoted on the official kyoukaikenpo.or.jp Tokyo table):
 *   「被保険者負担分（表の折半額の欄）に円未満の端数がある場合 ①事業主
 *   が、給与から被保険者負担分を控除する場合、被保険者負担分の端数が50
 *   銭以下の場合は切り捨て、50銭を超える場合は切り上げて1円となります」
 *   (payroll deducts, so arm ① governs).
 *
 * Money: integer yen in, integer yen out. No floats anywhere — the health
 * half-share runs on exact BigInt rationals.
 */
import { PayrollPackError } from "../payroll-error.ts";
import { JP_PENSION_GRADES_2026 } from "./pension-2026.ts";
import { JP_GENSEN_MONTHLY_2026 } from "./tables-2026.ts";

/** The lowest 社会保険料等控除後 amount the numbered rows cover. */
export const JP_GENSEN_LOOKUP_FLOOR = 105000;
/** Lookup domain ends here: the 加算 formula rows above are refused. */
export const JP_GENSEN_LOOKUP_CEILING = 740000;
/** 乙欄 sub-105,000 rate: 3.063% (復興特別所得税込み). */
const OTSU_LOW_RATE_NUM = 3063n;
const OTSU_LOW_RATE_DEN = 100000n;

function fail(message: string): never {
  throw new PayrollPackError(`JP payroll 2026: ${message}`);
}

function needIntYen(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${what} must be a non-negative integer yen amount, got ${value}`);
  }
  return value;
}

/** The numbered row covering `amount`, or null below the floor. Refuses ≥ ceiling. */
function gensenRow(amount: number): (typeof JP_GENSEN_MONTHLY_2026)[number] | null {
  needIntYen(amount, "社会保険料等控除後の給与等の金額");
  if (amount >= JP_GENSEN_LOOKUP_CEILING) {
    fail(
      `社会保険料等控除後の給与等の金額 ${amount}円 is 740,000円 or more: the table's 加算 formula `
      + "rows (20.42%/23.483%/33.693%/40.84%/45.945%) are not transcribed — see JP_REFUSED_2026",
    );
  }
  if (amount < JP_GENSEN_LOOKUP_FLOOR) return null;
  const row = JP_GENSEN_MONTHLY_2026.find((candidate) => amount >= candidate.lo && amount < candidate.hi);
  if (!row) fail(`no 月額表 row covers ${amount}円 — internal error, not a table gap`);
  return row;
}

/**
 * 甲欄 lookup: row by 社会保険料等控除後の給与等の金額, column by
 * 扶養親族等の数 (0–7). Below 105,000円 every column is 0.
 */
export function lookupGensenKo(amountYen: number, dependents: number): number {
  if (!Number.isInteger(dependents) || dependents < 0 || dependents > 7) {
    fail(
      `扶養親族等の数 ${dependents} is outside 0–7: the table's 7人超 1,610円-per-person `
      + "subtraction is not transcribed — see JP_REFUSED_2026",
    );
  }
  const row = gensenRow(amountYen);
  if (row === null) return 0;
  return row.ko[dependents]!;
}

/**
 * 乙欄 lookup: the row amount, or amount × 3.063% truncated below 105,000円.
 */
export function lookupGensenOtsu(amountYen: number): number {
  needIntYen(amountYen, "社会保険料等控除後の給与等の金額");
  const row = gensenRow(amountYen);
  if (row === null) {
    return Number((BigInt(amountYen) * OTSU_LOW_RATE_NUM) / OTSU_LOW_RATE_DEN);
  }
  return row.otsu;
}

/** The pension grade row for an operator-entered 標準報酬月額. Refuses unknown values. */
export function pensionGradeForStandard(standardYen: number): (typeof JP_PENSION_GRADES_2026)[number] {
  needIntYen(standardYen, "標準報酬月額");
  const grade = JP_PENSION_GRADES_2026.find((candidate) => candidate.standard === standardYen);
  if (!grade) {
    fail(
      `標準報酬月額 ${standardYen}円 matches no 厚生年金 grade (32 published values, `
      + "88,000–650,000円): copy the grade off the JPS notice — see JP_REFUSED_2026 on 定時決定/随時改定",
    );
  }
  return grade;
}

/**
 * Map actual monthly pay to its pension grade (the table's STEP function:
 * 報酬月額 range → 等級). Total: every non-negative pay lands in exactly
 * one grade; grade 32 has no ceiling. Used by the boundary sweeps; the
 * adapter takes the operator-entered 標準報酬月額, never this.
 */
export function pensionGradeForPay(payYen: number): (typeof JP_PENSION_GRADES_2026)[number] {
  needIntYen(payYen, "報酬月額");
  const grade = JP_PENSION_GRADES_2026.find(
    (candidate) =>
      (candidate.lo === null || payYen >= candidate.lo)
      && (candidate.hi === null || payYen < candidate.hi),
  );
  if (!grade) fail(`no pension grade covers 報酬月額 ${payYen}円 — internal error, not a table gap`);
  return grade;
}

/**
 * One health half-share in yen: 標準報酬月額 × rate ÷ 2, with the 協会けんぽ
 * 50銭 rule (50銭以下切り捨て, 50銭超切り上げ). Exact BigInt rationals —
 * `ratePercent` is a percent number ("9.85" for 9.85%).
 */
export function healthHalfShare(standardYen: number, ratePercent: string): number {
  needIntYen(standardYen, "標準報酬月額");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(ratePercent.trim());
  if (!match) fail(`health rate "${ratePercent}" is not a percent number (9.85 for 9.85%)`);
  const digits = (match[1] ?? "") + (match[2] ?? "");
  const decimals = (match[2] ?? "").length;
  // half premium in sen (1/100 yen): standard × p/q ÷ 2 × 100 = standard × p / (2q).
  const num = BigInt(standardYen) * BigInt(digits);
  const den = 2n * 10n ** BigInt(decimals);
  // Yen and the fractional remainder, in units of 1/(100·den) yen… reduce:
  // yen = num div (100·den), remainder r (of 100·den); 50銭 = half of 100·den.
  const unit = 100n * den;
  const yen = num / unit;
  const rem = num % unit;
  const halfUnit = unit / 2n;
  return Number(rem <= halfUnit ? yen : yen + 1n);
}

export interface Jp2026Input {
  /** Monthly gross pay (income), integer yen. */
  grossMonthly: number;
  /** Operator-entered 標準報酬月額: must equal a published grade value. */
  standard: number;
  /** 甲欄 dependents 0–7, or null for 乙欄 (no declaration on file). */
  dependents: number | null;
  /** Tenant-declared health rate in force, percent number ("9.85"). */
  healthRate: string;
}

export interface Jp2026Result {
  pension: number;
  pensionEmployer: number;
  health: number;
  healthEmployer: number;
  /** gross − pension − health: the 月額表 input (雇用保険 gap stated above). */
  gensenBase: number;
  gensen: number;
}

export function calculateJp2026(input: Jp2026Input): Jp2026Result {
  needIntYen(input.grossMonthly, "grossMonthly");
  const grade = pensionGradeForStandard(input.standard);
  const pension = grade.half;
  const health = healthHalfShare(input.standard, input.healthRate);
  const gensenBase = input.grossMonthly - pension - health;
  if (gensenBase < 0) {
    fail(
      `gensen base is negative (gross ${input.grossMonthly} − pension ${pension} − health ${health}): `
      + "premiums exceed pay — refusing rather than looking up a negative amount",
    );
  }
  const gensen = input.dependents === null
    ? lookupGensenOtsu(gensenBase)
    : lookupGensenKo(gensenBase, input.dependents);
  return { pension, pensionEmployer: pension, health, healthEmployer: health, gensenBase, gensen };
}
