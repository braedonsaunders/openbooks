/**
 * The IT pack's jurisdictional calendar: the national festivity calendar.
 *
 * Eleven paid civil and religious festivities (L. 27 maggio 1949, n. 260 as
 * amended; Lunedì dell'Angelo added by L. 5 marzo 1977, n. 54; Festa della
 * Repubblica restored by L. 20 novembre 2000, n. 336). Italy moves no
 * festivity that lands on a weekend, so every observance is `none`.
 *
 * Deliberately absent: the festa del santo patrono (DPR 28 dicembre 1985,
 * n. 792) — one per comune, ~7,900 of them, unknowable to a national pack
 * and refused by omission until a per-comune channel exists.
 *
 * `holidayPay` is null: festivities are paid by law and CCNL, but no single
 * statutory formula is transcribed here (monthly absorption, 1/26 for daily
 * pay, CCNL supplements differ), and declaring one formula would state the
 * wrong pay for everyone on a different contract.
 */
import type { PayrollJurisdiction } from "../packs.ts";

export const IT_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "IT",
    name: "Italia",
    scope: "employment",
    citation:
      "L. 27 maggio 1949, n. 260; L. 5 marzo 1977, n. 54; "
      + "DPR 28 dicembre 1985, n. 792; L. 20 novembre 2000, n. 336",
    holidays: [
      { key: "capodanno", name: "Capodanno", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
      { key: "epifania", name: "Epifania", rule: { kind: "fixed", month: 1, day: 6 }, observance: "none" },
      { key: "lunedi_angelo", name: "Lunedì dell'Angelo", rule: { kind: "easter_offset", days: 1 }, observance: "none" },
      { key: "liberazione", name: "Anniversario della Liberazione", rule: { kind: "fixed", month: 4, day: 25 }, observance: "none" },
      { key: "lavoro", name: "Festa del Lavoro", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
      { key: "repubblica", name: "Festa della Repubblica", rule: { kind: "fixed", month: 6, day: 2 }, observance: "none" },
      { key: "ferragosto", name: "Ferragosto (Assunzione)", rule: { kind: "fixed", month: 8, day: 15 }, observance: "none" },
      { key: "ognissanti", name: "Ognissanti", rule: { kind: "fixed", month: 11, day: 1 }, observance: "none" },
      { key: "immacolata", name: "Immacolata Concezione", rule: { kind: "fixed", month: 12, day: 8 }, observance: "none" },
      { key: "natale", name: "Natale", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
      { key: "santo_stefano", name: "Santo Stefano", rule: { kind: "fixed", month: 12, day: 26 }, observance: "none" },
    ],
    holidayPay: null,
  },
];
