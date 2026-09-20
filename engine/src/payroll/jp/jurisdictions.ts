/**
 * The JP pack's holiday calendars: the 国民の祝日 (national holidays),
 * one entry per prefecture (`JP-<JIS code>`).
 *
 * 国民の祝日に関する法律 (Act No. 178 of 1948) art. 2 lists sixteen days.
 * Fourteen are declared here with computed rules. Two are NOT — 春分の日
 * and 秋分の日 fall on the astronomical equinox as announced each year in
 * the 官報 (art. 2's 春分日/秋分日 columns), so no fixed/nth-weekday/easter
 * rule expresses them and a hardcoded date would go wrong silently the
 * first year the equinox shifts. They stay undeclared until a rule kind can
 * name 官報 dates.
 *
 * One entry per prefecture, all sharing the national holidays: every
 * profile names its JIS prefecture, so the engine resolves
 * jurisdictionKey("JP", "<code>") = "JP-<code>" and a bare "JP" key would
 * declare a calendar no employee reaches — the undeclared-jurisdiction gate
 * would then refuse every period containing a mandatory holiday (ES
 * precedent: per-region keys). Prefectural variation beyond the national
 * list is NOT modelled: the 国民の祝日 are national law, identical in every
 * prefecture.
 *
 * `observance: "none"`: the art. 3 振替休日 (substitute holiday) shifts the
 * DAY OFF, not the holiday — the entitlement still attaches to the real
 * date, so the calendar carries the real date the way the CA pack does.
 *
 * `holidayPay` is null: the statute grants the day off with no pay formula
 * of its own (pay for the day lives in 就業規則/賃金規程, untranscribed). A
 * PLACEHOLDER average-day lookback would COMPUTE a number nobody sourced.
 * Null refuses until a sourced formula lands — same posture as IT and ES.
 */
import type { PayrollJurisdiction } from "../packs.ts";
import { JP_PREFECTURES } from "./regions.ts";

/** The 14 national holidays every prefecture observes. Copied per entry below. */
const JP_KOKUMIN_NO_SHUKUJITSU: PayrollJurisdiction["holidays"] = [
  { key: "ganjitsu", name: "元日", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
  { key: "seijin_no_hi", name: "成人の日", rule: { kind: "nth_weekday", month: 1, weekday: 1, nth: 2 }, observance: "none" },
  { key: "kenkoku_kinen_no_hi", name: "建国記念の日", rule: { kind: "fixed", month: 2, day: 11 }, observance: "none" },
  { key: "tenno_tanjobi", name: "天皇誕生日", rule: { kind: "fixed", month: 2, day: 23 }, observance: "none" },
  { key: "showa_no_hi", name: "昭和の日", rule: { kind: "fixed", month: 4, day: 29 }, observance: "none" },
  { key: "kenpo_kinenbi", name: "憲法記念日", rule: { kind: "fixed", month: 5, day: 3 }, observance: "none" },
  { key: "midori_no_hi", name: "みどりの日", rule: { kind: "fixed", month: 5, day: 4 }, observance: "none" },
  { key: "kodomo_no_hi", name: "こどもの日", rule: { kind: "fixed", month: 5, day: 5 }, observance: "none" },
  { key: "umi_no_hi", name: "海の日", rule: { kind: "nth_weekday", month: 7, weekday: 1, nth: 3 }, observance: "none" },
  { key: "yama_no_hi", name: "山の日", rule: { kind: "fixed", month: 8, day: 11 }, observance: "none" },
  { key: "keiro_no_hi", name: "敬老の日", rule: { kind: "nth_weekday", month: 9, weekday: 1, nth: 3 }, observance: "none" },
  { key: "sports_no_hi", name: "スポーツの日", rule: { kind: "nth_weekday", month: 10, weekday: 1, nth: 2 }, observance: "none" },
  { key: "bunka_no_hi", name: "文化の日", rule: { kind: "fixed", month: 11, day: 3 }, observance: "none" },
  { key: "kinro_kansha_no_hi", name: "勤労感謝の日", rule: { kind: "fixed", month: 11, day: 23 }, observance: "none" },
];

function jpJurisdiction(code: string, name: string): PayrollJurisdiction {
  return {
    // The key is the profile-resolved jurisdiction, not the bare country:
    // jurisdictionKey("JP", "13") is "JP-13" (every profile names its
    // prefecture, so the bare country never resolves). A bare "JP" key
    // declares a calendar no employee can ever reach, and the
    // undeclared-jurisdiction gate then refuses every period containing a
    // mandatory holiday. Prefecture names come from ./regions.ts — the same
    // table pack.ts derives its region coverage from — so the two can never
    // drift apart.
    key: `JP-${code}`,
    name: `日本 (国民の祝日) — ${name}`,
    scope: "employment",
    citation:
      "国民の祝日に関する法律 (昭和23年法律第178号) 第2条; "
      + "春分の日・秋分の日は官報公告のため未転記",
    holidays: [...JP_KOKUMIN_NO_SHUKUJITSU],
    holidayPay: null,
  };
}

export const JP_JURISDICTIONS: readonly PayrollJurisdiction[] = JP_PREFECTURES.map(
  (prefecture) => jpJurisdiction(prefecture.code, prefecture.name),
);
