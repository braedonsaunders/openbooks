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
 * - 1257L with a W1, M1 or X suffix: non-cumulative — "Calculate your
 *   employee's tax only on what they are paid in the current pay period"
 *   (https://www.gov.uk/employee-tax-codes/letters). X is listed among "The
 *   emergency tax codes from 6 April 2026" (employer rates page).
 * - BR / CBR (whole pay at 20%), D0 / CD0 (whole pay at 40%), D1 / CD1
 *   (whole pay at 45%): Tax Tables B-D 2026/27 PDF ("For code BR always
 *   multiply the whole pay by 0.20 (20%) ... D0 ... 0.40 (40%) ... D1 ...
 *   0.45 (45%)", with the CBR/CD0/CD1 Welsh analogues).
 * - 0T / C0T: all income, no allowance ("From all income - there is no
 *   Personal Allowance", letters table), operated through the bands.
 * - NT: "No tax is deducted" (letters table).
 * - K<number> / CK<number>: "Multiply the number in their tax code by 10 to
 *   show how much should be added to their taxable income" (letters page),
 *   with "The tax deduction for each pay period cannot be more than half an
 *   employee's pre-tax pay or pension" capping it.
 *
 * Refused by name: S-prefix everything (Scotland has its own bands — SCT is
 * not supported), bare S/C/L, any other numeric suffix code (operating it
 * needs the Tables A free-pay schedule the pack has not transcribed), M and
 * N (marriage-allowance transfer codes whose adjusted allowance is not
 * transcribed here), T (HMRC-review code), J / any unrecognised shape.
 */

import { PayrollPackError } from "../packs.ts";

/** A PAYE code the GB engine can operate. Amounts are decimal strings. */
export type GbTaxCode =
  | {
    kind: "suffix";
    /** Annual tax-free pay the code carries ("12570" or "0" for 0T). */
    allowanceAnnual: string;
    /** Welsh C-prefix alias: identical rUK arithmetic, Welsh taxpayer. */
    welsh: boolean;
    /** W1 / M1 / X marker: current pay period only, no year to date. */
    nonCumulative: boolean;
  }
  | {
    kind: "flat";
    /** Whole-pay rate ("0.20" | "0.40" | "0.45"). */
    rate: string;
    welsh: boolean;
  }
  | { kind: "none" }
  | {
    kind: "k";
    /** Annual added pay: the code number × 10. */
    addedAnnual: string;
    welsh: boolean;
    nonCumulative: boolean;
  };

const STANDARD_ALLOWANCE_NUMBER = 1257;
const STANDARD_ALLOWANCE_ANNUAL = "12570";

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

  let welsh = false;
  let rest = body;
  if (rest.startsWith("C")) {
    welsh = true;
    rest = rest.slice(1);
  }
  if (rest.startsWith("S") || body.startsWith("S")) {
    refuse(raw, "Scottish codes price against Scotland's own bands, which this pack has not "
      + "transcribed — SCT is refused by name (see GB_REGIONS)");
  }

  if (rest === "BR" || rest === "D0" || rest === "D1") {
    if (nonCumulative) refuse(raw, "flat-rate codes price the whole period already — HMRC never issues them with a W1/M1/X marker");
    if (rest === "BR") return { kind: "flat", rate: "0.20", welsh };
    if (rest === "D0") return { kind: "flat", rate: "0.40", welsh };
    return { kind: "flat", rate: "0.45", welsh };
  }
  if (rest === "0T") {
    return { kind: "suffix", allowanceAnnual: "0", welsh, nonCumulative };
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
    return { kind: "k", addedAnnual: String(number * 10), welsh, nonCumulative };
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
    return { kind: "suffix", allowanceAnnual: STANDARD_ALLOWANCE_ANNUAL, welsh, nonCumulative };
  }

  return refuse(raw, "unrecognised code shape — operate only codes HMRC documents at "
    + "https://www.gov.uk/employee-tax-codes/letters");
}
