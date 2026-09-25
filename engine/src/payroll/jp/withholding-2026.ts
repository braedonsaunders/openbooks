/**
 * The JP pack's pure 2026 calculators: NTA 月額表 lookup, pension grade
 * pricing, and social-insurance contribution arithmetic. Proven by goldens; the adapter
 * (./compute-statutory.ts) maps the generic run context onto them.
 *
 * Method (agency-stated where the agency speaks):
 * - 甲欄: the 社会保険料等控除後の給与等の金額 selects the row (以上
 *   inclusive, 未満 exclusive), the 扶養親族等の数 selects the column —
 *   NTA No.2511: 「税額表に当てはめる給与等の金額は、その月（日）分の給与
 *   等の金額から厚生年金保険料、健康保険料及び雇用保険料などの社会保険料
 *   等を控除した後の金額によります」. The engine's base deducts its computed
 *   premiums (厚生年金 + 健康保険 + effective child support); 雇用保険 is
 *   untranscribed, so the base is gross-minus-computed-premiums, not gross-minus-all
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
 * half-shares and the employer levy run on exact BigInt rationals.
 */
import { PayrollPackError } from "../payroll-error.ts";
import { JP_PENSION_GRADES_2026 } from "./pension-2026.ts";
import {
  JP_BONUS_KO_2026,
  JP_BONUS_OTSU_2026,
  JP_BONUS_RATE_DENOMINATOR,
  JP_GENSEN_MONTHLY_2026,
  type JpBonusRateBand,
} from "./tables-2026.ts";

/** The lowest 社会保険料等控除後 amount the numbered rows cover. */
export const JP_GENSEN_LOOKUP_FLOOR = 105000n;
/** Lookup domain ends here: the 加算 formula rows above are refused. */
export const JP_GENSEN_LOOKUP_CEILING = 740000n;
/** 乙欄 sub-105,000 rate: 3.063% (復興特別所得税込み). */
const OTSU_LOW_RATE_NUM = 3063n;
const OTSU_LOW_RATE_DEN = 100000n;

function fail(message: string): never {
  throw new PayrollPackError(`JP payroll 2026: ${message}`);
}

function needIntYen(value: bigint, what: string): bigint {
  if (value < 0n) {
    fail(`${what} must be a non-negative integer yen amount, got ${value}`);
  }
  return value;
}

/** The numbered row covering `amount`, or null below the floor. Refuses ≥ ceiling. */
function gensenRow(amount: bigint): (typeof JP_GENSEN_MONTHLY_2026)[number] | null {
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
export function lookupGensenKo(amountYen: bigint, dependents: number): bigint {
  if (!Number.isInteger(dependents) || dependents < 0 || dependents > 7) {
    fail(
      `扶養親族等の数 ${dependents} is outside 0–7: the table's 7人超 1,610円-per-person `
      + "subtraction is not transcribed — see JP_REFUSED_2026",
    );
  }
  const row = gensenRow(amountYen);
  if (row === null) return 0n;
  return row.ko[dependents]!;
}

/**
 * 乙欄 lookup: the row amount, or amount × 3.063% truncated below 105,000円.
 */
export function lookupGensenOtsu(amountYen: bigint): bigint {
  needIntYen(amountYen, "社会保険料等控除後の給与等の金額");
  const row = gensenRow(amountYen);
  if (row === null) {
    return (amountYen * OTSU_LOW_RATE_NUM) / OTSU_LOW_RATE_DEN;
  }
  return row.otsu;
}

/**
 * 2026 bonus withholding rate (賞与に対する源泉徴収税額の算出率の表, 令和8年分):
 * 甲 by prior-month 社会保険料等控除後 pay plus dependent count, 乙 by
 * prior-month pay alone (no declaration on file). Returns thousandths of a
 * percent — multiply the post-deduction bonus by it over
 * JP_BONUS_RATE_DENOMINATOR, fractions below one yen discarded (NTA Tax
 * Answer No.2523 worked example: 389,558円 × 2.042% = 7,954円).
 */
export function lookupBonusRate(priorMonthNetYen: bigint, dependents: number | null): bigint {
  needIntYen(priorMonthNetYen, "前月の社会保険料等控除後の給与等の金額");
  let bands: readonly JpBonusRateBand[];
  if (dependents === null) {
    bands = JP_BONUS_OTSU_2026;
  } else {
    if (!Number.isInteger(dependents) || dependents < 0 || dependents > 7) {
      fail(
        `扶養親族等の数 ${dependents} is outside 0–7: the bonus table's 7-columns stop at 7人以上 — `
        + "see JP_REFUSED_2026",
      );
    }
    bands = JP_BONUS_KO_2026[dependents]!;
  }
  const band = bands.find(
    (candidate) =>
      (candidate.fromYen === null || priorMonthNetYen >= candidate.fromYen)
      && (candidate.toYen === null || priorMonthNetYen < candidate.toYen),
  );
  if (!band) fail(`no bonus rate band covers ${priorMonthNetYen}円 — internal error, not a table gap`);
  return band.numerator;
}

export interface JpBonusWithholdingInput {
  /** Post-social-insurance bonus (賞与の金額から控除される社会保険料等控除後). */
  bonusNet: bigint;
  /**
   * Post-social-insurance prior-month regular pay (前月の社会保険料等控除後の
   * 給与等の金額, 賞与を除く). Null refuses: the rate table cannot start
   * without it (NTA Tax Answer No.2523; JP-BONUS-IMPL).
   */
  priorMonthNet: bigint | null;
  /** 甲欄 dependents 0–7, or null for 乙欄 (no declaration on file). */
  dependents: number | null;
  /** Bonus computation period in months: 6, or 12 when it exceeds 6 months. */
  periodMonths: 6 | 12;
  /**
   * Actual prior-month withholding (前月の給与に対する源泉徴収税額) — required
   * only when the bonus exceeds 10× prior-month net, where the monthly-table
   * computation subtracts it.
   */
  priorMonthWithholding: bigint | null;
  taxResidence: "resident" | "nonresident_japan_source" | "nonresident_foreign_source";
}

/**
 * 2026 bonus withholding (NTA Tax Answer No.2523): the rate-table path, the
 * 10×-prior-pay monthly-table path, and the no-prior-pay monthly-table path.
 * Every division truncates below one yen (the Answer's worked examples).
 */
export function calculateBonusWithholding(input: JpBonusWithholdingInput): bigint {
  needIntYen(input.bonusNet, "賞与の金額（社会保険料等控除後）");
  if (input.periodMonths !== 6 && input.periodMonths !== 12) {
    fail(`bonus computation period ${input.periodMonths} is not 6 or 12 months — see NTA Tax Answer No.2523`);
  }
  if (input.taxResidence === "nonresident_foreign_source") return 0n;
  if (input.taxResidence === "nonresident_japan_source") {
    return nonresidentJapanSourceWithholding(input.bonusNet);
  }
  if (input.priorMonthNet === null) {
    fail(
      "bonus withholding needs the prior month's social-insurance-deducted pay (前月の社会保険料等控除後の"
      + "給与等の金額, 賞与を除く): the 賞与に対する源泉徴収税額の算出率の表 starts from it — carry "
      + "jp_bonus_prior_month_net or price the bonus outside ordinary payroll",
    );
  }
  needIntYen(input.priorMonthNet, "前月の社会保険料等控除後の給与等の金額");
  const period = BigInt(input.periodMonths);
  const monthlyFor = (amount: bigint): bigint =>
    input.dependents === null ? lookupGensenOtsu(amount) : lookupGensenKo(amount, input.dependents);
  if (input.priorMonthNet <= 0n) {
    // No prior-month pay, or prior pay at/below its social insurance: the
    // monthly-table path (table note 備考4) — no rate row to start from.
    return monthlyFor(input.bonusNet / period) * period;
  }
  if (input.bonusNet > 10n * input.priorMonthNet) {
    if (input.priorMonthWithholding === null) {
      fail(
        "a bonus over 10× prior-month net computes through the monthly table minus actual prior-month "
        + "withholding: carry jp_bonus_prior_month_gensen (前月の給与に対する源泉徴収税額) — see NTA Tax "
        + "Answer No.2523",
      );
    }
    needIntYen(input.priorMonthWithholding, "前月の給与に対する源泉徴収税額");
    const step = monthlyFor(input.bonusNet / period + input.priorMonthNet) - input.priorMonthWithholding;
    if (step < 0n) {
      fail(
        "the 10× monthly-table step went negative (computed tax below actual prior-month withholding): "
        + "inconsistent bonus inputs — refusing rather than crediting through withholding",
      );
    }
    return step * period;
  }
  const rate = lookupBonusRate(input.priorMonthNet, input.dependents);
  return (input.bonusNet * rate) / JP_BONUS_RATE_DENOMINATOR;
}

/** The pension grade row for an operator-entered 標準報酬月額. Refuses unknown values. */
export function pensionGradeForStandard(standardYen: bigint): (typeof JP_PENSION_GRADES_2026)[number] {
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
export function pensionGradeForPay(payYen: bigint): (typeof JP_PENSION_GRADES_2026)[number] {
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
export function healthHalfShare(standardYen: bigint, ratePercent: string): bigint {
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
  return rem <= halfUnit ? yen : yen + 1n;
}

/** 2026 child-rearing support premium, half-share, on standard remuneration. */
export function childSupportHalfShare(standardYen: bigint): bigint {
  return healthHalfShare(standardYen, "0.23");
}

/** 2026 employer-only child-rearing levy at 0.36%, rounded to whole yen. */
export function childCareEmployerLevy(standardYen: bigint): bigint {
  needIntYen(standardYen, "標準報酬月額");
  return (standardYen * 36n + 5000n) / 10000n;
}

/**
 * NTA nonresident domestic-source salary withholding: 20.42% of the payment
 * amount, with fractions below one yen discarded.
 */
export function nonresidentJapanSourceWithholding(paymentYen: bigint): bigint {
  needIntYen(paymentYen, "非居住者 domestic-source salary");
  return paymentYen * 2042n / 10000n;
}

export interface Jp2026Input {
  /** Monthly gross pay (income), integer yen. */
  grossMonthly: bigint;
  /** Operator-entered 標準報酬月額: must equal a published grade value. */
  standard: bigint;
  /** 甲欄 dependents 0–7, or null for 乙欄 (no declaration on file). */
  dependents: number | null;
  /** Tenant-declared health rate in force, percent number ("9.85"). */
  healthRate: string;
  /** Whether the run's applicable insurance month is on/after 2026-04-01. */
  childContributionsEffective: boolean;
  taxResidence: "resident" | "nonresident_japan_source" | "nonresident_foreign_source";
}

export interface Jp2026Result {
  pension: bigint;
  pensionEmployer: bigint;
  health: bigint;
  healthEmployer: bigint;
  childSupport: bigint;
  childSupportEmployer: bigint;
  childCareEmployer: bigint;
  /** Applicable withholding basis: resident net pay or nonresident source pay. */
  gensenBase: bigint;
  gensen: bigint;
}

export function calculateJp2026(input: Jp2026Input): Jp2026Result {
  needIntYen(input.grossMonthly, "grossMonthly");
  const grade = pensionGradeForStandard(input.standard);
  const pension = grade.half;
  const health = healthHalfShare(input.standard, input.healthRate);
  const childSupport = input.childContributionsEffective ? childSupportHalfShare(input.standard) : 0n;
  const childSupportEmployer = childSupport;
  const childCareEmployer = input.childContributionsEffective ? childCareEmployerLevy(input.standard) : 0n;
  const residentBase = input.grossMonthly - pension - health - childSupport;
  if (input.taxResidence === "resident" && residentBase < 0n) {
    fail(
      `gensen base is negative (gross ${input.grossMonthly} − pension ${pension} − health ${health} `
      + `− child support ${childSupport}): `
      + "premiums exceed pay — refusing rather than looking up a negative amount",
    );
  }
  const gensenBase = input.taxResidence === "resident"
    ? residentBase
    : input.taxResidence === "nonresident_japan_source" ? input.grossMonthly : 0n;
  const gensen = input.taxResidence === "resident"
    ? input.dependents === null
      ? lookupGensenOtsu(gensenBase)
      : lookupGensenKo(gensenBase, input.dependents)
    : input.taxResidence === "nonresident_japan_source"
    ? nonresidentJapanSourceWithholding(gensenBase)
    : 0n;
  return {
    pension,
    pensionEmployer: pension,
    health,
    healthEmployer: health,
    childSupport,
    childSupportEmployer,
    childCareEmployer,
    gensenBase,
    gensen,
  };
}
