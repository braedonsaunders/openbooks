/**
 * The IT pack's jurisdictional calendars: the national festivity calendar,
 * one entry per region (`IT-<ISTAT code>`).
 *
 * Eleven paid civil and religious festivities (L. 27 maggio 1949, n. 260 as
 * amended; Lunedì dell'Angelo added by L. 5 marzo 1977, n. 54; Festa della
 * Repubblica restored by L. 20 novembre 2000, n. 336). Italy moves no
 * festivity that lands on a weekend, so every observance is `none`.
 *
 * One entry per region, all sharing the national festività: every profile
 * names its ISTAT region, so the engine resolves
 * jurisdictionKey("IT", "<code>") = "IT-<code>" and a bare "IT" key would
 * declare a calendar no employee reaches — the undeclared-jurisdiction gate
 * would then refuse every period containing a mandatory holiday (ES
 * precedent: per-region keys). Each entry's name says "festività nazionali"
 * so no reader mistakes it for the region's full calendar: regional
 * variation (local observances beyond the national list) is NOT modelled.
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
import { IT_REGIONS } from "./regions.ts";

/** The 11 national festività every region observes. Copied per entry below. */
const IT_FESTIVITA_NAZIONALI: PayrollJurisdiction["holidays"] = [
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
];

function itJurisdiction(code: string, name: string): PayrollJurisdiction {
  return {
    // The key is the profile-resolved jurisdiction, not the bare country:
    // jurisdictionKey("IT", "01") is "IT-01" (every profile names its
    // region, so the bare country never resolves). A bare "IT" key
    // declares a calendar no employee can ever reach, and the
    // undeclared-jurisdiction gate then refuses every period containing a
    // mandatory holiday. Region names come from ./regions.ts — the same
    // table pack.ts derives its region coverage from — so the two can never
    // drift apart.
    key: `IT-${code}`,
    name: `Italia (festività nazionali) — ${name}`,
    scope: "employment",
    citation:
      "L. 27 maggio 1949, n. 260; L. 5 marzo 1977, n. 54; "
      + "DPR 28 dicembre 1985, n. 792; L. 20 novembre 2000, n. 336",
    holidays: [...IT_FESTIVITA_NAZIONALI],
    holidayPay: null,
  };
}

export const IT_JURISDICTIONS: readonly PayrollJurisdiction[] = IT_REGIONS.map(
  (region) => itJurisdiction(region.code, region.name),
);
