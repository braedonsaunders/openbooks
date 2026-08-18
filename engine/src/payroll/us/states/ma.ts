/**
 * Massachusetts withholding — Circular M, the PERCENTAGE METHOD.
 *
 * Sources (fetched from mass.gov, not memory):
 *   Massachusetts Circular M: Income Tax Withholding Tables at 5.0%, Effective
 *     January 1, 2026 (Rev. 12/25) — the percentage method for wages (p. 12),
 *     the exemption factor table, the head-of-household and blindness values,
 *     the low-wage no-withholding thresholds, and the supplemental wage method
 *     with its own worked example (p. 13).
 *   Form M-4, Massachusetts Employee's Withholding Exemption Certificate.
 *
 * ---------------------------------------------------------------------------
 * The 4% surtax is inside the withholding, and it is not a flat rate
 * ---------------------------------------------------------------------------
 * Massachusetts is a "flat 5% state" that has not been one since 2023: income
 * above an inflation-adjusted threshold — $1,107,750 for 2026 — carries an
 * additional 4%, so the top marginal withholding rate is 9%. Circular M folds
 * it into step 4 of the percentage method, on ANNUALIZED wages, which means it
 * cannot be applied as a rate on the period's pay: a $30,000 monthly salary is
 * $360,000 a year and never reaches the threshold, while a $95,000 monthly
 * salary crosses it in month twelve of an annualized calculation from month
 * one. Annualize, tax, de-annualize — in that order.
 *
 * ---------------------------------------------------------------------------
 * Supplemental wages are a genuinely different calculation
 * ---------------------------------------------------------------------------
 * Not a flat rate, and not aggregation either: Circular M section G asks
 * whether the payment PLUS the employee's annualized regular wages PLUS prior
 * supplemental payments crosses the surtax threshold, and then withholds the
 * LESSER of 9% of the payment or 9% of the part above the threshold plus 5% of
 * the rest. The publication's own worked example ($350,000 bonus on a $948,000
 * salary → $24,854) is the golden in the conformance test, and it is the only
 * example in either tranche where a state prints a number that no simpler rule
 * reproduces: 9% of the bonus would be $31,500, and 5% would be $17,500.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { bmin, D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateCount, certificateFlag } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/ma.ts";

/** The payroll periods Circular M's percentage method prints values for. */
type MaPeriod = "weekly" | "biweekly" | "semimonthly" | "monthly" | "daily" | "annual";

const MA_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "daily", "annual",
];

/** One period's exemption factor: `perExemption` × n, plus `base`. */
interface MaExemptionFactor {
  perExemption: string;
  base: string;
  /** The printed "Claiming 1" figure, which the two above must reproduce. */
  printedClaimingOne: string;
}

export interface MaYearRates {
  year: number;
  status: "published" | "draft";
  baseRate: string;
  /** The rate ABOVE the surtax threshold: 5% + the 4% surtax. */
  surtaxRate: string;
  /** The 2026 inflation-adjusted threshold for the 4% surtax. */
  surtaxThreshold: string;
  /** Step 1's annual cap on the retirement-contribution subtraction. */
  retirementDeductionCap: string;
  exemptionFactors: Readonly<Record<MaPeriod, MaExemptionFactor>>;
  headOfHousehold: Readonly<Record<MaPeriod, string>>;
  blindness: Readonly<Record<MaPeriod, string>>;
  /** "Do not withhold from employees who claim one or more exemptions if their
   *  wages are less than…" */
  noWithholdingBelow: Readonly<Record<MaPeriod, string>>;
  /** Section G step 1's exemption factors, for pension/annuity payees (M-4P). */
  supplementalExemptionFactors: Readonly<Record<"monthly" | "quarterly" | "semiannual" | "annual", {
    perExemption: string; base: string;
  }>>;
}

export const MA_RATES_2026: MaYearRates = {
  year: 2026,
  status: "published",
  baseRate: "0.05",
  surtaxRate: "0.09",
  surtaxThreshold: "1107750",
  retirementDeductionCap: "2000",
  exemptionFactors: {
    weekly: { perExemption: "19", base: "66", printedClaimingOne: "85" },
    biweekly: { perExemption: "38", base: "131", printedClaimingOne: "169" },
    semimonthly: { perExemption: "42", base: "141", printedClaimingOne: "183" },
    monthly: { perExemption: "83", base: "284", printedClaimingOne: "367" },
    daily: { perExemption: "3", base: "9", printedClaimingOne: "12" },
    annual: { perExemption: "1000", base: "3400", printedClaimingOne: "4400" },
  },
  headOfHousehold: {
    weekly: "2.31", biweekly: "4.62", semimonthly: "5.00",
    monthly: "10.00", daily: "0.33", annual: "120.00",
  },
  blindness: {
    weekly: "2.12", biweekly: "4.23", semimonthly: "4.58",
    monthly: "9.17", daily: "0.30", annual: "110.00",
  },
  noWithholdingBelow: {
    weekly: "154", biweekly: "308", semimonthly: "333",
    monthly: "667", daily: "22", annual: "8000",
  },
  supplementalExemptionFactors: {
    monthly: { perExemption: "83", base: "284" },
    quarterly: { perExemption: "250", base: "850" },
    semiannual: { perExemption: "500", base: "1700" },
    annual: { perExemption: "1000", base: "3400" },
  },
};

const MA_EDITIONS_BY_YEAR: Record<number, MaYearRates> = {
  [MA_RATES_2026.year]: MA_RATES_2026,
};

export const MA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Circular M (Rev. 12/25), effective January 1, 2026",
  effectiveFrom: "2026-01-01",
  citation:
    "Massachusetts Department of Revenue, Massachusetts Circular M: Income Tax Withholding Tables "
    + "at 5.0% Effective January 1, 2026 (Rev. 12/25) — percentage methods for wages (p. 12) and "
    + "for supplemental wage payments (p. 13); Form M-4",
  status: "published",
  region: "MA",
}];

export function maRatesForPayDate(payDate: string): MaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MA_WITHHOLDING, year);
  }
  return rates;
}

/**
 * Circular M's own list of pay-period divisors, which is NOT the pack's general
 * one: step 3 says "52 for weekly, 12 for monthly, 24 for semimonthly and 26 OR
 * 27 for biweekly". A 27-payday biweekly year is a real Massachusetts case and
 * it uses the biweekly exemption factors with 27 as the divisor, so it must not
 * be refused as an unprinted frequency.
 */
function maPeriodFor(periodsPerYear: number): MaPeriod {
  switch (periodsPerYear) {
    case 52: return "weekly";
    case 26:
    case 27: return "biweekly";
    case 24: return "semimonthly";
    case 12: return "monthly";
    case 260:
    case 365: return "daily";
    case 1: return "annual";
    default: refuseUnprintedPeriod(MA_WITHHOLDING, periodsPerYear);
  }
}

/** Step 2 — the dollar value of the employee's exemptions for the period. */
export function maExemptionFactor(rates: MaYearRates, period: MaPeriod, claimed: number): bigint {
  if (claimed <= 0) return 0n;
  const factor = rates.exemptionFactors[period];
  return U(factor.perExemption) * BigInt(claimed) + U(factor.base);
}

/** Step 4 — the annual tax, with the surtax on the part above the threshold. */
export function maAnnualTax(rates: MaYearRates, annualWages: bigint): bigint {
  const threshold = U(rates.surtaxThreshold);
  if (annualWages <= threshold) return mulRateCents(annualWages, rates.baseRate);
  return mulRateCents(annualWages - threshold, rates.surtaxRate)
    + mulRateCents(threshold, rates.baseRate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = maRatesForPayDate(input.payDate);
  const period = maPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = { MA_PERIOD: period };

  // M-4 box D: a full-time student in seasonal, part-time or temporary work
  // whose annual income will not exceed $8,000. "Employer: Do not withhold if D
  // is filled in."
  if (certificateFlag(input.certificate, "student_exempt")) {
    factors.MA_STUDENT_EXEMPT = "1";
    return { state: "MA", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const claimed = certificateCount(input.certificate, "total_exemptions") ?? 0;
  const wages = U(input.wages);

  // "Do not withhold from employees who claim one or more exemptions if their
  // wages are less than: weekly $154; biweekly $308; …" A floor on the WAGES,
  // not on the tax, and it only applies when an exemption is claimed.
  const floor = U(rates.noWithholdingBelow[period]);
  const belowFloor = claimed >= 1 && wages < floor;
  if (belowFloor) factors.MA_BELOW_WITHHOLDING_FLOOR = D(floor);

  // Step 1 — the retirement-contribution subtraction, capped at $2,000 a year.
  const contributions = input.socialInsuranceDeducted;
  const cap = U(rates.retirementDeductionCap);
  const alreadyTaken = U(contributions?.yearToDate ?? "0");
  const remainingCap = max0(cap - alreadyTaken);
  const step1 = contributions == null
    ? 0n
    : (U(contributions.period) < remainingCap ? U(contributions.period) : remainingCap);
  factors.MA_RETIREMENT_DEDUCTION = D(step1);
  if (contributions == null) {
    // Named, not silent. The caller did not supply the figure, so the deduction
    // is zero and the employee is over-withheld by the tax on up to $2,000 a
    // year — recoverable on the annual return, unlike an under-withholding.
    factors.MA_RETIREMENT_DEDUCTION_SOURCE = "not supplied";
  }

  // Step 2 — the exemption factors.
  const exemption = maExemptionFactor(rates, period, claimed);
  factors.MA_EXEMPTION_FACTOR = D(exemption);

  const net = max0(wages - step1 - exemption);
  factors.MA_NET_WAGES = D(net);

  // Step 3 — annualize; step 4 — the annual tax; step 5 — de-annualize.
  const annual = net * BigInt(input.periodsPerYear);
  factors.MA_ANNUALIZED = D(annual);
  const annualTax = maAnnualTax(rates, annual);
  factors.MA_ANNUAL_TAX = D(annualTax);
  let tax = divIntCents(annualTax, input.periodsPerYear);

  // Steps 6 and 7 — head of household and blindness, subtracted from the tax
  // AFTER it is computed, not from the wages.
  if (certificateFlag(input.certificate, "head_of_household")) {
    const value = U(rates.headOfHousehold[period]);
    factors.MA_HEAD_OF_HOUSEHOLD = D(value);
    tax = tax - value;
  }
  const blindCount = (certificateFlag(input.certificate, "blind") ? 1 : 0)
    + (certificateFlag(input.certificate, "spouse_blind") ? 1 : 0);
  if (blindCount > 0) {
    const value = U(rates.blindness[period]) * BigInt(blindCount);
    factors.MA_BLINDNESS = D(value);
    tax = tax - value;
  }
  tax = max0(tax);

  if (belowFloor) tax = 0n;
  factors.MA_TAX = D(tax);

  // Supplemental wages are section G's own calculation, not this one.
  const supplemental = U(input.supplemental ?? "0") > 0n
    ? U(maSupplementalWithholding({
      payDate: input.payDate,
      payment: input.supplemental!,
      annualizedRegularWagesNet: D(annual),
      priorSupplemental: input.ytd?.supplemental ?? "0",
    }).tax)
    : 0n;
  if (supplemental > 0n) factors.MA_SUPPLEMENTAL_TAX = D(supplemental);

  // M-4 line 5 — an additional amount by agreement with the employer.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "MA",
    year: rates.year,
    tax: D(tax + supplemental + extra),
    taxSupplemental: D(supplemental),
    factors,
  };
}

/**
 * Circular M section G — withholding on a supplemental wage payment.
 *
 * Step 4 adds the payment to the employee's total ANNUALIZED regular wages (net
 * of the retirement deduction and the exemption factors — the step-3 figure the
 * percentage method already computes) and to any prior supplemental payments
 * this year. Steps 5 and 6 then apply the surtax to whatever part of that total
 * sits above the threshold.
 *
 * Steps 1–3 (the M-4P exemption factors, head of household, blindness) apply to
 * PENSION and annuity payees. The publication's own worked example omits them
 * for an employee bonus — "There is no M-4P. Therefore, Employer should omit
 * step 1" — and this function follows the example, taking those adjustments
 * only when the caller supplies them.
 */
export function maSupplementalWithholding(input: {
  payDate: string;
  /** The supplemental payment itself. */
  payment: string;
  /** The employee's annualized regular wages, net of steps 1 and 2. */
  annualizedRegularWagesNet: string;
  /** Prior supplemental payments by this payer this year. */
  priorSupplemental?: string;
  /** Steps 1–3, for an M-4P payee. Omitted for an employee bonus. */
  m4pAdjustments?: string;
}): { tax: string; factors: Record<string, string> } {
  const rates = maRatesForPayDate(input.payDate);
  const threshold = U(rates.surtaxThreshold);

  // Step 3's result: the payment less any M-4P adjustments.
  const step3 = max0(U(input.payment) - U(input.m4pAdjustments ?? "0"));
  const step4 = step3 + U(input.annualizedRegularWagesNet) + U(input.priorSupplemental ?? "0");
  const factors: Record<string, string> = {
    MA_SUPP_STEP3: D(step3),
    MA_SUPP_STEP4: D(step4),
  };

  if (step4 <= threshold) {
    const tax = mulRateCents(step3, rates.baseRate);
    factors.MA_SUPP_TAX = D(tax);
    return { tax: D(tax), factors };
  }

  const excess = step4 - threshold;
  const overThreshold = excess > step3 ? step3 : excess;
  const remainder = max0(step3 - overThreshold);
  const split = mulRateCents(overThreshold, rates.surtaxRate)
    + mulRateCents(remainder, rates.baseRate);
  const flat = mulRateCents(step3, rates.surtaxRate);
  // "the LESSER of (i) 9% of the amount determined in step 3, or (ii) 9% of the
  // amount by which the result of step 4 exceeds the threshold, plus 5% of the
  // remainder".
  const tax = bmin(flat, split);
  factors.MA_SUPP_ABOVE_THRESHOLD = D(overThreshold);
  factors.MA_SUPP_TAX = D(tax);
  return { tax: D(tax), factors };
}

export const MA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MA",
  label: "Massachusetts income tax",
  certificateKey: "us_ma_m4",
  ratesModule: RATES_MODULE,
  editions: MA_TAX_YEAR_EDITIONS,
  printedPeriods: MA_PERIODS,
  compute,
};
