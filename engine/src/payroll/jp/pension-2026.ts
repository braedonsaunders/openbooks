/**
 * Transcribed 2026 pension tables for the JP payroll pack: the Japan Pension
 * Service 厚生年金保険料額表 (32 standard-remuneration grades, 令和8年度版).
 *
 * Source: 日本年金機構 「保険料額表（令和2年9月分～）（厚生年金保険と協会
 * けんぽ管掌の健康保険）」 page
 * (https://www.nenkin.go.jp/service/kounen/hokenryo/ryogaku/ryogakuhyo/index.html,
 * HTTP 200, 24,273 bytes, fetched 2026-09-18), file
 * 「一般・坑内員・船員の被保険者の方（令和8年度版）（エクセル 20KB)」
 * (20200825.files/R08ryougaku.xlsx, sheet 料額表), titled
 * 「○令和2年9月分（10月納付分）からの厚生年金保険料額表（令和8年度版)」.
 * The 32 rows below are that sheet verbatim: 等級, 標準報酬月額, 報酬月額
 * range (円以上/円未満), 全額 and 折半額 at 18.3%/9.15%.
 *
 * Operative texts quoted from the same sheet:
 * - Rate: 「厚生年金保険料率（平成29年9月1日～ 適用）
 *   一般・坑内員・船員の被保険者等 …18.300％」; the sheet's 折半額 column
 *   header is 9.15. Every 折半額 below equals 標準報酬月額 × 9.15% exactly
 *   (all grades are multiples of 1,000円, so no fraction arises on these
 *   rows — but the rule still governs computed halves, see
 *   withholding-2026.ts).
 * - Employee-share fractions (給与控除): 「被保険者負担分（厚生年金保険料額
 *   表の折半額）に円未満の端数がある場合 ①事業主が、給与から被保険者負担
 *   分を控除する場合、被保険者負担分の端数が50銭以下の場合は切り捨て、
 *   50銭を超える場合は切り上げて1円となります。」 (Cash payment reverses
 *   the 50銭 boundary; payroll deducts, so arm ① governs. 特約 overrides
 *   both — refused: no special-agreement channel.)
 * - Top grade: 「令和2年9月分（10月納付分）から、厚生年金保険の標準報酬月
 *   額の上限（32等級）が650千円となりました。」 Grade 32 covers 635,000円
 *   以上 with no upper bound — pay above it still prices at 650,000円.
 * - 子ども・子育て拠出金 (employer-only, 0.36% from 令和8年4月分):
 *   「子ども・子育て拠出金については事業主が全額負担することとなります。」
 *   The statutory slot and 2026 effective month are carried by the pack.
 * - Health: 「全国健康保険協会管掌健康保険の都道府県別の保険料率について
 *   は、全国健康保険協会の各都道府県支部にお問い合わせください。」 — the
 *   JPS table carries no health rate, which is why the health premium is a
 *   tenant-declared rate per prefecture (see ./pack.ts for why prefecture
 *   is the regions axis).
 *
 * Money: integer yen. 標準報酬月額 values are whole yen; 折半額 values are
 * whole yen as published.
 */

/** One 厚生年金 grade: monthly remuneration range maps to a standard amount. */
export interface JpPensionGrade {
  readonly grade: number;
  /** 標準報酬月額 — the amount the premium prices off. */
  readonly standard: bigint;
  /** 報酬月額 lower bound inclusive; null on grade 1 (everything below). */
  readonly lo: bigint | null;
  /** 報酬月額 upper bound exclusive; null on grade 32 (no ceiling). */
  readonly hi: bigint | null;
  /** Full monthly premium (労使合算), yen. */
  readonly full: bigint;
  /** Each half share (折半額), yen — employee and employer pay the same. */
  readonly half: bigint;
}

export const JP_PENSION_GRADES_2026: readonly JpPensionGrade[] = [
  { grade: 1, standard: 88000n, lo: null, hi: 93000n, full: 16104n, half: 8052n },
  { grade: 2, standard: 98000n, lo: 93000n, hi: 101000n, full: 17934n, half: 8967n },
  { grade: 3, standard: 104000n, lo: 101000n, hi: 107000n, full: 19032n, half: 9516n },
  { grade: 4, standard: 110000n, lo: 107000n, hi: 114000n, full: 20130n, half: 10065n },
  { grade: 5, standard: 118000n, lo: 114000n, hi: 122000n, full: 21594n, half: 10797n },
  { grade: 6, standard: 126000n, lo: 122000n, hi: 130000n, full: 23058n, half: 11529n },
  { grade: 7, standard: 134000n, lo: 130000n, hi: 138000n, full: 24522n, half: 12261n },
  { grade: 8, standard: 142000n, lo: 138000n, hi: 146000n, full: 25986n, half: 12993n },
  { grade: 9, standard: 150000n, lo: 146000n, hi: 155000n, full: 27450n, half: 13725n },
  { grade: 10, standard: 160000n, lo: 155000n, hi: 165000n, full: 29280n, half: 14640n },
  { grade: 11, standard: 170000n, lo: 165000n, hi: 175000n, full: 31110n, half: 15555n },
  { grade: 12, standard: 180000n, lo: 175000n, hi: 185000n, full: 32940n, half: 16470n },
  { grade: 13, standard: 190000n, lo: 185000n, hi: 195000n, full: 34770n, half: 17385n },
  { grade: 14, standard: 200000n, lo: 195000n, hi: 210000n, full: 36600n, half: 18300n },
  { grade: 15, standard: 220000n, lo: 210000n, hi: 230000n, full: 40260n, half: 20130n },
  { grade: 16, standard: 240000n, lo: 230000n, hi: 250000n, full: 43920n, half: 21960n },
  { grade: 17, standard: 260000n, lo: 250000n, hi: 270000n, full: 47580n, half: 23790n },
  { grade: 18, standard: 280000n, lo: 270000n, hi: 290000n, full: 51240n, half: 25620n },
  { grade: 19, standard: 300000n, lo: 290000n, hi: 310000n, full: 54900n, half: 27450n },
  { grade: 20, standard: 320000n, lo: 310000n, hi: 330000n, full: 58560n, half: 29280n },
  { grade: 21, standard: 340000n, lo: 330000n, hi: 350000n, full: 62220n, half: 31110n },
  { grade: 22, standard: 360000n, lo: 350000n, hi: 370000n, full: 65880n, half: 32940n },
  { grade: 23, standard: 380000n, lo: 370000n, hi: 395000n, full: 69540n, half: 34770n },
  { grade: 24, standard: 410000n, lo: 395000n, hi: 425000n, full: 75030n, half: 37515n },
  { grade: 25, standard: 440000n, lo: 425000n, hi: 455000n, full: 80520n, half: 40260n },
  { grade: 26, standard: 470000n, lo: 455000n, hi: 485000n, full: 86010n, half: 43005n },
  { grade: 27, standard: 500000n, lo: 485000n, hi: 515000n, full: 91500n, half: 45750n },
  { grade: 28, standard: 530000n, lo: 515000n, hi: 545000n, full: 96990n, half: 48495n },
  { grade: 29, standard: 560000n, lo: 545000n, hi: 575000n, full: 102480n, half: 51240n },
  { grade: 30, standard: 590000n, lo: 575000n, hi: 605000n, full: 107970n, half: 53985n },
  { grade: 31, standard: 620000n, lo: 605000n, hi: 635000n, full: 113460n, half: 56730n },
  { grade: 32, standard: 650000n, lo: 635000n, hi: null, full: 118950n, half: 59475n },
];

/** The 2026 pension rate both shares price off: 18.300% total, 9.15% each. */
export const JP_PENSION_RATE_2026 = "0.183";
export const JP_PENSION_HALF_RATE_2026 = "0.0915";
