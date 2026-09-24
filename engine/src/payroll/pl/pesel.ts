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
 * The 11th digit is a checksum over the first ten digits, with weights
 * 1-3-7-9 repeating (Rozporządzenie Ministra Spraw Wewnętrznych z 4 stycznia
 * 2012 r., §7). The embedded date must also be a real Gregorian date; neither
 * a valid shape nor a valid checksum makes 30 February a birth date.
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

function encodedBirthDate(pesel: string): { year: number; month: number; day: number } | null {
  const encodedYear = Number(pesel.slice(0, 2));
  const encodedMonth = Number(pesel.slice(2, 4));
  const century = centuryForMonth(encodedMonth);
  if (century === null) return null;
  const month = encodedMonth >= 81 ? encodedMonth - 80
    : encodedMonth >= 21 ? encodedMonth - 20
    : encodedMonth;
  const day = Number(pesel.slice(4, 6));
  const year = century + encodedYear;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (monthLengths[month - 1] ?? 0)) return null;
  return { year, month, day };
}

/** Check the statutory date encoding and control digit of a PESEL. */
export function isValidPesel(pesel: string | null | undefined): pesel is string {
  if (typeof pesel !== "string" || !/^\d{11}$/.test(pesel)) return false;
  if (encodedBirthDate(pesel) === null) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const;
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) {
    sum += Number(pesel[i]) * weights[i]!;
  }
  const remainder = sum % 10;
  const checkDigit = remainder === 0 ? 0 : 10 - remainder;
  return Number(pesel[10]) === checkDigit;
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
  if (!isValidPesel(pesel)) return null;
  return encodedBirthDate(pesel)!.year;
}
