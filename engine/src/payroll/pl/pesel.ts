/**
 * Reading a birth year off a PESEL — the derivation behind the PL
 * `pl_rok_urodzenia` profile fact.
 *
 * A PESEL's first six digits are YYMMDD with the century encoded in the
 * MONTH digits (ustawa z dnia 24 września 2010 r. o ewidencji ludności,
 * art. 15 ust. 2 pkt 1–2, Dz.U. 2018 poz. 1382: "miesiąc urodzenia wraz z
 * zakodowanym stuleciem urodzenia", coded by adding to the month number
 * 80 for 1800–1899, 0 for 1900–1999, 20 for 2000–2099). The consolidated
 * act text states exactly those three bands — no 2100s/2200s band is cited
 * there — so a month code outside 01–12, 21–32 and 81–92 derives NOTHING:
 * an uncited band is refused (unknown), never guessed into a century.
 * The day digits are not validated here: the identifier declaration already
 * judges the PESEL's shape at save time, and the year derivation needs only
 * the year digits and the century band.
 *
 * Pure. No database, no registry: the profiles API and the pack's
 * derivation hook both read through this.
 */

/** A PESEL month code that carries no cited century: derivation is unknown. */
function centuryForMonth(month: number): number | null {
  if (month >= 1 && month <= 12) return 1900;
  if (month >= 21 && month <= 32) return 2000;
  if (month >= 81 && month <= 92) return 1800;
  return null;
}

/**
 * The birth year encoded in a PESEL's first six digits (YYMMDD with the
 * century in the month digits), or null when the value is not an 11-digit
 * PESEL or its month code carries no cited century band. Null is "cannot
 * derive" — the declared birth-year field then stands alone, which is the
 * case for employees without a PESEL (foreign workers on NIP/passport)
 * and for month codes this module does not cite.
 */
export function peselBirthYear(pesel: string | null | undefined): number | null {
  if (typeof pesel !== "string" || !/^\d{11}$/.test(pesel)) return null;
  const year = Number(pesel.slice(0, 2));
  const month = Number(pesel.slice(2, 4));
  const century = centuryForMonth(month);
  if (century === null) return null;
  return century + year;
}
