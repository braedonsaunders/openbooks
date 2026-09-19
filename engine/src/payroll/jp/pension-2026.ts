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
 * - 子ども・子育て拠出金 (employer-only, 0.36% from 令和8年4月1日):
 *   「子ども・子育て拠出金については事業主が全額負担することとなります。」
 *   Round one refuses it by name (see JP_REFUSED_2026): no employer-levy
 *   slot is declared for it.
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
  readonly standard: number;
  /** 報酬月額 lower bound inclusive; null on grade 1 (everything below). */
  readonly lo: number | null;
  /** 報酬月額 upper bound exclusive; null on grade 32 (no ceiling). */
  readonly hi: number | null;
  /** Full monthly premium (労使合算), yen. */
  readonly full: number;
  /** Each half share (折半額), yen — employee and employer pay the same. */
  readonly half: number;
}

export const JP_PENSION_GRADES_2026: readonly JpPensionGrade[] = [
  { grade: 1, standard: 88000, lo: null, hi: 93000, full: 16104, half: 8052 },
  { grade: 2, standard: 98000, lo: 93000, hi: 101000, full: 17934, half: 8967 },
  { grade: 3, standard: 104000, lo: 101000, hi: 107000, full: 19032, half: 9516 },
  { grade: 4, standard: 110000, lo: 107000, hi: 114000, full: 20130, half: 10065 },
  { grade: 5, standard: 118000, lo: 114000, hi: 122000, full: 21594, half: 10797 },
  { grade: 6, standard: 126000, lo: 122000, hi: 130000, full: 23058, half: 11529 },
  { grade: 7, standard: 134000, lo: 130000, hi: 138000, full: 24522, half: 12261 },
  { grade: 8, standard: 142000, lo: 138000, hi: 146000, full: 25986, half: 12993 },
  { grade: 9, standard: 150000, lo: 146000, hi: 155000, full: 27450, half: 13725 },
  { grade: 10, standard: 160000, lo: 155000, hi: 165000, full: 29280, half: 14640 },
  { grade: 11, standard: 170000, lo: 165000, hi: 175000, full: 31110, half: 15555 },
  { grade: 12, standard: 180000, lo: 175000, hi: 185000, full: 32940, half: 16470 },
  { grade: 13, standard: 190000, lo: 185000, hi: 195000, full: 34770, half: 17385 },
  { grade: 14, standard: 200000, lo: 195000, hi: 210000, full: 36600, half: 18300 },
  { grade: 15, standard: 220000, lo: 210000, hi: 230000, full: 40260, half: 20130 },
  { grade: 16, standard: 240000, lo: 230000, hi: 250000, full: 43920, half: 21960 },
  { grade: 17, standard: 260000, lo: 250000, hi: 270000, full: 47580, half: 23790 },
  { grade: 18, standard: 280000, lo: 270000, hi: 290000, full: 51240, half: 25620 },
  { grade: 19, standard: 300000, lo: 290000, hi: 310000, full: 54900, half: 27450 },
  { grade: 20, standard: 320000, lo: 310000, hi: 330000, full: 58560, half: 29280 },
  { grade: 21, standard: 340000, lo: 330000, hi: 350000, full: 62220, half: 31110 },
  { grade: 22, standard: 360000, lo: 350000, hi: 370000, full: 65880, half: 32940 },
  { grade: 23, standard: 380000, lo: 370000, hi: 395000, full: 69540, half: 34770 },
  { grade: 24, standard: 410000, lo: 395000, hi: 425000, full: 75030, half: 37515 },
  { grade: 25, standard: 440000, lo: 425000, hi: 455000, full: 80520, half: 40260 },
  { grade: 26, standard: 470000, lo: 455000, hi: 485000, full: 86010, half: 43005 },
  { grade: 27, standard: 500000, lo: 485000, hi: 515000, full: 91500, half: 45750 },
  { grade: 28, standard: 530000, lo: 515000, hi: 545000, full: 96990, half: 48495 },
  { grade: 29, standard: 560000, lo: 545000, hi: 575000, full: 102480, half: 51240 },
  { grade: 30, standard: 590000, lo: 575000, hi: 605000, full: 107970, half: 53985 },
  { grade: 31, standard: 620000, lo: 605000, hi: 635000, full: 113460, half: 56730 },
  { grade: 32, standard: 650000, lo: 635000, hi: null, full: 118950, half: 59475 },
];

/** The 2026 pension rate both shares price off: 18.300% total, 9.15% each. */
export const JP_PENSION_RATE_2026 = "0.183";
export const JP_PENSION_HALF_RATE_2026 = "0.0915";
