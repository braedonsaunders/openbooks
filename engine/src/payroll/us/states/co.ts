/**
 * Colorado income tax withholding — DR 1098, the prescribed employer worksheet.
 *
 * Source (fetched from tax.colorado.gov, not memory):
 *   DR 1098, Colorado Withholding Worksheet for Employers (rev. 10/21/25),
 *     2026 tables, https://tax.colorado.gov/sites/tax/files/documents/DR_1098_Colorado_Withholding_Worksheet_for_Employees.pdf
 *     and the current form listing at https://tax.colorado.gov/DR1098 /
 *     https://tax.colorado.gov/withholding-forms ("Only the most recent version
 *     of each form is published on this page").
 *   Form DR 0004, Colorado Employee Withholding Certificate — optional; when
 *     absent, DR 1098 line 2a falls back to the employee's federal W-4
 *     Step 1(c) filing status.
 *   Wage Withholding FAQs, tax.colorado.gov/withholding-FAQ — tables are no
 *     longer published; this worksheet is the only lawful method.
 *
 * The 2026 worksheet is the Department's current posted method. Its printed
 * defaults are 4.40%, $11,000 MFJ / qualifying surviving spouse, and $5,500
 * otherwise. A later revision must replace this edition.
 *
 * Worksheet order, verbatim:
 *   1c  annualize wages (period wages × pay periods in the year)
 *   2a  annual allowance (DR 0004 line 2, else the W-4 status default)
 *   2b  max(1c − 2a, 0)
 *   2c  2b × 4.40%
 *   2d  2c ÷ pay periods
 *   2e  additional amount (DR 0004 line 3)
 *   2f  2d + 2e
 *
 * The PDF prints no rounding rule. Each money step uses the pack's half-up-
 * to-the-cent convention (`mulRateCents` / `divIntCents`).
 *
 * All arithmetic is exact bigint. No floats.
 */
import { D, divIntCents, max0, mulInt, mulRateCents, rate6, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import { PayrollError } from "../../error.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  requireUsWageAllocation,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";

const RATES_MODULE = "engine/src/payroll/us/states/co.ts";

export interface CoYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  /**
   * Family and Medical Leave Insurance premium halves for the year (2026:
   * 0.88% split equally). Private-plan and small-employer treatments ride
   * a later employer-fact channel; the split itself is statutory.
   */
  famliEmployeeRate: string;
  famliEmployerRate: string;
  /** DR 1098 line 2a — married filing jointly or qualifying surviving spouse. */
  jointAllowance: string;
  /** DR 1098 line 2a — every other W-4 Step 1(c) status. */
  otherAllowance: string;
}

/**
 * The current DR 1098 edition for 2026 pay dates (revision 10/21/25).
 */
export const CO_RATES_2026: CoYearRates = {
  year: 2026,
  status: "published",
  rate: "0.044",
  jointAllowance: "11000",
  otherAllowance: "5500",
  // CDLE FY 2025-26 Performance Plan + December 2025 employer brief:
  // 2026 FAMLI premium 0.88%, split equally between employee and employer.
  famliEmployeeRate: "0.0044",
  famliEmployerRate: "0.0044",
};

const CO_EDITIONS_BY_YEAR: Record<number, CoYearRates> = {
  [CO_RATES_2026.year]: CO_RATES_2026,
};

export const CO_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "DR 1098 (10/21/25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Colorado Department of Revenue, 2026 DR 1098 Colorado Withholding Worksheet for Employers "
    + "(rev. 10/21/25), lines 1c–2f; Form DR 0004",
  status: "published",
  region: "CO",
}];

export function coRatesForPayDate(payDate: string): CoYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = CO_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(CO_WITHHOLDING, year);
  }
  return rates;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = coRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (period == null || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(CO_WITHHOLDING, P);
  }
  const militarySpouseCertificate = input.supportingCertificates?.us_co_dr1059;
  if (militarySpouseCertificate?.onFile) {
    requireMilitarySpouseEligibility(militarySpouseCertificate, "Colorado", [
      { key: "spouse_is_nonresident", description: "the spouse is not a Colorado resident" },
      { key: "servicemember_is_member", description: "the spouse is a qualifying U.S. servicemember" },
      { key: "servicemember_is_nonresident", description: "the servicemember is not a Colorado resident" },
      { key: "spouse_present_to_accompany", description: "the spouse is in Colorado solely to be with the servicemember" },
      { key: "servicemember_serving_under_orders", description: "the servicemember is serving in compliance with military orders" },
      { key: "notify_if_residency_changes", description: "the employee will notify the employer immediately if they become a Colorado resident" },
    ]);
    return {
      state: "CO",
      year: rates.year,
      tax: D(0n),
      taxSupplemental: D(0n),
      factors: { CO_MILITARY_SPOUSE_EXEMPT: "1" },
    };
  }
  // 49 U.S.C. §40116(f), Colorado Wage Withholding Tax Guide (Jan. 2026)
  // Part 2 "Exempt Wages for Nonresident Employees," air carrier row: an
  // air-carrier employee's compensation is exempt from Colorado income tax
  // when no more than 50% is earned in Colorado. The carrier status and the
  // nonresidence are attested on the supporting certificate; the share is
  // the verified work allocation — a missing allocation refuses by name,
  // never prices as zero, and a share above half falls through to the
  // ordinary formula below.
  const airCarrierCertificate = input.supportingCertificates?.us_co_air_carrier;
  if (airCarrierCertificate?.onFile) {
    for (const [key, description] of [
      ["is_air_carrier_employee", "the employee performs regularly assigned duties on aircraft in more than one state for an air carrier"],
      ["is_nonresident", "the employee is not a Colorado resident"],
    ] as const) {
      if (!certificateFlag(airCarrierCertificate, key)) {
        throw new PayrollError(
          "Colorado air-carrier withholding exemption requires proof that " + description,
        );
      }
    }
    if (input.basis !== "nonresident") {
      throw new PayrollError(
        "Colorado air-carrier withholding exemption contradicts this run's resident basis — "
        + "the 49 U.S.C. §40116(f) exemption never applies to the residence state. Correct the "
        + "basis or remove the air-carrier certificate",
      );
    }
    const allocation = requireUsWageAllocation(input.wageAllocations, "CO", null);
    if (rate6(allocation.workShare) <= 500_000n) {
      return {
        state: "CO",
        year: rates.year,
        tax: D(0n),
        taxSupplemental: D(0n),
        factors: { CO_AIR_CARRIER_EXEMPT: "1" },
      };
    }
  }
  // DR 1098 says to skip its calculation and withhold zero when the employee
  // filed only an exempt W-4. With a separate DR 0004 on file, use that state
  // certificate's instructions instead of treating the W-4 as the only form.
  if (input.federalTaxExempt && !input.stateCertificateOnFile) {
    return {
      state: "CO",
      year: rates.year,
      tax: D(0n),
      taxSupplemental: D(0n),
      factors: {},
    };
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // Federal carrier preemptions exclude qualifying pay from NONRESIDENT
  // Colorado wages only: 49 USC 11502 (rail) and 14503 (motor) exempt
  // regularly assigned multistate carrier pay outright. (Air-carrier pay
  // rides the us_co_air_carrier attestation above, never this path.) A
  // Colorado resident's carrier pay stays taxable here. Only affirmatively
  // classified component dollars are excluded — unclassified pay is ordinary
  // wages, never assumed exempt.
  const exemptionAmount = (...classes: readonly string[]): bigint =>
    (input.statutoryExemptionAmounts ?? [])
      .filter((item) => item.category !== null && classes.includes(item.category))
      .reduce((total, item) => total + U(item.amount), 0n);
  let wages = U(input.wages) + U(input.supplemental ?? "0");
  if (input.basis === "nonresident") {
    const carrierExempt = exemptionAmount("rail_carrier", "motor_carrier");
    if (carrierExempt > 0n) {
      wages -= carrierExempt;
      trace("CO_EXEMPT_CARRIER_WAGES", carrierExempt);
    }
  }
  if (input.basis === "nonresident") {
    const allocation = requireUsWageAllocation(input.wageAllocations, "CO", null);
    wages = mulRateCents(wages, allocation.workShare);
    trace("CO_NONRESIDENT_WAGES", wages);
  }
  const annualWages = mulInt(wages, P);
  trace("CO_ANNUAL_WAGES", annualWages);

  const enteredAllowance = certificateAmount(input.certificate, "annual_allowance");
  const annualAllowance = enteredAllowance != null
    ? U(enteredAllowance)
    : U(input.federalFilingStatus === "married_joint"
      ? rates.jointAllowance
      : rates.otherAllowance);
  trace("CO_ANNUAL_ALLOWANCE", annualAllowance);

  const taxable = max0(annualWages - annualAllowance);
  trace("CO_ANNUAL_TAXABLE", taxable);

  const annualTax = mulRateCents(taxable, rates.rate);
  trace("CO_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("CO_WITHHELD", total);

  return {
    state: "CO",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the DR 1098 worksheet's own — see the module header.
 */
/**
 * Family and Medical Leave Insurance premium — the 0.44% employee share
 * withheld and the matching 0.44% employer contribution, on covered wages.
 * Computed beside DR 1098 income tax, never folded into it.
 */
export function coFamliWithholding(
  payDate: string, coveredWages: string,
): { employee: string; employer: string } {
  const rates = coRatesForPayDate(payDate);
  return {
    employee: D(mulRateCents(U(coveredWages), rates.famliEmployeeRate)),
    employer: D(mulRateCents(U(coveredWages), rates.famliEmployerRate)),
  };
}

export const CO_FACTOR_LABELS: Readonly<Record<string, string>> = {
  CO_MILITARY_SPOUSE_EXEMPT: "Colorado qualifying military-spouse wages exempt from withholding",
  CO_FAMLI_EMPLOYEE: "Colorado FAMLI employee premium",
  CO_FAMLI_EMPLOYER: "Colorado FAMLI employer contribution",
  CO_AIR_CARRIER_EXEMPT: "Colorado air-carrier wages exempt under 49 U.S.C. §40116(f) (≤50% earned in Colorado)",
  CO_EXEMPT_CARRIER_WAGES: "Colorado federally exempt nonresident rail/motor carrier wages",
  CO_NONRESIDENT_WAGES: "Colorado apportioned nonresident wages",
  CO_ANNUAL_WAGES: "Colorado annualized wages",
  CO_ANNUAL_ALLOWANCE: "Colorado annual allowance",
  CO_ANNUAL_TAXABLE: "Colorado taxable income (annual)",
  CO_ANNUAL_TAX: "Colorado tax (annual)",
  CO_WITHHELD: "Colorado tax withheld this period",
};

export const CO_WITHHOLDING: UsStateWithholdingEngine = {
  state: "CO",
  label: "Colorado income tax",
  certificateKey: "us_co_dr0004",
  supportingCertificateKeys: ["us_co_dr1059", "us_co_air_carrier"],
  ratesModule: RATES_MODULE,
  editions: CO_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/** Colorado Form DR 0004 — optional. Absent, DR 1098 uses the federal W-4 status. */
export const CO_CERTIFICATE: PayrollCertificate = {
  key: "us_co_dr0004",
  form: "DR 0004",
  label: "Colorado Employee Withholding Certificate",
  scope: { level: "region", region: "CO" },
  purpose: "withholding",
  citation:
    "Colorado Form DR 0004; 2026 DR 1098 (rev. 10/21/25) lines 2a and 2e; "
    + "tax.colorado.gov/withholding-FAQ",
  summary:
    "Optional Colorado certificate. When line 2 is blank or no DR 0004 is on file, DR 1098 "
    + "uses the employee's federal W-4 Step 1(c) filing status and withholds no extra amount.",
  storage: "certificate_rows",
  fields: [
    {
      key: "annual_allowance",
      label: "Line 2 — Annual withholding allowance",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "If filled, this is DR 1098 line 2a in full. If blank — or no DR 0004 is on file — "
        + "line 2a is $11,000 for married filing jointly or qualifying surviving spouse, "
        + "and $5,500 otherwise, exactly as the 2026 worksheet prints.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional Colorado withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Added after the 4.40% calculation (DR 1098 line 2e). A pre-2022 extra-withholding "
        + "request stays in force until the employee files a new certificate.",
    },
  ],
};

/** Colorado DR 1059, the calendar-year affidavit for a qualifying nonresident military spouse. */
export const CO_DR1059_CERTIFICATE: PayrollCertificate = {
  key: "us_co_dr1059",
  form: "DR 1059",
  label: "Colorado Affidavit of Exemption for the Nonresident Spouse of a U.S. Servicemember",
  scope: { level: "region", region: "CO" },
  purpose: "withholding",
  validity: { kind: "calendar_year_end" },
  citation:
    "Colorado Department of Revenue, DR 1059 (07/20/23); Income Tax Topics: Military Servicemembers (Feb. 2025)",
  summary:
    "A calendar-year affidavit. The spouse must be a nonresident and in Colorado solely to be with a servicemember serving in compliance with military orders.",
  storage: "certificate_rows",
  fields: [
    { key: "spouse_is_nonresident", label: "Spouse is not a Colorado resident", kind: "flag", help: "Required DR 1059 attestation 1." },
    { key: "servicemember_is_member", label: "Spouse is a U.S. servicemember", kind: "flag", help: "Required DR 1059 attestation 2." },
    { key: "servicemember_is_nonresident", label: "Servicemember is not a Colorado resident", kind: "flag", help: "Required DR 1059 attestation 3." },
    { key: "spouse_present_to_accompany", label: "Spouse is in Colorado solely to be with the servicemember", kind: "flag", help: "Required DR 1059 attestation 4." },
    { key: "servicemember_serving_under_orders", label: "Servicemember is serving in compliance with military orders", kind: "flag", help: "Required DR 1059 attestation 4." },
    { key: "notify_if_residency_changes", label: "Employee will notify employer immediately if they become a Colorado resident", kind: "flag", help: "Required DR 1059 attestation 5." },
  ],
};

/**
 * Air-carrier exemption record: no Colorado form claims the 49 U.S.C.
 * §40116(f) exemption, so the form names the employer's own record — the
 * carrier status and nonresidence attestations plus the verified
 * Colorado-earned share from the work allocation. On file, a ≤50% share
 * withholds zero; above half the ordinary formula prices.
 */
export const CO_AIR_CARRIER_CERTIFICATE: PayrollCertificate = {
  key: "us_co_air_carrier",
  form: "Air-carrier exemption record (employer-held)",
  label: "Colorado air-carrier exemption (49 U.S.C. §40116(f))",
  scope: { level: "region", region: "CO" },
  purpose: "withholding",
  citation:
    "49 U.S.C. §40116(f); Colorado Department of Revenue, 2026 Wage Withholding Tax Guide "
    + "(Jan. 2026), Part 2 “Exempt Wages for Nonresident Employees,” air carrier row",
  summary:
    "An air-carrier employee performing duties in more than one state is exempt from Colorado "
    + "income tax when no more than 50% of compensation is earned in Colorado.",
  storage: "certificate_rows",
  fields: [
    { key: "is_air_carrier_employee", label: "Employee performs regularly assigned duties on aircraft in more than one state for an air carrier", kind: "flag", help: "Required §40116(f) attestation 1." },
    { key: "is_nonresident", label: "Employee is not a Colorado resident", kind: "flag", help: "Required attestation 2: the exemption never applies to the residence state." },
  ],
};

export const CO_REGION: PayrollRegionWithholding = {
  region: "CO",
  label: "Colorado income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // tax.colorado.gov/withholding-tax-filing-requirements: withhold if the
  // employee is a Colorado resident (working anywhere) or a nonresident
  // performing services in Colorado. The out-of-state resident credit is not
  // modelled here, so residence-side withholding stays declared-not-implemented.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_co_dr0004",
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "2026 DR 1098 (rev. 10/21/25); Colorado withholding tax filing requirements",
};
