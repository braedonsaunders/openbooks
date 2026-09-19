/**
 * The PL pack's employment calendar: the statutory days off.
 *
 * Ustawa z dnia 18 stycznia 1951 r. o dniach wolnych od pracy names the
 * dni wolne: 1 stycznia, 6 stycznia (Trzech Króli), Easter Sunday and
 * Easter Monday, 1 maja, 3 maja, Boże Ciało (Corpus Christi, the Thursday
 * 60 days after Easter), 15 sierpnia, 1 listopada, 11 listopada,
 * 25 and 26 grudnia. Holiday pay is undeclared (null): no computation is
 * transcribed.
 */
import type { PayrollCountryPack } from "../packs.ts";

const PL_NATIONAL_HOLIDAYS: PayrollCountryPack["jurisdictions"][number]["holidays"] = [
  { key: "pl_new_year", name: "Nowy Rok (1 stycznia)", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
  { key: "pl_epiphany", name: "Trzech Króli (6 stycznia)", rule: { kind: "fixed", month: 1, day: 6 }, observance: "none" },
  { key: "pl_easter_sunday", name: "Wielkanoc (niedziela)", rule: { kind: "easter_offset", days: 0 }, observance: "none" },
  { key: "pl_easter_monday", name: "Poniedziałek Wielkanocny", rule: { kind: "easter_offset", days: 1 }, observance: "none" },
  { key: "pl_labour_day", name: "Święto Pracy (1 maja)", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
  { key: "pl_constitution_day", name: "Święto Konstytucji 3 Maja", rule: { kind: "fixed", month: 5, day: 3 }, observance: "none" },
  { key: "pl_corpus_christi", name: "Boże Ciało", rule: { kind: "easter_offset", days: 60 }, observance: "none" },
  { key: "pl_assumption", name: "Wniebowzięcie NMP (15 sierpnia)", rule: { kind: "fixed", month: 8, day: 15 }, observance: "none" },
  { key: "pl_all_saints", name: "Wszystkich Świętych (1 listopada)", rule: { kind: "fixed", month: 11, day: 1 }, observance: "none" },
  { key: "pl_independence_day", name: "Narodowe Święto Niepodległości (11 listopada)", rule: { kind: "fixed", month: 11, day: 11 }, observance: "none" },
  { key: "pl_christmas", name: "Boże Narodzenie (25 grudnia)", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
  { key: "pl_boxing_day", name: "Drugi dzień Świąt (26 grudnia)", rule: { kind: "fixed", month: 12, day: 26 }, observance: "none" },
];

export const PL_JURISDICTIONS: PayrollCountryPack["jurisdictions"] = [
  {
    key: "PL",
    name: "Polska",
    scope: "employment",
    citation: "Ustawa z dnia 18 stycznia 1951 r. o dniach wolnych od pracy (dni wolne od pracy)",
    holidays: PL_NATIONAL_HOLIDAYS,
    holidayPay: null,
  },
];
