/**
 * Ireland 2026 statutory tables — TRANSCRIBED from the agencies, not invented.
 *
 * Tax year: calendar 2026 (Ireland runs the calendar year). Two editions,
 * because the DSP's PRSI Roadmap step takes effect mid-year; PAYE and USC are
 * unchanged all year:
 * - edition "2026-jan" covers pay dates 2026-01-01..2026-09-30,
 * - edition "2026-oct" covers pay dates 2026-10-01..2026-12-31.
 * `ratesForPayDate` throws for any pay date outside 2026: calculating 2027
 * with 2026 constants would be silent wrong money.
 *
 * SOURCES (all fetched September 2026; HTTP 200 with real content):
 *
 * PAYE — Revenue "Tax rates, bands and reliefs" chart
 * (https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx,
 * published 01 January 2026):
 * - "Single or widowed or surviving civil partner, without qualifying
 *   children — €44,000 @ 20%, balance @ 40%"
 * - "Married or in a civil partnership (one spouse or civil partner with
 *   income) — €53,000 @ 20%, balance @ 40%"
 * - "Single Person — 2,000"; "Married Person or Civil Partner — 4,000";
 *   "Employee PAYE Tax Credit — 2,000"; "Home Carer's Tax Credit (max.) —
 *   1,950" (2026 column in each case).
 * Method — Revenue "How your Income Tax is calculated"
 * (…/calculating-your-income-tax/how-income-tax-is-calculated.aspx):
 * - "applying the standard rate of 20% to the income in your weekly rate
 *   band", "applying the higher rate of 40% to any income above your weekly
 *   rate band", "deducting the amount of your weekly tax credits from this
 *   total."
 * - "Tax credits reduce the amount of tax you pay." (…/tax-credits.aspx)
 * - "Taxable pay is the amount of your gross pay less any ordinary
 *   contributions made by you." (same page)
 *
 * USC — Revenue "Standard rates and thresholds of USC"
 * (…/usc/standard-rates-thresholds.aspx, published 01 January 2026):
 * - "Standard rates and thresholds of USC for 2026 — First €12,012 0.5% /
 *   Next €16,688 2% / Next €41,344 3% / Balance 8%"
 * Exemption — Revenue "Payments and income exempt from USC"
 * (…/usc/exempt-payments-income.aspx):
 * - "Your income will be exempt from USC if it is less than the exemption
 *   limit. The exemption limit for 2026 is €13,000."
 * - "If your income is greater than the exemption limit (€13,000 in 2026),
 *   you pay USC on your full income." (…/usc/calculating-usc.aspx — a cliff:
 *   no marginal relief, the whole income becomes chargeable.)
 * Reduced USC ("The reduced rates for 2026 are: 0.5% on the first €12,012
 * and 2% on the balance", …/usc/reduced-rates.aspx, for 70+/medical-card
 * under €60,000) is NOT transcribed: the engine has no qualifying-status
 * input and must not guess it — see compute.ts.
 *
 * PRSI Class A — Department of Social Protection "PRSI Class A Rates"
 * (https://www.gov.ie/en/department-of-social-protection/publications/prsi-class-a-rates/,
 * last updated 10 June 2026):
 * - "Class A up until 30 September 2026": A0 "€38 - €352 … Nil … 9.00",
 *   AX "€352.01 - €424 … 4.20 … 9.00", AL "€424.01 - €552 … 4.20 … 9.00",
 *   A1 "More than €552 … 4.20 … 11.25".
 * - "Class A from 1 October 2026": A0 "Nil … 9.15", AX "4.35 … 9.15",
 *   AL "4.35 … 9.15", A1 "4.35 … 11.40".
 * - "(**)A tapered employee PRSI Credit of €12 per week applies on earnings
 *   between €352.01 and €424".
 * PRSI credit formula — DSP "PRSI Contribution Rates and User Guide (SW14),
 * January 2026" (assets.gov.ie):
 * - "At gross weekly earnings of €352.01 the maximum PRSI Credit of €12 per
 *   week applies. For earnings between €352.01 and €424, the maximum weekly
 *   PRSI Credit of €12 is reduced by one sixth of earnings in excess of
 *   €352.01. Once earnings exceed €424 the PRSI credit no longer applies."
 * - "Class A employee PRSI is calculated at 4.2% until 30 September 2026
 *   (4.35% from 1 October 2026) of gross weekly earnings."
 * - "There is no PRSI relief on pension contributions made by private sector
 *   employees." (Advance Notice 2026) — pension deductions never reduce the
 *   PRSI base.
 * - "There is no annual earnings ceiling for PRSI for employees." (same)
 * Mid-year step — DSP "Advance Notice effective from 1 October 2026"
 * (assets.gov.ie, June 2026):
 * - "The Class A employee rate of 4.2% will increase by 0.15% to 4.35%."
 * - "The Class A employer rates of 9.00% and 11.25% will increase by 0.15%
 *   to 9.15% and 11.40% respectively."
 * - "These increases were agreed by Government as part of the PRSI Roadmap
 *   and are not Budget measures." / "There is no change to the employee
 *   PRSI Credit."
 * January boundary — DSP "Advance Notice 2026":
 * - "9.0% Class A rate of employer PRSI is being increased from €527 to
 *   €552 per week from 1 January 2026."
 * Fortnightly/monthly bands for payroll software (mid-year notice, "Income
 * bands and subclasses"): AX "Fortnightly €704.01 to €848 / Monthly
 * €1,525.01 to €1,837"; AL "Fortnightly €848.01 to €1,104 / Monthly
 * €1,837.01 to €2,392"; A1 "Fortnightly more than €1,104 / Monthly more
 * than €2,392"; A0 "Fortnightly €76 to €704 / Monthly €165 to €1,525".
 * PRSI is week-one (non-cumulative) — DSP "PRSI Employer Guide 2026":
 * - "PRSI for employed contributors, Classes A, B, C, D, E, H and J, is
 *   charged on a 'week-one' or non-cumulative basis. This means that the
 *   calculation of PRSI is based on the amount paid to an employee for a
 *   particular week only and does not take account of payments made in
 *   respect of any other period."
 * - "If an employee is paid on a fortnightly or monthly basis, the PRSI
 *   charge is calculated on the amount paid to the employee in respect of
 *   each week worked during that fortnight or month."
 *
 * FETCH HONESTY (sourcing rules): revenue.ie pages returned HTTP 200 with
 * real content. gov.ie content pages returned 403 without a session cookie
 * (homepage 200; publications listing 302→200 with session but JS-rendered
 * list) — reached via the gov.ie sitemap instead, then HTTP 200 with
 * session cookie. assets.gov.ie PDFs HTTP 200. welfare.ie timed out
 * (000, connection never established). Four guessed revenue.ie sub-URLs
 * returned HTTP 200 with a "404 - Page not found" body (recorded, not
 * cited). No vendor, law-firm, OECD or other-ERP source is cited anywhere.
 */
export interface IeUscBand {
  /** Width of the band in euro; null for the top balance band. */
  readonly width: string | null;
  /** Rate as a decimal fraction string (e.g. "0.005"). */
  readonly rate: string;
}

export interface IePrsiBands {
  /** A0 upper edge (employee Nil at or below). */
  readonly a0Max: string;
  /** AX band lower/upper edges (credit band). */
  readonly axMin: string;
  readonly axMax: string;
  /** AL band upper edge (employer lower rate at or below). */
  readonly alMax: string;
}

export interface IePrsiPeriodBands {
  readonly weekly: IePrsiBands;
  /** Fortnightly equivalents published for payroll software. */
  readonly fortnightly: IePrsiBands;
  /** Monthly equivalents published for payroll software. */
  readonly monthly: IePrsiBands;
}

export interface IeEditionRates {
  /** "2026-jan" (pay dates up to 2026-09-30) or "2026-oct" (from 2026-10-01). */
  readonly edition: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  // PAYE (unchanged all 2026; repeated per edition so each edition is whole)
  readonly payeStandardRate: string;
  readonly payeHigherRate: string;
  // USC standard bands + exemption floor (unchanged all 2026)
  readonly uscBands: readonly IeUscBand[];
  readonly uscExemption: string;
  // PRSI Class A
  readonly prsiEmployeeRate: string;
  readonly prsiEmployerLowerRate: string;
  readonly prsiEmployerHigherRate: string;
  /** Maximum weekly PRSI Credit (AX band). Unchanged by the October step. */
  readonly prsiCreditMax: string;
  /** Weekly earnings above which the full credit applies baseline sits. */
  readonly prsiCreditBase: string;
}

const PAYE_STANDARD_RATE = "0.20";
const PAYE_HIGHER_RATE = "0.40";

const USC_BANDS_2026: readonly IeUscBand[] = [
  { width: "12012", rate: "0.005" },
  { width: "16688", rate: "0.02" },
  { width: "41344", rate: "0.03" },
  { width: null, rate: "0.08" },
];
const USC_EXEMPTION_2026 = "13000";

const PRSI_PERIOD_BANDS: IePrsiPeriodBands = {
  weekly: { a0Max: "352", axMin: "352.01", axMax: "424", alMax: "552" },
  fortnightly: { a0Max: "704", axMin: "704.01", axMax: "848", alMax: "1104" },
  monthly: { a0Max: "1525", axMin: "1525.01", axMax: "1837", alMax: "2392" },
};

/** Standard single-person figures for reference (the RPN carries the actuals). */
export const IE_2026_SINGLE_BAND = "44000";
export const IE_2026_SINGLE_CREDIT = "2000";
export const IE_2026_EMPLOYEE_CREDIT = "2000";
/** Married one-income figures for reference. */
export const IE_2026_MARRIED_BAND = "53000";
export const IE_2026_MARRIED_CREDIT = "4000";

const RATES_2026_JAN: IeEditionRates = {
  edition: "2026-jan",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-09-30",
  payeStandardRate: PAYE_STANDARD_RATE,
  payeHigherRate: PAYE_HIGHER_RATE,
  uscBands: USC_BANDS_2026,
  uscExemption: USC_EXEMPTION_2026,
  prsiEmployeeRate: "0.042",
  prsiEmployerLowerRate: "0.09",
  prsiEmployerHigherRate: "0.1125",
  prsiCreditMax: "12",
  prsiCreditBase: "352.01",
};

const RATES_2026_OCT: IeEditionRates = {
  edition: "2026-oct",
  effectiveFrom: "2026-10-01",
  effectiveTo: "2026-12-31",
  payeStandardRate: PAYE_STANDARD_RATE,
  payeHigherRate: PAYE_HIGHER_RATE,
  uscBands: USC_BANDS_2026,
  uscExemption: USC_EXEMPTION_2026,
  prsiEmployeeRate: "0.0435",
  prsiEmployerLowerRate: "0.0915",
  prsiEmployerHigherRate: "0.114",
  prsiCreditMax: "12",
  prsiCreditBase: "352.01",
};

/**
 * Resolve the 2026 edition for a pay date. Throws for any date outside
 * 2026-01-01..2026-12-31 — never extrapolate, never clamp to the nearest
 * table. Ireland's tax year is the calendar year.
 */
export function ratesForPayDate(payDate: string): IeEditionRates {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new Error(`IE payroll: pay date is not an ISO date: "${payDate}"`);
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new Error(
      `IE payroll: no transcribed tables for pay date ${payDate} — 2026 only`,
    );
  }
  return payDate < "2026-10-01" ? RATES_2026_JAN : RATES_2026_OCT;
}

export function prsiPeriodBands(): IePrsiPeriodBands {
  return PRSI_PERIOD_BANDS;
}
