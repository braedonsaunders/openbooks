/**
 * West Virginia income-tax withholding — IT-100.2.A, the PERCENTAGE METHOD.
 *
 * Source (fetched from tax.wv.gov, not memory):
 *   Form WV IT-100.2A, Tables for Percentage Method of Withholding, March 2026,
 *     https://tax.wv.gov/Documents/Withholding/it100.2a.pdf
 *     — TWO EARNER/TWO OR MORE JOBS tables (pp. 1–2) and OPTIONAL ONE
 *       EARNER/ONE JOB tables (pp. 3–4); $2,000 per exemption (annual);
 *       six printed payroll periods.
 *   Withholding Help and General Information,
 *     https://tax.wv.gov/Business/Withholding/HelpAndGeneralInformation/Pages/WithholdingHelpAndGeneralInformation.aspx
 *     — Method II: "apply the appropriate rate, rounding the result to the
 *       nearest whole dollar." The wage-bracket tables (IT-100.2.B) "are
 *       based on two-earner/two-job income."
 *   Form WV IT-104 / IT-104NR, Rev. 03/2023,
 *     https://tax.wv.gov/Documents/Withholding/it104.pdf
 *     — line 4 exemptions (default zero if the form is not completed);
 *       line 5 one-earner checkbox (the optional lower schedule);
 *       line 6 additional withholding; the nonresidence / military-spouse
 *       exemption on IT-104NR.
 *
 * The percentage method is a printed per-period TABLE, not an annualized
 * formula. IT-100.2A prints weekly, biweekly, semimonthly, monthly, annual
 * and daily and nothing else. A quarterly payroll is refused rather than
 * scaled. The two-earner schedule is the default — it is the one the
 * wage-bracket tables are computed from, and IT-104 line 5 must be checked
 * to elect the optional one-earner schedule.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import { roundDiv } from "../../../money/money.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";
import {
  evaluateUsNonresidentThreshold,
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  requireUsSourceWages,
  requireUsWageAllocation,
  type UsNonresidentThresholdRule,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/wv.ts";
const WV_MOBILE_KEY = "us_wv_mobile";

/**
 * WV Code §11-21-31 mobile-employee exclusion: a nonresident performing
 * duties in more than one state is excluded from West Virginia source income
 * at 30 or fewer West Virginia days. Past 30, the employer withholds for
 * every West Virginia day that year, including the first 30 — the prior
 * exempt wages are caught up once.
 */
const WV_MOBILE_WORKFORCE_RULE: UsNonresidentThresholdRule = {
  measure: "service_days",
  threshold: 30,
  crossing: ">",
  catchUpPriorWages: true,
  label: "West Virginia 30-day mobile-employee exclusion",
};

/** Eligibility facts for the mobile-employee exclusion, §11-21-31(b)(3)–(4). */
const WV_MOBILE_FACTS: readonly { key: string; description: string }[] = [
  {
    key: "not_excluded_role",
    description: "the employee is not a professional athlete, professional entertainer, or public figure",
  },
  {
    key: "residence_state_qualifies",
    description: "the employee's residence state provides a substantially similar exclusion, imposes no individual income tax, or the income is exempt under the United States Constitution or federal statute",
  },
];

type WvPeriod = "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual" | "daily";

const WV_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

export type WvSchedule = "two_earner" | "one_earner";

/** One printed percentage-method line. `upTo` is inclusive ("But Not Over"). */
export interface WvPercentageRow {
  upTo: string | null;
  over: string;
  base: string;
  /** Publication percent, already shifted by `pctToRate`. */
  rate: string;
}

export interface WvPeriodValues {
  /** "Gross Wage Minus $X for Each Exemption Claimed". */
  exemption: string;
  rows: readonly WvPercentageRow[];
}

export interface WvYearRates {
  year: number;
  status: "published" | "draft";
  /** Annual value of one IT-104 exemption — Table 5's own header. */
  exemptionPerYear: string;
  schedules: Readonly<Record<WvSchedule, Readonly<Record<WvPeriod, WvPeriodValues>>>>;
}

function row(
  over: string,
  upTo: string | null,
  base: string,
  printedPercent: string,
): WvPercentageRow {
  return { over, upTo, base, rate: pctToRate(printedPercent) };
}

export const WV_RATES_2026: WvYearRates = {
  year: 2026,
  status: "published",
  exemptionPerYear: "2000.00",
  schedules: {
    two_earner: {
      weekly: {
        exemption: "38.46",
        rows: [
          row("0", "144", "0", "2.11"),
          row("144", "361", "3.04", "2.81"),
          row("361", "577", "9.13", "3.16"),
          row("577", "866", "15.95", "4.22"),
          row("866", null, "28.14", "4.58"),
        ],
      },
      biweekly: {
        exemption: "76.92",
        rows: [
          row("0", "289", "0", "2.11"),
          row("289", "722", "6.09", "2.81"),
          row("722", "1154", "18.25", "3.16"),
          row("1154", "1731", "31.90", "4.22"),
          row("1731", null, "56.27", "4.58"),
        ],
      },
      semimonthly: {
        exemption: "83.33",
        rows: [
          row("0", "313", "0", "2.11"),
          row("313", "782", "6.60", "2.81"),
          row("782", "1250", "19.77", "3.16"),
          row("1250", "1875", "34.58", "4.22"),
          row("1875", null, "60.95", "4.58"),
        ],
      },
      monthly: {
        exemption: "166.67",
        rows: [
          row("0", "625", "0", "2.11"),
          row("625", "1562", "13.18", "2.81"),
          row("1562", "2500", "39.53", "3.16"),
          row("2500", "3750", "69.15", "4.22"),
          row("3750", null, "121.91", "4.58"),
        ],
      },
      annual: {
        exemption: "2000.00",
        rows: [
          row("0", "7500", "0", "2.11"),
          row("7500", "18750", "158.25", "2.81"),
          row("18750", "30000", "474.38", "3.16"),
          row("30000", "45000", "829.88", "4.22"),
          row("45000", null, "1462.88", "4.58"),
        ],
      },
      daily: {
        exemption: "7.66",
        rows: [
          row("0", "29", "0", "2.11"),
          row("29", "72", "0.60", "2.81"),
          row("72", "115", "1.82", "3.16"),
          row("115", "173", "3.17", "4.22"),
          row("173", null, "5.61", "4.58"),
        ],
      },
    },
    one_earner: {
      weekly: {
        exemption: "38.46",
        rows: [
          row("0", "192", "0", "2.11"),
          row("192", "481", "4.05", "2.81"),
          row("481", "769", "12.17", "3.16"),
          row("769", "1154", "21.27", "4.22"),
          row("1154", null, "37.52", "4.58"),
        ],
      },
      biweekly: {
        exemption: "76.92",
        rows: [
          row("0", "385", "0", "2.11"),
          row("385", "962", "8.12", "2.81"),
          row("962", "1538", "24.34", "3.16"),
          row("1538", "2308", "42.54", "4.22"),
          row("2308", null, "75.03", "4.58"),
        ],
      },
      semimonthly: {
        exemption: "83.33",
        rows: [
          row("0", "417", "0", "2.11"),
          row("417", "1042", "8.80", "2.81"),
          row("1042", "1667", "26.36", "3.16"),
          row("1667", "2500", "46.11", "4.22"),
          row("2500", null, "81.26", "4.58"),
        ],
      },
      monthly: {
        exemption: "166.67",
        rows: [
          row("0", "833", "0", "2.11"),
          row("833", "2083", "17.58", "2.81"),
          row("2083", "3333", "52.70", "3.16"),
          row("3333", "5000", "92.20", "4.22"),
          row("5000", null, "162.55", "4.58"),
        ],
      },
      annual: {
        exemption: "2000.00",
        rows: [
          row("0", "10000", "0", "2.11"),
          row("10000", "25000", "211.00", "2.81"),
          row("25000", "40000", "632.50", "3.16"),
          row("40000", "60000", "1106.50", "4.22"),
          row("60000", null, "1950.50", "4.58"),
        ],
      },
      daily: {
        exemption: "7.66",
        rows: [
          row("0", "38", "0", "2.11"),
          row("38", "96", "0.80", "2.81"),
          row("96", "153", "2.43", "3.16"),
          row("153", "230", "4.23", "4.22"),
          row("230", null, "7.48", "4.58"),
        ],
      },
    },
  },
};

const WV_EDITIONS_BY_YEAR: Record<number, WvYearRates> = {
  [WV_RATES_2026.year]: WV_RATES_2026,
};

export const WV_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "WV IT-100.2A (March 2026) Percentage Method",
  effectiveFrom: "2026-01-01",
  citation:
    "West Virginia Tax Division, Form WV IT-100.2A, Tables for Percentage Method of Withholding "
    + "(March 2026) — two-earner tables (pp. 1–2) and optional one-earner tables (pp. 3–4); "
    + "IT-104 Rev. 03/2023; Method II rounding to the nearest whole dollar",
  status: "published",
  region: "WV",
}];

export function wvRatesForPayDate(payDate: string): WvYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WV_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(WV_WITHHOLDING, year);
  }
  return rates;
}

function wvPeriodFor(periodsPerYear: number): WvPeriod {
  const period = payPeriodFor(periodsPerYear);
  // The daily table is 260-calibrated ($29 = $7,500 ÷ 260), so a 365-day
  // daily payroll has no printed table — refused like the KS/MO daily guards
  // refuse theirs.
  if (period == null || !WV_PERIODS.includes(period) || (period === "daily" && periodsPerYear !== 260)) {
    refuseUnprintedPeriod(WV_WITHHOLDING, periodsPerYear);
  }
  return period as WvPeriod;
}

const DOLLAR = 10_000n;

/** Method II: "rounding the result to the nearest whole dollar." */
export function wvRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/**
 * IT-100.2A percentage method for one printed period and one schedule.
 *
 * Line by line: wages less (exemptions × the period's exemption value), look
 * up the printed band, apply base + rate × excess, round to the dollar.
 */
export function wvPercentageMethod(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  schedule: WvSchedule;
  exemptions: number;
}): { tax: bigint; factors: Record<string, string> } {
  const rates = wvRatesForPayDate(input.payDate);
  const period = wvPeriodFor(input.periodsPerYear);
  const values = rates.schedules[input.schedule][period];
  const factors: Record<string, string> = {
    WV_SCHEDULE: input.schedule,
    WV_PERIOD: period,
  };

  const exemption = U(values.exemption) * BigInt(Math.max(input.exemptions, 0));
  factors.WV_EXEMPTION = D(exemption);
  const taxable = max0(U(input.wages) - exemption);
  factors.WV_TAXABLE = D(taxable);

  // "Over $X But Not Over $Y": the first band includes zero; later bands are
  // exclusive of their `over`. A hole between printed lines is refused.
  const band = values.rows.find((candidate) => {
    const aboveFloor = candidate.over === "0" ? taxable >= 0n : taxable > U(candidate.over);
    const atOrUnderCeiling = candidate.upTo == null || taxable <= U(candidate.upTo);
    return aboveFloor && atOrUnderCeiling;
  });
  if (!band) {
    throw new PayrollError(
      `no West Virginia ${input.schedule} ${period} line covers taxable wages of ${D(taxable)}`,
    );
  }
  factors.WV_BAND_OVER = band.over;
  const tax = wvRoundToDollar(U(band.base) + mulRateCents(max0(taxable - U(band.over)), band.rate));
  factors.WV_TAX = D(tax);
  return { tax, factors };
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = wvRatesForPayDate(input.payDate);

  const militarySpouseCertificate = input.supportingCertificates?.us_wv_it104nr;
  if (militarySpouseCertificate?.onFile) {
    requireMilitarySpouseEligibility(militarySpouseCertificate, "West Virginia", [
      { key: "servicemember_is_armed_forces_member", description: "the employee's spouse is a member of the Armed Forces" },
      { key: "servicemember_present_under_orders", description: "the servicemember is present in West Virginia in compliance with military orders" },
      { key: "spouse_present_solely_to_accompany", description: "the employee is present in West Virginia solely to be with the servicemember" },
      { key: "spouse_domiciled_outside_wv", description: "the employee maintains domicile in another state" },
      { key: "spousal_military_id_on_file", description: "a copy of the spousal military identification card is attached" },
    ]);
    return {
      state: "WV", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      statutoryTax: D(0n), additionalWithholding: D(0n),
      factors: { WV_NONRESIDENT_MILITARY_SPOUSE_EXEMPT: "1" },
    };
  }

  const reciprocalExemptionClaimed = certificateFlag(input.certificate, "exempt");
  let reciprocalResidence: string | null | undefined;
  let invalidReciprocalResidence = false;
  try {
    reciprocalResidence = certificateChoice(input.certificate, "resident_state");
  } catch {
    // An invalid residence cannot qualify for the exemption; ordinary WV
    // withholding remains computable and is safer than accepting a stale or
    // corrupted reciprocal claim as zero withholding.
    invalidReciprocalResidence = true;
  }
  const wagesOnly = certificateFlag(input.certificate, "only_wv_source_income_is_wages");
  const reciprocalStates = ["KY", "MD", "OH", "PA", "VA"];
  if (
    reciprocalExemptionClaimed
    && input.basis === "nonresident"
    && !invalidReciprocalResidence
    && reciprocalStates.includes(reciprocalResidence ?? "")
    && wagesOnly
  ) {
    return {
      state: "WV", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      statutoryTax: D(0n), additionalWithholding: D(0n),
      factors: { WV_EXEMPT: "1" },
    };
  }

  // Nonresident Armed Forces pay (WV Code §11-21-71; TSD 381) and qualifying
  // seafarer wages (46 USC 11108(a); WV CSR §110-21-71.1.2) are excluded by
  // classified component dollars only. Military pay additionally needs the
  // payer-held membership attestation, because TSD 381 excepts National
  // Guard members on 32 USC §502 duty and ready-reserve members on scheduled
  // or 10 USC §270(a) active duty: excepted members' military pay stays
  // taxable, and classified military pay with no attestation refuses by
  // name rather than assuming either status.
  const exemptionAmount = (...classes: readonly string[]): bigint =>
    (input.statutoryExemptionAmounts ?? [])
      .filter((item) => item.category !== null && classes.includes(item.category))
      .reduce((total, item) => total + U(item.amount), 0n);
  // Factor entries for the exclusions below; merged after the percentage
  // method builds `factors` further down.
  const exemptionFactors: Record<string, string> = {};
  let federallyExempt = 0n;
  if (input.basis === "nonresident") {
    const seafarerAmount = exemptionAmount("seafarer");
    if (seafarerAmount > 0n) {
      exemptionFactors.WV_EXEMPT_SEAFARER_WAGES = D(seafarerAmount);
      federallyExempt += seafarerAmount;
    }
    if (exemptionAmount("military_pay") > 0n) {
      const status = input.supportingCertificates?.us_wv_military_pay;
      if (!status?.onFile) {
        throw new PayrollError(
          "West Virginia military pay is classified but no military-pay attestation is on file — "
          + "record the member's Armed Forces status and Guard/Reserve exception answers before "
          + "calculating; refused by name",
        );
      }
      if (!certificateFlag(status, "armed_forces_member")) {
        throw new PayrollError(
          "West Virginia military-pay attestation does not certify Armed Forces membership — "
          + "the §11-21-71 exclusion covers members only; correct the attestation before calculating",
        );
      }
      if (certificateFlag(status, "guard_reserve_excepted_duty")) {
        exemptionFactors.WV_MILITARY_PAY_TAXABLE = "guard_reserve_excepted_duty";
      } else {
        const militaryAmount = exemptionAmount("military_pay");
        exemptionFactors.WV_EXEMPT_MILITARY_PAY = D(militaryAmount);
        federallyExempt += militaryAmount;
      }
    }
  }

  // IT-104 line 5 must be checked to elect the optional one-earner schedule.
  // Unchecked — and no certificate on file — is the two-earner default the
  // wage-bracket tables themselves are computed from.
  const schedule: WvSchedule = certificateFlag(input.certificate, "one_earner")
    ? "one_earner"
    : "two_earner";
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;
  const grossWages = U(input.wages) + U(input.supplemental ?? "0");
  // Nonresidents withhold on verified West Virginia-source wages (I6-payroll-131);
  // the mobile exclusion below prices off the same allocation when it applies.
  let wages = input.basis === "nonresident"
    ? U(requireUsSourceWages(input.wageAllocations, "WV", null))
    : grossWages;
  // Federally exempt component dollars leave the priced base here, so the
  // low-income spread, the mobile exclusion, and the source-wage trace all
  // price the reduced base. (The mobile branch below re-establishes `wages`
  // from the allocation and re-applies the same exclusion there.)
  if (input.basis === "nonresident" && federallyExempt > 0n) {
    wages = max0(wages - federallyExempt);
  }
  // §11-21-10 low-income earned-income exclusion, claimed in good faith on
  // the certificate: the capped annual exclusion spreads over the declared
  // payroll periods before the percentage method. §11-21-71(a) directs
  // withholding methods to give it due regard when asserted.
  const lowIncomeFactors: Record<string, string> = {};
  if (certificateFlag(input.certificate, "low_income_exclusion_claim")) {
    const filingStatus = certificateChoice(input.certificate, "low_income_return_status");
    const expectedAgi = certificateAmount(input.certificate, "expected_annual_federal_agi");
    const expectedEarnedIncome = certificateAmount(input.certificate, "expected_annual_earned_income");
    if (filingStatus == null || expectedAgi == null || expectedEarnedIncome == null) {
      throw new PayrollError(
        "West Virginia low-income exclusion claim needs the expected return status, annual federal AGI, and annual earned income; complete all three verified facts before calculating; refused by name",
      );
    }
    const separateReturn = filingStatus === "separate";
    const eligibilityLimit = U(separateReturn ? "5000" : "10000");
    const agi = U(expectedAgi);
    const earnedIncome = U(expectedEarnedIncome);
    if (agi < 0n || earnedIncome < 0n || agi > eligibilityLimit) {
      throw new PayrollError(
        `West Virginia low-income exclusion claim requires nonnegative annual facts and federal AGI at or below ${D(eligibilityLimit)} for the declared return status; correct the good-faith estimate or withdraw the claim; refused by name`,
      );
    }
    const annualExclusionLimit = U(separateReturn ? "5000" : "10000");
    const annualExclusion = earnedIncome < annualExclusionLimit ? earnedIncome : annualExclusionLimit;
    const periodExclusion = divIntCents(annualExclusion, input.periodsPerYear);
    wages = max0(wages - periodExclusion);
    lowIncomeFactors.WV_LOW_INCOME_ANNUAL_EXCLUSION = D(annualExclusion);
    lowIncomeFactors.WV_LOW_INCOME_PERIOD_EXCLUSION = D(periodExclusion);
  }

  // §11-21-31 mobile-employee exclusion: no withholding while a qualifying
  // multi-state nonresident is at 30 or fewer West Virginia days. Past 30,
  // every West Virginia day that year withholds — the prior exempt wages
  // are caught up through the same percentage method. Without the filed
  // eligibility attestation the exclusion does not apply (fail closed).
  // (The general nonresident source-wage base is the separately delivered
  // I6-payroll-131 change; this path prices the mobile exclusion on the
  // verified allocation it requires.)
  let catchUpSourceWages = "0.0000";
  let catchUpPeriods = 0;
  const mobileFactors: Record<string, string> = {};
  if (input.basis === "nonresident") {
    const mobile = input.supportingCertificates?.[WV_MOBILE_KEY];
    if (mobile?.onFile) {
      const unmet = WV_MOBILE_FACTS.filter((fact) => !certificateFlag(mobile, fact.key));
      if (unmet.length > 0) {
        throw new PayrollError(
          "West Virginia mobile-employee exclusion requires proof that "
          + unmet.map((fact) => fact.description).join("; "),
        );
      }
      const workedOutsideWv = (input.wageAllocations ?? []).some((item) => item.region !== "WV");
      if (workedOutsideWv) {
        const allocation = requireUsWageAllocation(input.wageAllocations, "WV", null);
        const threshold = evaluateUsNonresidentThreshold(
          allocation, WV_MOBILE_WORKFORCE_RULE, input.periodsPerYear,
        );
        wages = max0(U(requireUsSourceWages(input.wageAllocations, "WV", null)) - federallyExempt);
        mobileFactors.WV_SOURCE_WAGES = D(wages);
        mobileFactors.WV_MOBILE_DAYS_YTD = String(allocation.serviceDaysYearToDate);
        if (!threshold.crossed) {
          mobileFactors.WV_MOBILE_EXCLUDED = "1";
          return {
            state: "WV", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
            factors: { ...exemptionFactors, ...mobileFactors },
          };
        }
        catchUpSourceWages = threshold.catchUpSourceWages;
        catchUpPeriods = threshold.periodsBeforeCurrent ?? 0;
      }
    }
  }

  const { tax, factors: methodFactors } = wvPercentageMethod({
    payDate: input.payDate,
    periodsPerYear: input.periodsPerYear,
    wages: D(wages),
    schedule,
    exemptions,
  });
  const factors = { ...exemptionFactors, ...mobileFactors, ...methodFactors };
  if (input.basis === "nonresident" && factors.WV_SOURCE_WAGES == null) {
    factors.WV_SOURCE_WAGES = D(wages);
  }
  Object.assign(factors, lowIncomeFactors);

  let catchUpTax = 0n;
  if (U(catchUpSourceWages) > 0n) {
    const averagePriorWages = divIntCents(U(catchUpSourceWages), catchUpPeriods);
    const priorTax = wvPercentageMethod({
      payDate: input.payDate,
      periodsPerYear: input.periodsPerYear,
      wages: D(averagePriorWages),
      schedule,
      exemptions,
    }).tax;
    catchUpTax = priorTax * BigInt(catchUpPeriods);
    factors.WV_CATCHUP_SOURCE_WAGES = D(U(catchUpSourceWages));
    factors.WV_CATCHUP_PERIODS = String(catchUpPeriods);
    factors.WV_CATCHUP_TAX = D(catchUpTax);
  }

  // IT-104 line 6 — additional withholding, added AFTER the rounded tax.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  if (reciprocalExemptionClaimed) {
    factors.WV_RECIPROCAL_EXEMPTION_NOT_APPLIED =
      input.basis !== "nonresident" ? "not_nonresident"
        : invalidReciprocalResidence || !reciprocalStates.includes(reciprocalResidence ?? "")
          ? "ineligible_resident_state"
          : "wv_income_not_certified_as_wages_only";
  }
  return {
    state: "WV",
    year: rates.year,
    tax: D(tax + catchUpTax + extra),
    statutoryTax: D(tax + catchUpTax),
    additionalWithholding: D(extra),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys above. Terms are the IT-100.2A percentage method's own — see the
 * module header.
 */
export const WV_FACTOR_LABELS: Readonly<Record<string, string>> = {
  WV_NONRESIDENT_MILITARY_SPOUSE_EXEMPT: "West Virginia qualifying military-spouse wages exempt from withholding",
  WV_EXEMPT_MILITARY_PAY: "West Virginia nonresident Armed Forces pay excluded from withholding",
  WV_EXEMPT_SEAFARER_WAGES: "West Virginia qualifying seafarer wages excluded from withholding",
  WV_MILITARY_PAY_TAXABLE: "West Virginia military pay taxable under a Guard/Reserve exception",
  WV_EXEMPT: "Exempt from West Virginia withholding",
  WV_SCHEDULE: "West Virginia schedule",
  WV_PERIOD: "West Virginia payroll period",
  WV_EXEMPTION: "West Virginia exemption",
  WV_TAXABLE: "West Virginia taxable income",
  WV_SOURCE_WAGES: "West Virginia source wages",
  WV_BAND_OVER: "West Virginia band excess",
  WV_TAX: "West Virginia tax",
  WV_LOW_INCOME_ANNUAL_EXCLUSION: "West Virginia low-income earned-income exclusion (annual)",
  WV_LOW_INCOME_PERIOD_EXCLUSION: "West Virginia low-income earned-income exclusion (this period)",
  WV_MOBILE_DAYS_YTD: "West Virginia service days this year for a nonresident",
  WV_MOBILE_EXCLUDED: "West Virginia 30-day mobile-employee exclusion",
  WV_CATCHUP_SOURCE_WAGES: "West Virginia-source wages previously excluded",
  WV_CATCHUP_PERIODS: "West Virginia prior periods included in catch-up",
  WV_CATCHUP_TAX: "West Virginia catch-up withholding for prior periods",
  WV_RECIPROCAL_EXEMPTION_NOT_APPLIED: "West Virginia reciprocal exemption not applied",
};

export const WV_WITHHOLDING: UsStateWithholdingEngine = {
  state: "WV",
  label: "West Virginia income tax",
  certificateKey: "us_wv_it104",
  ratesModule: RATES_MODULE,
  editions: WV_TAX_YEAR_EDITIONS,
  printedPeriods: WV_PERIODS,
  supportingCertificateKeys: ["us_wv_it104nr", WV_MOBILE_KEY, "us_wv_military_pay"],
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * West Virginia withholding declarations — Form IT-104 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form WV IT-104 / IT-104NR, Rev. 03/2023. */
export const WV_CERTIFICATE: PayrollCertificate = {
  key: "us_wv_it104",
  form: "IT-104",
  label: "West Virginia Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "WV" },
  purpose: "withholding",
  citation:
    "West Virginia Form WV IT-104 / IT-104NR (Rev. 03/2023); Form WV IT-100.2A (March 2026)",
  summary:
    "Sets West Virginia withholding exemptions and the optional one-earner schedule. If the "
    + "employee does not complete the form, no exemptions are claimed and the two-earner "
    + "percentage tables apply — IT-104's own warning is that withholding \"may not be "
    + "sufficient,\" not that the employer may skip withholding.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions",
      label: "Line 4 — Total withholding exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "The sum of IT-104 lines 1–3 (self, spouse, dependents). Worth $2,000 a year each "
        + "(IT-100.2A Table 5). Default zero: an unfiled certificate claims no exemptions.",
    },
    {
      key: "one_earner",
      label: "Line 5 — Optional one-earner / one-job schedule",
      kind: "flag",
      help:
        "Checked only if the employee is single, head of household, or married with a "
        + "non-employed spouse, receives wages from only one job, and wants the lower "
        + "optional one-earner tables. Unchecked is the two-earner default the wage-bracket "
        + "tables themselves are computed from.",
    },
    {
      key: "additional_per_period",
      label: "Line 6 — Additional withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the percentage method is rounded to the dollar.",
    },
    {
      key: "low_income_exclusion_claim",
      label: "Claim the low-income earned-income exclusion",
      kind: "flag",
      help: "Claim in good faith only if your expected West Virginia return AGI meets the limit for your filing status; provide all three estimates below.",
    },
    {
      key: "low_income_return_status",
      label: "Expected West Virginia return status for the low-income exclusion",
      kind: "choice",
      choices: [
        { value: "unmarried_or_joint", label: "Unmarried or married filing jointly" },
        { value: "separate", label: "Married filing separately" },
      ],
      help: "The exclusion's AGI limit and maximum are $10,000 for an unmarried taxpayer or joint return, and $5,000 per separate return.",
    },
    {
      key: "expected_annual_federal_agi",
      label: "Expected federal adjusted gross income for this tax year",
      kind: "amount", decimals: 2, min: "0",
      help: "Enter a good-faith estimate of total federal AGI for the full tax year, including income beyond this West Virginia job.",
    },
    {
      key: "expected_annual_earned_income",
      label: "Expected annual earned income included in federal AGI",
      kind: "amount", decimals: 2, min: "0",
      help: "Enter a good-faith estimate of wages, compensation, and net self-employment income included in federal AGI; the statutory exclusion is limited to this amount and the filing-status cap.",
    },
    {
      key: "exempt",
      label: "IT-104NR — Claim exemption from West Virginia withholding",
      kind: "flag",
      help:
        "Claim only when the employee resides outside West Virginia and meets all IT-104NR "
        + "eligibility conditions below. An ineligible claim does not stop ordinary withholding.",
    },
    {
      key: "resident_state",
      label: "IT-104NR — State of residence",
      kind: "choice",
      choices: [
        { value: "KY", label: "Kentucky" },
        { value: "MD", label: "Maryland" },
        { value: "OH", label: "Ohio" },
        { value: "PA", label: "Pennsylvania" },
        { value: "VA", label: "Virginia" },
      ],
      help: "The IT-104NR reciprocal exemption is limited to residents of these five states.",
    },
    {
      key: "only_wv_source_income_is_wages",
      label: "IT-104NR — Only West Virginia source income is wages or salaries",
      kind: "flag",
      help: "Required eligibility condition on Form IT-104NR; the exemption cannot be used for other West Virginia source income.",
    },
  ],
};

/** Separate IT-104NR statement for a nonresident military spouse. */
export const WV_IT104NR_CERTIFICATE: PayrollCertificate = {
  key: "us_wv_it104nr",
  form: "IT-104NR",
  label: "West Virginia Certificate of Nonresidence — Military Spouse",
  scope: { level: "region", region: "WV" },
  purpose: "exemption",
  citation: "West Virginia Form WV IT-104 / IT-104NR (Rev. 03/2023), military-spouse statement",
  summary:
    "The military-spouse exemption requires the separate IT-104NR statement, all eligibility "
    + "conditions, and a copy of the spouse's military identification card.",
  storage: "certificate_rows",
  fields: [
    {
      key: "servicemember_is_armed_forces_member",
      label: "Spouse is a member of the Armed Forces",
      kind: "flag", required: true,
      help: "IT-104NR condition (a).",
    },
    {
      key: "servicemember_present_under_orders",
      label: "Servicemember is present in West Virginia in compliance with military orders",
      kind: "flag", required: true,
      help: "IT-104NR condition (a).",
    },
    {
      key: "spouse_present_solely_to_accompany",
      label: "Employee is present in West Virginia solely to be with the servicemember",
      kind: "flag", required: true,
      help: "IT-104NR condition (b).",
    },
    {
      key: "spouse_domiciled_outside_wv",
      label: "Employee maintains domicile in another state",
      kind: "flag", required: true,
      help: "IT-104NR condition (c): record the state of domicile on the signed form.",
    },
    {
      key: "spousal_military_id_on_file",
      label: "Copy of spousal military identification card is attached",
      kind: "flag", required: true,
      help: "The IT-104NR instructions require the employee to attach this supporting document.",
    },
  ],
};

/**
 * Payer-held Armed Forces pay attestation (no state form exists — TSD 381
 * is an employer instruction). Filed only for a nonresident employee whose
 * component pay is classified military_pay: it certifies Armed Forces
 * membership and whether the TSD 381 Guard/Reserve exceptions apply.
 */
export const WV_MILITARY_PAY_CERTIFICATE: PayrollCertificate = {
  key: "us_wv_military_pay",
  form: "Military pay attestation",
  label: "West Virginia nonresident military-pay attestation",
  scope: { level: "region", region: "WV" },
  purpose: "withholding",
  citation:
    "WV Code §11-21-71; WV Tax Division TSD 381 (withholding not required for "
    + "a nonresident Armed Forces member)",
  summary:
    "The employer attests the nonresident employee's Armed Forces membership "
    + "and Guard/Reserve exception status so classified military pay is "
    + "excluded only for qualifying members.",
  storage: "certificate_rows",
  fields: [
    {
      key: "armed_forces_member",
      label: "Employee is a member of the Armed Forces of the United States",
      kind: "flag", required: true,
      help: "The §11-21-71 exclusion covers members only.",
    },
    {
      key: "guard_reserve_excepted_duty",
      label: "Member serves in a TSD 381 excepted duty status",
      kind: "flag", required: true,
      help: "Set when the member is National Guard on 32 USC §502 duty or "
        + "ready reserve on scheduled duties or 10 USC §270(a) active duty — "
        + "TSD 381 does not extend the withholding exclusion to those duties.",
    },
  ],
};

/**
 * West Virginia mobile-employee exclusion attestation. The state publishes no
 * form for §11-21-31 — the employer relies on its time-and-attendance system
 * or the employee's written day-count statement — so the qualifying facts the
 * system cannot derive (role, residence-state prong) are attested here while
 * service days and multi-state work come from verified work allocations.
 */
export const WV_MOBILE_CERTIFICATE: PayrollCertificate = {
  key: WV_MOBILE_KEY,
  form: "(employer-determined)",
  label: "West Virginia mobile-employee exclusion attestation",
  scope: { level: "region", region: "WV" },
  purpose: "exemption",
  citation:
    "West Virginia Code §11-21-31 (mobile-employee exclusion from state source income); "
    + "WV Tax Division TSD 381 (Rev. September 2025)",
  summary:
    "Attests a nonresident's §11-21-31 eligibility (ordinary role, qualifying "
    + "residence state). With it on file, verified West Virginia service days "
    + "at or under 30 exclude the wages; past 30, every West Virginia day that "
    + "year withholds. Without it, ordinary withholding applies.",
  storage: "certificate_rows",
  fields: [
    {
      key: "not_excluded_role",
      label: "Employee is not a professional athlete, professional entertainer, or public figure",
      kind: "flag", required: true,
      help: "§11-21-31(b)(3): the exclusion does not cover duties performed in those capacities.",
    },
    {
      key: "residence_state_qualifies",
      label: "Residence state provides a substantially similar exclusion, imposes no individual income tax, or the income is constitutionally or federally exempt",
      kind: "flag", required: true,
      help: "§11-21-31(b)(4): one of the three residence-state prongs must hold.",
    },
  ],
};

export const WV_REGION: PayrollRegionWithholding = {
  region: "WV",
  label: "West Virginia income tax",
  implemented: true,
  // TSD 381 (Rev. September 2025): nonresident employers with employees
  // working in West Virginia must withhold unless a published exemption applies.
  taxesNonresidentWages: true,
  // West Virginia withholding applies to resident wages wherever earned. The
  // Schedule E credit depends on actual other-state tax paid and is claimed on
  // the employee's return, not netted from employer withholding.
  residentWithholding: "required",
  residentWithholdingImplemented: true,
  residentWithholdingMethod: { kind: "full" },
  certificateKey: "us_wv_it104",
  // West Virginia publishes no local wage income tax an employer withholds.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "West Virginia Code §11-21-71(a); Tax Division, Form WV IT-100.2A (March 2026); Form WV IT-104 "
    + "(Rev. 03/2023); TSD 381 (Rev. September 2025)",
};
