/**
 * Transcribed Commonwealth legislation for the AU 2026–27 financial year
 * (1 July 2026 – 30 June 2027, `taxYear: 2027`).
 *
 * Every figure below is quoted from the authority's own text on the Federal
 * Register of Legislation (legislation.gov.au, HTTP 200). Nothing here comes
 * from the ATO website: every ato.gov.au rates page probed from this network
 * vantage returns HTTP 403 from the Akamai edge ("Access Denied", EdgeSuite
 * reference 18.2624c317), including the PAYG Schedule 1 statement of formulas
 * (published 17 June 2026), the tax-tables overview, and the individual
 * income-tax rates page. The 403 is an edge deny, not a WAF challenge, not a
 * JS-only SPA, and not a 200-with-a-challenge-body. ato.gov.au content is
 * therefore NOT transcribed and NOT cited.
 *
 * What this means for withholding: the ATO's coefficient-based PAYG formulas
 * (scales 1, 2, 5, 6 with a/b coefficients) are refused by name — their
 * coefficients cannot be quoted from this vantage. The engine in
 * ./compute-statutory.ts annualises period pay and applies the legislated
 * annual liability below, then divides back to the period. That is the
 * statute's liability arithmetic, not the ATO's withholding scales, and the
 * pack stays `installable: false` until the Schedule 1 coefficients and an
 * ATO worked example can be quoted.
 *
 * Money discipline: figures are decimal STRINGS, never floats. The engine
 * consumes them with the repo's bigint-unit helpers (see canada/decimal.ts).
 */

import { PayrollPackError } from "../packs.ts";

/** One marginal band: (from, upTo] taxed at `rate`. `upTo: null` is open. */
export interface AuMarginalBand {
  readonly from: string;
  readonly upTo: string | null;
  readonly rate: string;
}

/**
 * Resident bands — Income Tax Rates Act 1986, Schedule 7, Part I, clause 1,
 * Compilation C2026C00300 (in force 1 July 2026, amended by the Income Tax
 * Rates Amendment (Tax Reform No. 1) Act 2026):
 *
 * "Tax rates for resident taxpayers for the 2026‑27 year of income: Item 1:
 * exceeds the tax‑free threshold but does not exceed $45,000 — 15%; Item 2:
 * exceeds $45,000 but does not exceed $135,000 — 30%; Item 3: exceeds
 * $135,000 but does not exceed $190,000 — 37%; Item 4: exceeds $190,000 —
 * 45%."
 *
 * The tax‑free threshold is $18,200: "tax‑free threshold means $18,200"
 * (section 3, same compilation).
 */
export const AU_RESIDENT_BANDS_2027: readonly AuMarginalBand[] = [
  { from: "18200", upTo: "45000", rate: "0.15" },
  { from: "45000", upTo: "135000", rate: "0.30" },
  { from: "135000", upTo: "190000", rate: "0.37" },
  { from: "190000", upTo: null, rate: "0.45" },
];

/**
 * Foreign-resident bands — same Act, Schedule 7, Part II, clause 1:
 *
 * "Tax rates for non‑resident taxpayers for the 2024‑25 year of income or a
 * later year of income: Item 1: does not exceed $135,000 — The second
 * resident personal tax rate; Item 2: exceeds $135,000 but does not exceed
 * $190,000 — The third resident personal tax rate; Item 3: exceeds $190,000
 * — 45%."
 *
 * The second resident personal tax rate is item 2 of the resident table
 * (30%) and the third is item 3 (37%) — "second resident personal tax rate
 * means the rate mentioned in item 2 of the table in clause 1 of Part I of
 * Schedule 7" (section 3). No tax-free threshold applies.
 */
export const AU_NONRESIDENT_BANDS_2027: readonly AuMarginalBand[] = [
  { from: "0", upTo: "135000", rate: "0.30" },
  { from: "135000", upTo: "190000", rate: "0.37" },
  { from: "190000", upTo: null, rate: "0.45" },
];

/**
 * Working-holiday-maker bands — same Act, Schedule 7, Part III, clause 1:
 *
 * "Tax rates for working holiday makers for the 2024‑25 year of income or a
 * later year of income: Item 1: does not exceed $45,000 — 15%; Item 2:
 * exceeds $45,000 but does not exceed $135,000 — 30%; Item 3: exceeds
 * $135,000 but does not exceed $190,000 — 37%; Item 4: exceeds $190,000 —
 * 45%."
 */
export const AU_WHM_BANDS_2027: readonly AuMarginalBand[] = [
  { from: "0", upTo: "45000", rate: "0.15" },
  { from: "45000", upTo: "135000", rate: "0.30" },
  { from: "135000", upTo: "190000", rate: "0.37" },
  { from: "190000", upTo: null, rate: "0.45" },
];

/**
 * Medicare levy — Medicare Levy Act 1986, Compilation C2026C00295 (in force
 * 1 July 2026). Section 6(1): "The rate of levy payable by a person upon a
 * taxable income is 2%."
 *
 * Low-income shade (section 7): "(1) Where the taxable income of a person
 * does not exceed the threshold amount, no levy is payable … (2) Where the
 * taxable income … exceeds the threshold amount but does not exceed the
 * phase‑in limit, the amount of levy payable … shall not exceed 10% of the
 * amount of the excess."
 *
 * Section 3 definitions (any other case): "threshold amount means … (c) in
 * any other case—$28,011" and "phase‑in limit means … (c) in any other
 * case—$35,013." The section-160AAAA rebate figures ($44,268 / $55,335) are
 * for pension/benefit rebate recipients and are not modelled: the TFN
 * declaration carries no such question, so the engine refuses them by name.
 *
 * Family reduction (section 8, family income threshold $47,238 plus $4,338
 * per dependant child) needs spouse income and dependant counts the TFN
 * declaration does not carry, so it is refused by name in the engine.
 */
export const AU_MEDICARE_2027 = {
  rate: "0.02",
  threshold: "28011",
  phaseInLimit: "35013",
  shadeRate: "0.10",
} as const;

/**
 * Superannuation Guarantee — Superannuation Guarantee (Administration) Act
 * 1992, Compilation C2026C00272 (in force 1 July 2026). Section 17A(2): "On
 * the QE day, the employer has an individual superannuation guarantee amount
 * for the employee equal to [amount of the qualifying earnings ×
 * charge percentage / 100] … charge percentage means 12."
 *
 * Maximum contributions base (section 10A(5)): "The maximum contributions
 * base, for a payment of qualifying earnings to or for an employee, is the
 * following amount (rounded down to the nearest multiple of $10):
 * [concessional contributions cap × 100 / charge percentage] where …
 * concessional contributions cap is the basic concessional contributions cap
 * (within the meaning of the Income Tax Assessment Act 1997) for the
 * financial year in which the payment is made."
 *
 * The 2026–27 concessional-cap dollar figure is REFUSED by name: ITAA 1997
 * s292-20 states the mechanism ($25,000 for 2017–18, indexed annually under
 * Subdivision 960-M) but the indexed 2026–27 figure is not stated in the Act
 * and the ATO page that publishes it 403s. The formula above is transcribed;
 * the engine accrues 12% without the annual cap and names the gap.
 */
export const AU_SUPER_2027 = {
  chargeRate: "0.12",
  maxBaseNumerator: "100",
} as const;

/**
 * HELP/STSL repayment — Higher Education Support Act 2003, Compilation
 * C2026C00297 (in force 1 July 2026), as indexed by
 * Gazette C2026G00249 ("Notification of the minimum repayment income and
 * replacement indexable amount for … the 2026-27 income year").
 *
 * Section 154-10: "The minimum repayment income for an income year is
 * $67,000. Note: The minimum repayment income is indexed under section
 * 154‑25." Gazette 154-10 row: "The minimum repayment income for the
 * 2026-27 income year is $69,528". Gazette 154-20 row: "The replacement
 * indexable amount mentioned in paragraphs 154‑20(2)(a) and (b) for the
 * 2026-27 income year is $129,717".
 *
 * Section 154-20(2): "(a) 15% of the part of the person's repayment income
 * that exceeds the minimum repayment income but does not exceed $125,000;
 * (b) 17% of the part … that exceeds $125,000", capped by 154-20(1)(b) at
 * "10% of the person's repayment income" (and by the repayable debt, which
 * the pack cannot see and refuses by name).
 *
 * Section 154-1(2): "A person is not liable under this section to pay an
 * amount for an income year if, under section 8 of the Medicare Levy Act
 * 1986: (a) no Medicare levy is payable … or (b) the amount of the Medicare
 * levy payable … is reduced." The engine zeroes HELP whenever Medicare is
 * exempt or shaded.
 *
 * Repayment income (154-5) is taxable income plus net investment losses,
 * reportable fringe benefits, exempt foreign income and reportable super
 * contributions — none of which the pack sees — so the engine uses taxable
 * income as the repayment-income proxy and says so.
 */
export const AU_HELP_2027 = {
  minimumIncome: "69528",
  secondBandCap: "129717",
  firstRate: "0.15",
  secondRate: "0.17",
  incomeCapRate: "0.10",
} as const;

/** PAYG is federal: no state publishes its own tables. */
export const AU_FY2027_START = "2026-07-01";
export const AU_FY2027_END = "2027-06-30";

/**
 * Edition resolution in the Canada harness shape: a pay date inside FY
 * 2026–27 resolves to the transcribed 2027 tables; any other pay date
 * THROWS. Never extrapolate, never clamp — a pack that computes 2028 pay
 * from 2026/27 tables is silent wrong money. FY 2025–26 (taxYear 2026)
 * throws naming the year: it is still an untranscribed draft.
 */
export function auTablesForPayDate(payDate: string): { readonly taxYear: 2027 } {
  if (payDate >= AU_FY2027_START && payDate <= AU_FY2027_END) {
    return { taxYear: 2027 };
  }
  throw new PayrollPackError(
    `AU has no transcribed PAYG tables for pay date ${payDate}: the only `
    + `transcribed edition covers ${AU_FY2027_START} to ${AU_FY2027_END} `
    + "(2026–27, taxYear 2027). Transcribe the year's legislation before calculating",
  );
}

/**
 * Named refusals: every ATO scale, surcharge, and cap this file does not
 * transcribe, with the reason. The engine quotes these names back.
 */
export const AU_REFUSED_2027: readonly string[] = [
  "ATO PAYG withholding scales 1, 2, 5 and 6 (a/b coefficients unquotable: ato.gov.au 403s from this vantage)",
  "Medicare levy surcharge tiers 1–3 (thresholds live in the Private Health Insurance Act 2007 and liability turns on daily private patient hospital cover the pack cannot see)",
  "Medicare levy family reduction s8 (needs spouse income and dependant counts not on the TFN declaration)",
  "Medicare levy section-160AAAA rebate thresholds (no such question on the TFN declaration)",
  "Superannuation maximum contributions base dollar figure (2026–27 concessional-cap input unquotable; formula transcribed)",
  "HELP repayable-debt cap (the employee's accumulated HELP debt is not visible to the pack)",
  "No-TFN withholding rate (Taxation Administration Act Schedule 1 is on the same 403ing host)",
  "State payroll tax (employer-aggregate state levy, not PAYG — out of scope, not a region of this pack)",
];
