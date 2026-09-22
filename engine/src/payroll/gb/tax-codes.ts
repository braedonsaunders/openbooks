/**
 * GB tax-code parsing: which PAYE codes the engine operates, and the refusal
 * of every other code BY NAME.
 *
 * HMRC: "You put an employee's tax code into your payroll software to work
 * out how much tax to deduct from their pay throughout the year"
 * (https://www.gov.uk/employee-tax-codes) — the code arrives on the P6/P9
 * coding notice (see jurisdictions.ts) and is operated, never derived.
 *
 * Supported (each with its HMRC quote in the throw-free path below):
 * - 1257L cumulative (the standard code) and C1257L (Welsh alias: the Welsh
 *   bands are identical to rUK, employer rates page + Tax Tables B-D).
 * - S1257L cumulative (the Scottish standard code: the letters page prices
 *   "From income in the Scottish tax bands ... For an employee whose main
 *   home is in Scotland"), with the same W1/M1/X non-cumulative markers.
 * - 1257L with a W1, M1 or X suffix: non-cumulative — "Calculate your
 *   employee's tax only on what they are paid in the current pay period"
 *   (https://www.gov.uk/employee-tax-codes/letters). X is listed among "The
 *   emergency tax codes from 6 April 2026" (employer rates page).
 * - BR / CBR (whole pay at 20%), D0 / CD0 (whole pay at 40%), D1 / CD1
 *   (whole pay at 45%): Tax Tables B-D 2026/27 PDF ("For code BR always
 *   multiply the whole pay by 0.20 (20%) ... D0 ... 0.40 (40%) ... D1 ...
 *   0.45 (45%)", with the CBR/CD0/CD1 Welsh analogues).
 * - SBR (20% Scottish basic), SD0 (21% intermediate), SD1 (42% higher),
 *   SD2 (45% advanced), SD3 (48% top): Tax Tables B-D 2026/27 PDF p.2
 *   ("For code SBR always multiply the whole pay by 0.20 (20%) ... SD0 ...
 *   0.21 (21%) ... SD1 ... 0.42 (42%) ... SD2 ... 0.45 (45%) ... SD3 ...
 *   0.48 (48%)"), cross-checked against the letters page's Scottish
 *   basic/intermediate/higher/advanced/top rows ("For a second job or
 *   pension").
 * - 0T / C0T: all income, no allowance ("From all income - there is no
 *   Personal Allowance", letters table), operated through the bands.
 * - NT: "No tax is deducted" (letters table).
 * - K<number> / CK<number>: "Multiply the number in their tax code by 10 to
 *   show how much should be added to their taxable income" (letters page),
 *   with "The tax deduction for each pay period cannot be more than half an
 *   employee's pre-tax pay or pension" capping it.
 *
 * Refused by name: every other S-prefix code (S0T, SNT, SK-numbers, ST,
 * non-1257 S-numbers, S-marriage codes, bare S, combined SC/CS prefixes —
 * none attested on the transcribed sources, and an S code fallen through to
 * the rUK bands would be wrong money for every Scottish employee), bare
 * C/L, any other numeric suffix code (operating it needs the Tables A
 * free-pay schedule the pack has not transcribed), M and N
 * (marriage-allowance transfer codes whose adjusted allowance is not
 * transcribed here), T (HMRC-review code), J / any unrecognised shape.
 */

import { PayrollPackError } from "../payroll-error.ts";

/** A PAYE code the GB engine can operate. Amounts are decimal strings. */
export type GbTaxCode =
  | {
    kind: "suffix";
    /**
     * Annual tax-free pay the code carries ("12579" for 1257L, "0" for 0T):
     * the code number × 10 + 9, not the £12,570 Personal Allowance. HMRC
     * Tables A (Pay Adjustment Tables) embody the +9 — e.g. month-1 free pay
     * for code 1 is £1.59 (ceiling of 19/12), for code 500 £417.42
     * (ceiling of 5,009/12) — and the PAYE manual states free pay "is a
     * proportion of the employee's maximum tax allowance which is reflected
     * in the code" (PAYE70025: week 1 is 1/52, month 1 is 1/12 of it).
     * Pricing 1257L off 12,570 understates month-1 free pay by 75p
     * (£1,047.50 instead of £1,048.25).
     */
    freePayAnnual: string;
    /** Welsh C-prefix alias: identical rUK arithmetic, Welsh taxpayer. */
    welsh: boolean;
    /** Scottish S-prefix: prices through GB_SCT_BANDS, never the rUK bands. */
    scottish: boolean;
    /** W1 / M1 / X marker: current pay period only, no year to date. */
    nonCumulative: boolean;
  }
  | {
    kind: "flat";
    /** Whole-pay rate (rUK "0.20" | "0.40" | "0.45"; SCT adds the 19–48% set). */
    rate: string;
    welsh: boolean;
    /** Scottish S-prefix flat code (SBR, SD0–SD3): rate already Scottish. */
    scottish: boolean;
  }
  | { kind: "none" }
  | {
    kind: "k";
    /** Annual added pay: the code number × 10. */
    addedAnnual: string;
    welsh: boolean;
    /** K codes are never Scottish: SK-numbers are refused by name. */
    scottish: false;
    nonCumulative: boolean;
  };

const STANDARD_ALLOWANCE_NUMBER = 1257;
/**
 * The Tables-A top-up: a suffix code number covers a £10 allowance range and
 * free pay prices at the top of it (code × 10 + 9), so 1257L carries £12,579
 * of annual free pay against the £12,570 Personal Allowance. K codes take no
 * top-up (their added pay is exactly number × 10 — see the K branch below).
 */
const SUFFIX_FREE_PAY_TOP_UP = 9;

function refuse(code: string, reason: string): never {
  throw new PayrollPackError(
    `GB payroll pack cannot operate tax code "${code}": ${reason}`,
  );
}

/**
 * Parse a P6/P9 coding-notice code into an operable code, or throw naming
 * the code and the reason. Never guesses: an S-prefix code does NOT fall
 * through to the rUK bands, and an untranscribed numeric code does NOT
 * fall through to 1257L.
 */
export function parseGbTaxCode(raw: string): GbTaxCode {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!normalized) refuse(raw, "the code is blank — operate the code HMRC issued on the P6/P9 coding notice");
  const marker = normalized.match(/ ?(W1|M1|X)$/);
  const nonCumulative = marker != null;
  const body = marker ? normalized.slice(0, marker.index).trimEnd() : normalized;

  let scottish = false;
  let welsh = false;
  let rest = body;
  if (rest.startsWith("S")) {
    scottish = true;
    rest = rest.slice(1);
  }
  if (rest.startsWith("C")) {
    welsh = true;
    rest = rest.slice(1);
  }
  if (scottish && welsh) {
    refuse(raw, "HMRC never combines the Scottish S prefix with the Welsh C prefix — "
      + "refused by name as a malformed code, never priced against either table");
  }
  if (scottish) return parseScottishCode(raw, rest, nonCumulative);

  if (rest === "BR" || rest === "D0" || rest === "D1") {
    if (nonCumulative) refuse(raw, "flat-rate codes price the whole period already — HMRC never issues them with a W1/M1/X marker");
    if (rest === "BR") return { kind: "flat", rate: "0.20", welsh, scottish: false };
    if (rest === "D0") return { kind: "flat", rate: "0.40", welsh, scottish: false };
    return { kind: "flat", rate: "0.45", welsh, scottish: false };
  }
  if (rest === "0T") {
    return { kind: "suffix", freePayAnnual: "0", welsh, scottish: false, nonCumulative };
  }
  if (rest === "NT") {
    if (nonCumulative) refuse(raw, "NT carries no W1/M1/X marker — it already deducts nothing");
    return { kind: "none" };
  }
  if (rest === "T") {
    refuse(raw, "T codes are under HMRC review with the employee — there is no operable allowance");
  }

  const k = rest.match(/^K(\d+)$/);
  if (k) {
    const number = Number(k[1]);
    if (!Number.isSafeInteger(number) || number <= 0) refuse(raw, "a K code carries a positive number");
    return { kind: "k", addedAnnual: String(number * 10), welsh, scottish: false, nonCumulative };
  }

  const suffix = rest.match(/^(\d+)([LMN])$/);
  if (suffix) {
    const number = Number(suffix[1]);
    const letter = suffix[2];
    if (letter === "M" || letter === "N") {
      refuse(raw, "marriage-allowance transfer codes adjust the allowance by an amount this pack "
        + "has not transcribed — refused by name");
    }
    if (number !== STANDARD_ALLOWANCE_NUMBER) {
      refuse(raw, `only the standard ${STANDARD_ALLOWANCE_NUMBER}L (and 0T) suffix codes are `
        + "transcribed — any other numeric code needs the Tables A free-pay schedule, which this "
        + "pack has not transcribed");
    }
    return {
      kind: "suffix",
      freePayAnnual: String(number * 10 + SUFFIX_FREE_PAY_TOP_UP),
      welsh, scottish: false, nonCumulative,
    };
  }

  return refuse(raw, "unrecognised code shape — operate only codes HMRC documents at "
    + "https://www.gov.uk/employee-tax-codes/letters");
}

/**
 * Parse the body of an S-prefix (Scottish taxpayer) code, after the S is
 * stripped. The transcribed Scottish set is S1257L (suffix, same £12,570
 * reserved allowance as rUK) and the five Tables-B flat codes SBR/SD0–SD3 —
 * everything else S-prefixed is refused BY NAME, never fallen through to
 * the rUK bands (which would be wrong money for every Scottish employee).
 */
function parseScottishCode(raw: string, rest: string, nonCumulative: boolean): GbTaxCode {
  if (!rest || rest === "S") {
    refuse(raw, "a bare S is not a code — operate the full S-prefix code HMRC issued "
      + "(S1257L, SBR, SD0, SD1, SD2, SD3)");
  }
  // Tables-B flat codes: Tax Tables B-D 2026/27 PDF p.2 quotes each rate.
  const flatRate = rest === "BR" ? "0.20"
    : rest === "D0" ? "0.21"
    : rest === "D1" ? "0.42"
    : rest === "D2" ? "0.45"
    : rest === "D3" ? "0.48"
    : null;
  if (flatRate != null) {
    if (nonCumulative) refuse(raw, "flat-rate codes price the whole period already — HMRC never issues them with a W1/M1/X marker");
    return { kind: "flat", rate: flatRate, welsh: false, scottish: true };
  }
  if (rest === "0T") {
    refuse(raw, "S0T is refused by name — the transcribed Scottish set is S1257L, SBR, SD0, "
      + "SD1, SD2 and SD3 (Tax Tables B-D 2026/27 pp.2–3); S0T is not attested there");
  }
  if (rest === "NT") {
    refuse(raw, "SNT is refused by name — the transcribed Scottish set is S1257L, SBR, SD0, "
      + "SD1, SD2 and SD3; SNT is not attested on the transcribed sources");
  }
  if (rest === "T") {
    refuse(raw, "ST codes are under HMRC review with the employee — there is no operable allowance");
  }
  const k = rest.match(/^K(\d+)$/);
  if (k) {
    refuse(raw, "SK-numbers are refused by name — K-code added pay through the Scottish bands "
      + "is not attested on the transcribed sources (Tax Tables B-D 2026/27 pp.2–3)");
  }
  const suffix = rest.match(/^(\d+)([LMN])$/);
  if (suffix) {
    const number = Number(suffix[1]);
    const letter = suffix[2];
    if (letter === "M" || letter === "N") {
      refuse(raw, "Scottish marriage-allowance transfer codes adjust the allowance by an amount "
        + "this pack has not transcribed — refused by name");
    }
    if (number !== STANDARD_ALLOWANCE_NUMBER) {
      refuse(raw, `only the standard S${STANDARD_ALLOWANCE_NUMBER}L suffix code is transcribed — `
        + "any other Scottish numeric code needs the Tables A free-pay schedule, which this "
        + "pack has not transcribed");
    }
    return {
      kind: "suffix",
      freePayAnnual: String(number * 10 + SUFFIX_FREE_PAY_TOP_UP),
      welsh: false, scottish: true, nonCumulative,
    };
  }
  return refuse(raw, "unrecognised Scottish code shape — the transcribed S-prefix set is S1257L "
    + "(with optional W1/M1/X), SBR, SD0, SD1, SD2 and SD3 "
    + "(https://www.gov.uk/employee-tax-codes/letters)");
}
