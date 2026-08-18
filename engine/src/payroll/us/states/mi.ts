/**
 * Michigan withholding — the state income tax and the city income taxes.
 *
 * Sources (fetched from michigan.gov via the Internet Archive, because
 * michigan.gov refuses automated requests, not from memory):
 *   Form 446 (Rev. 02-26), 2026 Michigan Income Tax Withholding Guide —
 *     "Withholding Rate: 4.25%  Personal Exemption Amount: $5,900"; the
 *     computation rule; the six reciprocal states; the nonresidency
 *     certificate; the MI-W4 rules.
 *   Form 5469 (Rev. 05-25), 2026 City of Detroit Income Tax Withholding Guide —
 *     the 2.4%/1.2% rates, the $600 exemption and its printed per-period
 *     table, the worked example, the bonus rule, and the two-city rule.
 *   Form MI-W4 (Rev. 12-20) — the certificate's own lines.
 *   Michigan City Income Tax Act, MCL 141.501 et seq. — the closed list of
 *     cities that may levy, and the 2:1 resident/nonresident rate structure.
 *
 * ---------------------------------------------------------------------------
 * Why Michigan is in this wave
 * ---------------------------------------------------------------------------
 * It stresses the sub-region layer from the opposite direction to Ohio. Ohio's
 * problem is COUNT — several hundred municipalities nobody can enumerate.
 * Michigan's list is CLOSED: the City Income Tax Act admits exactly the
 * twenty-four cities that levy, and no more may join without the legislature.
 * A closed list changes the honest answer to an unknown locality: in Ohio it is
 * "the employer must supply the rate"; in Michigan it is "that is not a
 * Michigan taxing city", refused by name, because the pack can know.
 *
 * Michigan also has the one sub-region settlement rule the resolution layer
 * cannot express. Form 5469: "When a resident is employed at a job in a city
 * other than the City of Detroit and the other city levies an income tax, the
 * employer must withhold separately for BOTH … Compute the City of Detroit
 * withholding rate by SUBTRACTING the other city's nonresident tax rate from
 * 2.4%." That is neither `both` (which would withhold Detroit's full 2.4% on
 * top of the work city's rate and over-withhold every commuter) nor
 * `higher_rate`. The region declares `both`, which is Michigan's own word for
 * how many levies apply, and the REDUCTION is applied here by
 * `miResidentCityRate` — with the work city's rate passed in explicitly,
 * because a rate the caller did not supply is refused rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * A note on what is NOT here
 * ---------------------------------------------------------------------------
 * Michigan enacted deductions for tip and overtime income for tax years
 * 2026–2028. Form 446 (Rev. 02-26) — issued after that law — prescribes
 * withholding at 4.25% of compensation after the exemption allowance and
 * prescribes no separate treatment for either, so this engine applies none. If
 * Treasury issues withholding guidance, it is transcribed here; it is not
 * anticipated.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateCount, certificateFlag } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/mi.ts";

export interface MiYearRates {
  year: number;
  status: "published" | "draft";
  /** Form 446's masthead: "Withholding Rate: 4.25%". */
  rate: string;
  /** Form 446's masthead: "Personal Exemption Amount: $5,900". */
  personalExemption: string;
  detroit: {
    residentRate: string;
    nonresidentRate: string;
    /** Form 5469: "Each exemption is valued at $600.00 per year." */
    exemptionPerYear: string;
    /** Form 5469's printed per-period table, keyed by periods per year. */
    printedExemption: Readonly<Record<number, string>>;
  };
}

export const MI_RATES_2026: MiYearRates = {
  year: 2026,
  status: "published",
  rate: "0.0425",
  personalExemption: "5900",
  detroit: {
    residentRate: "0.024",
    nonresidentRate: "0.012",
    exemptionPerYear: "600",
    // Weekly $11.54, bi-weekly $23.08, semi-monthly $25.00, monthly $50.00,
    // per diem/daily $1.64. The daily figure is $600 ÷ 365, NOT ÷ 260 — which
    // is why a 260-period payroll is refused rather than mapped onto "daily".
    printedExemption: {
      52: "11.54", 26: "23.08", 24: "25.00", 12: "50.00", 365: "1.64",
    },
  },
};

const MI_EDITIONS_BY_YEAR: Record<number, MiYearRates> = {
  [MI_RATES_2026.year]: MI_RATES_2026,
};

export const MI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Form 446 (Rev. 02-26); Detroit Form 5469 (Rev. 05-25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Michigan Department of Treasury, Form 446 (Rev. 02-26) 2026 Michigan Income Tax Withholding "
    + "Guide — rate 4.25%, personal exemption $5,900; Form 5469 (Rev. 05-25) 2026 City of Detroit "
    + "Income Tax Withholding Guide — 2.4% resident, 1.2% nonresident, $600 exemption",
  status: "published",
  region: "MI",
}];

export function miRatesForPayDate(payDate: string): MiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MI_WITHHOLDING, year);
  }
  return rates;
}

function periodsGuard(periodsPerYear: number): void {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 2000) {
    throw new Error(`invalid pay periods per year for Michigan withholding: ${periodsPerYear}`);
  }
}

// ---------------------------------------------------------------------------
// The state income tax
// ---------------------------------------------------------------------------

/**
 * Form 446: "The withholding rate is 4.25 percent of compensation after
 * deducting the personal and dependency exemption allowance."
 *
 * The per-period allowance is the annual $5,900 divided by the pay periods and
 * rounded to the cent. Treasury publishes per-period wage-bracket tables
 * separately and this transcription could not retrieve them — michigan.gov
 * refuses automated requests and the Archive holds only the guide — so the
 * divisor is the guide's own arithmetic rather than a transcribed table. It is
 * corroborated by the one Michigan Treasury per-period exemption table that IS
 * in hand: Detroit's, where $600 ÷ 52 is printed as $11.54 and $600 ÷ 26 as
 * $23.08, both of them the annual figure rounded half-up to the cent, which is
 * what `divIntCents` does. Recorded as corroboration, not as a citation.
 */
function computeMi(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = miRatesForPayDate(input.payDate);
  periodsGuard(input.periodsPerYear);
  const factors: Record<string, string> = {};

  // MI-W4 line 8 — the employee claims exemption from withholding. Line 8b's
  // reciprocal-state case is NOT read here: reciprocity is resolved upstream,
  // which removes the Michigan levy from the plan entirely, so there is no
  // second and divergent copy of that rule in this engine.
  if (certificateFlag(input.certificate, "exempt")) {
    factors.MI_EXEMPT = "1";
    return { state: "MI", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // MI-W4 line 6. "If you fail or refuse to file the form, your employer must
  // withhold Michigan income tax from your wages without allowance for any
  // exemptions" — so the certificate's declared default is zero.
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  const perPeriod = divIntCents(U(rates.personalExemption), input.periodsPerYear);
  const allowance = perPeriod * BigInt(exemptions);
  factors.MI_EXEMPTION_PER_PERIOD = D(perPeriod);
  factors.MI_ALLOWANCE = D(allowance);

  const taxable = max0(wages - allowance);
  factors.MI_TAXABLE = D(taxable);
  const tax = mulRateCents(taxable, rates.rate);
  factors.MI_TAX = D(tax);

  // MI-W4 line 7 — "Additional amount you want deducted from each pay (if
  // employer agrees)". A flat amount, added after the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "MI",
    year: rates.year,
    tax: D(tax + extra),
    // Form 446 prescribes one rate on compensation and no separate
    // supplemental-wage method at the STATE level. (Detroit does have one —
    // see below — which is why the two engines differ here.)
    taxSupplemental: D(0n),
    factors,
  };
}

export const MI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MI",
  label: "Michigan income tax",
  certificateKey: "us_mi_miw4",
  ratesModule: RATES_MODULE,
  editions: MI_TAX_YEAR_EDITIONS,
  // A flat rate on the period's compensation less an annual allowance divided
  // by the periods: any frequency computes.
  printedPeriods: null,
  compute: computeMi,
};

// ---------------------------------------------------------------------------
// City income taxes
// ---------------------------------------------------------------------------

/**
 * The twenty-four cities the Michigan City Income Tax Act admits.
 *
 * A CLOSED list, which is the whole reason it is transcribed: a city not on it
 * is not a Michigan taxing jurisdiction, and saying so by name is a better
 * answer than an open registry's shrug. Rates are NOT carried here except for
 * Detroit — see `MI_CITY_RATE_SOURCE` below for why.
 */
export const MI_TAXING_CITIES: readonly string[] = [
  "ALBION", "BATTLE_CREEK", "BENTON_HARBOR", "BIG_RAPIDS", "DETROIT", "EAST_LANSING",
  "FLINT", "GRAND_RAPIDS", "GRAYLING", "HAMTRAMCK", "HIGHLAND_PARK", "HUDSON", "IONIA",
  "JACKSON", "LANSING", "LAPEER", "MUSKEGON", "MUSKEGON_HEIGHTS", "PONTIAC", "PORT_HURON",
  "PORTLAND", "SAGINAW", "SPRINGFIELD", "WALKER",
];

/**
 * Why only Detroit's rates are pack constants.
 *
 * Detroit's city income tax is administered jointly with the Department of
 * Treasury, which publishes the rates, the exemption value and a worked
 * example in Form 5469 every year — a state publication this pack can cite and
 * a reader can check. No equivalent exists for the other twenty-three: each
 * city sets and publishes its own, the aggregated lists that circulate
 * disagree with each other (one widely-copied list still prints Saginaw at the
 * 1% statutory floor when Saginaw is one of the cities authorised above it),
 * and being wrong about a rate is worse than asking for it. So the other
 * twenty-three are employer-entered, per city, exactly as Pennsylvania's Act 32
 * rates are.
 */
export const MI_CITY_RATE_SOURCE =
  "Detroit: Michigan Department of Treasury Form 5469. Every other city: the city's own "
  + "ordinance, entered by the employer against the jurisdiction (statutory rate \"us_mi_city\").";

/**
 * The Detroit per-period exemption value, from Form 5469's printed table.
 *
 * Refuses a frequency the City does not print, and that refusal is load
 * bearing: the printed "per diem/daily" figure of $1.64 is $600 ÷ 365, so a
 * 260-day payroll mapped onto the daily column would deduct 40% too little
 * exemption every day of the year.
 */
export function miDetroitExemptionPerPeriod(payDate: string, periodsPerYear: number): string {
  const rates = miRatesForPayDate(payDate);
  const printed = rates.detroit.printedExemption[periodsPerYear];
  if (printed == null) {
    refuseUnprintedPeriod(DETROIT_WITHHOLDING, periodsPerYear);
  }
  return printed;
}

/**
 * The Detroit rate for a RESIDENT who works in another Michigan taxing city.
 *
 * Form 5469: "Compute the City of Detroit withholding rate by subtracting the
 * other city's nonresident tax rate from 2.4%." Both cities withhold; Detroit's
 * share is what is left after the other city's claim.
 *
 * The other city's rate is REQUIRED when there is another city. Defaulting it
 * to zero would withhold Detroit's full 2.4% on top of the work city's tax and
 * over-withhold every one of those employees by up to 1.2% of gross.
 */
export function miDetroitResidentRate(input: {
  payDate: string;
  /** The work city's NONRESIDENT rate as a decimal, or null when in Detroit. */
  otherCityNonresidentRate: string | null;
}): string {
  const rates = miRatesForPayDate(input.payDate);
  if (input.otherCityNonresidentRate == null) return rates.detroit.residentRate;
  const reduced = U(rates.detroit.residentRate) - U(input.otherCityNonresidentRate);
  if (reduced < 0n) {
    throw new Error(
      "the other city's nonresident income tax rate is higher than Detroit's 2.4% resident rate, "
      + "which the Michigan City Income Tax Act does not permit — check the rate entered for the "
      + `work city (${input.otherCityNonresidentRate}).`,
    );
  }
  return D(reduced);
}

/**
 * A Michigan city income tax.
 *
 * Form 5469's method, which is the Uniform City Income Tax Ordinance's:
 *   1. gross earnings × the percent earned in the city (nonresidents), or gross
 *      earnings (residents);
 *   2. exemptions × the per-period exemption value;
 *   3. subtract;
 *   4. multiply by the city's rate.
 *
 * The rate and the exemption value are arguments rather than lookups because
 * only Detroit's are published by the state. A caller that has not got them
 * must refuse, not guess.
 */
export function miCityWithholding(input: {
  city: string;
  /** Wages sourced to the city (already allocated for a part-time nonresident). */
  wages: string;
  /** The city's rate for this employee's basis, as a decimal. */
  rate: string | null | undefined;
  /** The city's ANNUAL exemption value per exemption. */
  exemptionPerYear: string | null | undefined;
  exemptions: number;
  periodsPerYear: number;
  /** Bonuses and other pay outside the regular payroll. */
  supplemental?: string;
}): { tax: string; factors: Record<string, string> } {
  if (!MI_TAXING_CITIES.includes(input.city)) {
    throw new Error(
      `"${input.city}" is not a Michigan city that levies an income tax. The Michigan City Income `
      + `Tax Act admits exactly ${MI_TAXING_CITIES.length}: ${MI_TAXING_CITIES.join(", ")}. `
      + "Correct the employee's work or residence city.",
    );
  }
  if (input.rate == null || input.rate === "") {
    throw new Error(
      `no income tax rate has been entered for ${input.city} (Michigan). ${MI_CITY_RATE_SOURCE} `
      + "Withholding nothing would under-withhold every employee the city's tax reaches.",
    );
  }
  if (input.exemptionPerYear == null || input.exemptionPerYear === "") {
    throw new Error(
      `no annual exemption value has been entered for ${input.city} (Michigan). A city's income `
      + "tax is levied on compensation AFTER an exemption allowance, and the allowance is not the "
      + "same in every city — Detroit's is $600 a year. Withholding on the full wage would "
      + "over-withhold.",
    );
  }
  periodsGuard(input.periodsPerYear);
  const factors: Record<string, string> = { MI_CITY: input.city, MI_CITY_RATE: input.rate };

  const perPeriod = divIntCents(U(input.exemptionPerYear), input.periodsPerYear);
  const allowance = perPeriod * BigInt(Math.max(input.exemptions, 0));
  factors.MI_CITY_EXEMPTION = D(allowance);

  const taxable = max0(U(input.wages) - allowance);
  factors.MI_CITY_TAXABLE = D(taxable);
  const tax = mulRateCents(taxable, input.rate);

  // Form 5469: "For bonuses or other taxable earnings paid in addition to
  // regular payroll, do not adjust for exemptions. Withhold the correct tax
  // percentage from the entire bonus." The exemption is consumed by the regular
  // payroll, so applying it twice in one period would under-withhold.
  const supplemental = mulRateCents(U(input.supplemental ?? "0"), input.rate);
  factors.MI_CITY_TAX = D(tax + supplemental);
  return { tax: D(tax + supplemental), factors };
}

function computeDetroit(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = miRatesForPayDate(input.payDate);
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;
  const rate = input.basis === "resident"
    ? rates.detroit.residentRate
    : rates.detroit.nonresidentRate;
  const perPeriod = miDetroitExemptionPerPeriod(input.payDate, input.periodsPerYear);

  const factors: Record<string, string> = {
    DETROIT_BASIS: input.basis,
    DETROIT_RATE: rate,
    DETROIT_EXEMPTION_PER_PERIOD: perPeriod,
  };
  const allowance = U(perPeriod) * BigInt(Math.max(exemptions, 0));
  const taxable = max0(U(input.wages) - allowance);
  factors.DETROIT_TAXABLE = D(taxable);
  const tax = mulRateCents(taxable, rate);
  const supplemental = mulRateCents(U(input.supplemental ?? "0"), rate);
  factors.DETROIT_TAX = D(tax + supplemental);

  return {
    state: "MI-DETROIT",
    year: rates.year,
    tax: D(tax + supplemental),
    taxSupplemental: D(supplemental),
    factors,
  };
}

export const DETROIT_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MI-DETROIT",
  label: "City of Detroit income tax",
  // Form 5527, the Detroit residency and exemption certificate, is kept by the
  // EMPLOYER and never filed with the City or Treasury — "Do not mail Form 5527
  // to the city or the Michigan Department of Treasury; these are for the
  // employer's use". It still supplies the exemption count this engine reads,
  // so it is declared like any other certificate.
  certificateKey: "us_mi_5527",
  ratesModule: RATES_MODULE,
  editions: MI_TAX_YEAR_EDITIONS,
  printedPeriods: ["weekly", "biweekly", "semimonthly", "monthly", "daily"],
  compute: computeDetroit,
};
