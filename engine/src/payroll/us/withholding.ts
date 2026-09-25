/**
 * From a RESOLVED LEVY to an AMOUNT — the US pack's own dispatch.
 *
 * The two halves are deliberately not merged, and this module is the seam:
 *
 *   `withholding-resolution.ts` decides WHICH jurisdictions withhold. It is
 *   pure, generic, and contains no state code.
 *   The state engines decide HOW MUCH. Each one is its own publication's
 *   algorithm and knows nothing about residence, reciprocity or conflict rules.
 *
 * Something has to join them, and if that something lives in
 * `engine/src/payroll/run.ts` then the pay run learns that Ohio has
 * municipalities and Michigan has cities — which is exactly how
 * `if (state === "PA")` gets written into generic code. So the join lives HERE,
 * inside the pack whose jurisdictions they are, and the pay run's US arm calls
 * one function that takes a levy and returns money.
 *
 * ===========================================================================
 * THE ONE RULE OF THIS MODULE: IT NEVER RETURNS ZERO BY ACCIDENT.
 * ===========================================================================
 *
 * Every path either computes a real amount or throws a sentence naming the
 * jurisdiction. `null` is returned for exactly one situation — a state that
 * levies no wage income tax at all — and that is a fact, not a gap.
 *
 * The trap this replaces is a two-line loop nobody would look at twice:
 *
 *     const engine = usStateWithholding(code);
 *     if (!engine) continue;              // ← silently zero for OH-WESTERVILLE
 *
 * `usStateWithholding` (the non-throwing lookup) answers null for an Ohio
 * municipality, an Ohio school district and every non-Detroit Michigan city,
 * because those genuinely have no published engine — their rate is
 * employer-entered. Skipping them there under-withholds every employee they
 * reach, forever, silently. Here they are dispatched to the pure functions that
 * take the employer's rate, and `requireUsStateWithholding` is the last branch:
 * an unknown code THROWS naming itself.
 */
import {
  certificateAmount,
  certificateCode,
  certificateCount,
  certificateFlag,
  emptyResolvedCertificate,
  type ResolvedCertificate,
} from "../certificates.ts";
import { add as addMoney, fromUnits, mulRatio, roundDiv, toUnits } from "../../money/money.ts";
import {
  adjustResidentWithholding,
  residentWaivedWages,
  type ResolvedWithholdingLevy,
} from "../withholding-resolution.ts";
import { subRegionLevy } from "../withholding-jurisdictions.ts";
import { PayrollError } from "../error.ts";
import type { PayrollTaxBases } from "../pack-types.ts";
import { D, mulRateCents, rate6, U } from "../canada/decimal.ts";
import type { UsSupplementalWageAmount, UsSupplementalWageCategory } from "../supplemental-wages.ts";
import type { UsStatutoryExemptionAmount } from "../statutory-exemptions.ts";
import { NO_WITHHOLDING_STATES, US_STATES, ratesForPayDate } from "./rates.ts";
import {
  miCityWithholding,
  ohMunicipalWithholding,
  ohSchoolDistrict,
  ohSchoolDistrictWithholding,
  requireUsStateWithholding,
  usStateWithholding,
  type UsStateYtd,
} from "./states/index.ts";
import { act32LocalEit, localServicesTaxPerPeriod } from "./states/pa.ts";
import { mdDelawareResidentTax, mdDelawareScheduleApplies } from "./states/md.ts";
import { inCounty, inCountyWithholding } from "./states/in.ts";
import { orTransitWithholding } from "./states/or.ts";
import {
  requireUsResidentWithholdingFacts,
  requireUsSourceWages,
  requireUsWageAllocation,
  type UsResidentWithholdingFacts,
  type UsWageAllocation,
  type UsStateWithholdingInput,
} from "./states/types.ts";

export class UsWithholdingError extends PayrollError {}

export interface UsSupplementalFlatMethod {
  kind: "flat";
  rates: readonly { effectiveFrom: string; rate: string; source: string }[];
  categoryRates?: readonly {
    category: UsSupplementalWageCategory;
    rates: readonly { effectiveFrom: string; rate: string; source: string }[];
  }[];
  requiresRegularWithholding?: boolean;
  rounding?: "whole_dollar";
}

export type UsSeparateSupplementalSubRegionMethod = UsSupplementalFlatMethod | {
  kind: "refuse";
  detail: string;
};

export type UsSeparateSupplementalMethod =
  | { kind: "refuse"; detail: string }
  | { kind: "not_applicable" }
  | { kind: "aggregate"; source: string }
  | { kind: "differential"; source: string }
  // The state engine prices the separately paid supplement itself from the
  // timed input (a YTD-, county- or basis-dependent rule no static rate can
  // carry). The dispatch hands the full timed input to the engine instead
  // of computing a flat leg around it.
  | { kind: "engine"; source: string }
  | (UsSupplementalFlatMethod & {
    subRegionMethods?: Readonly<Record<string, UsSeparateSupplementalSubRegionMethod>>;
  });

export type UsCombinedSupplementalMethod =
  | { kind: "state_formula" }
  | {
    kind: "flat_supplemental";
    rates: readonly { effectiveFrom: string; rate: string; source: string }[];
    honorsCertificateExemption?: true;
  };

/**
 * State method declarations for a supplemental check paid apart from regular
 * wages. Every US jurisdiction is present so adding a state to `US_STATES`
 * creates a compile-time obligation to declare its supplemental treatment.
 * The current tax states refuse until their official separate-payment method
 * and required facts are implemented; no-tax jurisdictions have no state
 * withholding to calculate.
 */
const US_DEFAULT_SEPARATE_SUPPLEMENTAL_METHODS = Object.fromEntries(
  US_STATES.map((state) => [
    state,
    NO_WITHHOLDING_STATES.has(state)
      ? { kind: "not_applicable" as const }
      : { kind: "refuse" as const, detail: "the state method is not yet transcribed" },
  ]),
) as Readonly<Record<(typeof US_STATES)[number], UsSeparateSupplementalMethod>>;

export const US_SEPARATE_SUPPLEMENTAL_METHODS = {
  ...US_DEFAULT_SEPARATE_SUPPLEMENTAL_METHODS,
  CA: {
    kind: "flat",
    rates: [],
    // California DE 44 Rev. 52 (4-26), p. 18 distinguishes bonuses/stock
    // options from other supplemental wages when the payment is separate.
    categoryRates: [
      {
        category: "bonus_or_stock_option",
        rates: [{
          effectiveFrom: "2026-01-01", rate: "0.1023",
          source: "https://edd.ca.gov/pdf_pub_ctr/de44.pdf",
        }],
      },
      {
        category: "other",
        rates: [{
          effectiveFrom: "2026-01-01", rate: "0.066",
          source: "https://edd.ca.gov/pdf_pub_ctr/de44.pdf",
        }],
      },
    ],
  } as const,
  AL: {
    kind: "flat",
    // Alabama Withholding Tax Tables / Booklet A, January 2026, p. 3.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.05",
      source: "https://www.revenue.alabama.gov/wp-content/uploads/2026/01/whbooklet_0126.pdf",
    }],
  } as const,
  DE: {
    kind: "refuse",
    // Delaware Employer's Guide Section 14:
    // https://revenue.delaware.gov/employers-guide-withholding-regulations-employers-duties/
    detail: "Delaware Employer's Guide Section 14 requires the incremental withholding differential and its regular-pay basis",
  } as const,
  GA: {
    kind: "flat",
    // 2026 Georgia Employer's Tax Guide, O.C.G.A. §48-7-101(f)(5): separately
    // paid bonuses use the income-tax rate effective on the payment date.
    rates: [
      {
        effectiveFrom: "2026-01-01", rate: "0.0519",
        source: "https://dor.georgia.gov/document/document-document/2026-employers-tax-guide-updated-june-2026/download",
      },
      {
        effectiveFrom: "2026-05-11", rate: "0.0499",
        source: "https://dor.georgia.gov/document/document-document/2026-employers-tax-guide-updated-june-2026/download",
      },
    ],
  } as const,
  ID: {
    kind: "flat",
    // Idaho State Tax Commission, Computing Withholding, "Supplemental
    // wages": a separately issued supplemental payment is withheld by
    // multiplying it by 5.3%. Idaho rounds withholding to the nearest whole
    // dollar. Dated to the transcribed July 23 2026 percentage-table
    // edition (EPB00744), matching the ID engine's own edition floor.
    rates: [{
      effectiveFrom: "2026-07-23", rate: "0.053",
      source: "https://tax.idaho.gov/taxes/income-tax/withholding/computing/",
    }],
    rounding: "whole_dollar",
  } as const,
  KS: {
    kind: "flat",
    // Kansas DOR KW-100, "Supplemental Wages": Kansas follows the federal
    // method, so a separately stated supplemental payment under federal
    // percentage-method withholding takes 5% of gross. This declaration
    // serves the separately paid path only; supplements paid together with
    // regular wages keep the ordinary combined state-formula path.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.05",
      source: "https://www.ksrevenue.gov/kw100.html",
    }],
  } as const,
  MA: {
    kind: "engine",
    // Massachusetts Circular M (Rev. 12/25), section G, p. 13: a
    // supplemental payment takes 5%, except the slice of (payment plus
    // annualized regular wages plus prior supplemental pay) above the
    // $1,107,750 surtax threshold, which takes 9%. The YTD-dependent rule
    // cannot be a static rate, so the MA engine prices it from the timed
    // input (prior supplemental via the run's YTD) instead.
    source: "Massachusetts Circular M: Income Tax Withholding Tables at 5.0%, Effective January 1, 2026 (Rev. 12/25), section G",
  } as const,
  MD: {
    kind: "engine",
    // Comptroller of Maryland, 2026 Employer Withholding Guide, p. 9: a
    // separately paid lump-sum annual bonus takes the 6.50% highest state
    // rate plus the highest local for the county of residence (2.25%
    // special rate for nonresidents). The rate is county- and
    // basis-dependent, so the MD engine prices it from the timed input
    // instead of a static rate declaration.
    source: "https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/instructions/withholding/2026/withholding-guide.pdf",
  } as const,
  MI: {
    kind: "flat",
    // Michigan Form 446 (2026), "Bonuses and Other Payments": separately
    // paid supplemental compensation is withheld at 4.25% without exemptions.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.0425",
      source: "https://www.michigan.gov/taxes/-/media/Project/Websites/taxes/Forms/SUW/TY2026/446_Withholding-Guide_2026.pdf",
    }],
  } as const,
  MN: {
    kind: "flat",
    // Minnesota 2026 Withholding Tax Instructions, p. 7, Method 2.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.0625",
      source: "https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf",
    }],
  } as const,
  MO: {
    kind: "flat",
    // Missouri DOR Form 4282 Employer's Tax Guide (Rev. 03-2026), §7.A: an
    // employer already withholding Missouri tax from regular wages may
    // withhold 4.7% of separately paid supplemental wages instead of the
    // same-period aggregate difference. The flag below enforces the
    // "regular withholding in effect" condition; without that history the
    // dispatch refuses and names the aggregate-basis alternative.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.047",
      source: "https://dor.mo.gov/forms/4282_2026.pdf",
    }],
    requiresRegularWithholding: true,
  } as const,
  MT: {
    kind: "flat",
    // Montana Employer and Information Agent Guide with Tax Tables – 2026,
    // p. 3: for a separately paid supplemental, an employer may use a flat 5%.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.05",
      source: "https://revenuefiles.mt.gov/files/Forms/Montana_Employer_and_Information_Agent_Guide_with_Tax_Tables.pdf",
    }],
  } as const,
  NY: {
    kind: "flat",
    // NYS-50-T-NYS (1/26), p. 3: the 11.70% separate supplemental rate is
    // available only when the employee's regular wages had NYS withholding.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.1170",
      source: "https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf",
    }],
    requiresRegularWithholding: true,
    subRegionMethods: {
      NYC: {
        kind: "flat",
        // NYS-50-T-NYC (1/26), p. 3: NYC separately-paid supplemental wages
        // use 4.25% when tax was withheld from regular NYC wages.
        rates: [{
          effectiveFrom: "2026-01-01", rate: "0.0425",
          source: "https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nyc.pdf",
        }],
        requiresRegularWithholding: true,
      },
      YONKERS: {
        kind: "refuse",
        detail: "New York separate-supplemental treatment for Yonkers depends on its resident/nonresident schedule and is not transcribed",
      },
    },
  } as const,
  NC: {
    kind: "flat",
    // NC-30 (2026), §12: the 4.09% option requires tax withheld from regular
    // wages; otherwise §12's aggregate method is mandatory.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.0409",
      source: "https://www.ncdor.gov/income-tax-withholding-tables-and-instructions-employers/open",
    }],
    requiresRegularWithholding: true,
    rounding: "whole_dollar",
  } as const,
  ND: {
    kind: "flat",
    // North Dakota 2026 Income Tax Withholding Rates and Instructions,
    // Supplemental Wages: Option 1 is 1.50% of the supplemental wage.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.015",
      source: "https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf",
    }],
  } as const,
  NE: {
    kind: "flat",
    // Nebraska Circular EN 2026, Bonuses, Supplemental Wages, and Taxable
    // Awards: employers may elect a flat 3.5% rate for separate payments.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.035",
      source: "https://revenue.nebraska.gov/sites/revenue.nebraska.gov/files/doc/business/Cir_En_2025/2026cir_en_whole.pdf",
    }],
  } as const,
  VA: {
    kind: "flat",
    // Virginia Employer Withholding Instructions, p. 19: 5.75% is the
    // separate-supplemental election when regular wages had tax withheld.
    rates: [{
      effectiveFrom: "2025-07-02", rate: "0.0575",
      source: "https://www.tax.virginia.gov/sites/default/files/vatax-pdf/employer-withholding-instructions.pdf",
    }],
    requiresRegularWithholding: true,
  } as const,
  WI: {
    kind: "aggregate",
    // Wisconsin DOR Publication W-166, Withholding Tax Guide (January
    // 2026), Alternate Method (pp. 25–26): the separately paid supplement
    // is the difference between withholding on (regular plus supplement)
    // and withholding on regular alone, on the current period's wages.
    source: "Wisconsin DOR Publication W-166, Withholding Tax Guide (January 2026), Alternate Method (pp. 25–26)",
  } as const,
} satisfies Readonly<Record<(typeof US_STATES)[number], UsSeparateSupplementalMethod>>;

/**
 * Declared withholding for a bonus included with regular wages. Most state
 * formula engines price the combined amount; a jurisdiction that prescribes a
 * distinct supplemental rate overrides that method here.
 */
const US_DEFAULT_COMBINED_SUPPLEMENTAL_METHODS = Object.fromEntries(
  US_STATES.map((state) => [state, { kind: "state_formula" as const }]),
) as Readonly<Record<(typeof US_STATES)[number], UsCombinedSupplementalMethod>>;

export const US_COMBINED_SUPPLEMENTAL_METHODS = {
  ...US_DEFAULT_COMBINED_SUPPLEMENTAL_METHODS,
  AR: {
    kind: "flat_supplemental",
    // Arkansas DFA 2026 Employer Instructions, p. 4: tax the regular wages
    // with the formula and deduct 3.9% of bonuses paid at the same time.
    rates: [{
      effectiveFrom: "2026-01-01", rate: "0.039",
      source: "https://www.dfa.arkansas.gov/wp-content/uploads/withholdInstructions_2026.pdf",
    }],
    honorsCertificateExemption: true,
  },
} satisfies Readonly<Record<(typeof US_STATES)[number], UsCombinedSupplementalMethod>>;

/**
 * Trace-factor labels for the stub calculation trace, keyed by the
 * tenant-rate sub-region factor keys this module emits (Ohio municipal and
 * school-district taxes, Michigan city taxes, PA Act 32 EIT). The codes
 * inside them are employer-entered jurisdictions, so the labels name the
 * level, not the place.
 */
export const US_LOCAL_FACTOR_LABELS: Readonly<Record<string, string>> = {
  OH_MUNICIPAL: "Ohio municipality (code)",
  OH_MUNICIPAL_RATE: "Ohio municipal tax rate (employer-entered)",
  OH_MUNICIPAL_TAX: "Ohio municipal tax",
  PA_EIT_PSD: "PA Act 32 PSD code",
  PA_EIT_RATE: "PA local EIT rate (employer-entered)",
  PA_EIT_TAX: "PA local earned income tax",
  OR_TRANSIT_DISTRICT: "Oregon transit district (code)",
  OR_TRANSIT_RATE: "Oregon transit payroll-tax rate (employer-entered)",
  MNPL_SMALL_EMPLOYER: "Minnesota Paid Leave small-employer qualification (DEED-notified)",
  OR_TRANSIT_TAX: "Oregon transit payroll tax (employer)",
};

export const US_SUPPLEMENTAL_FACTOR_LABELS: Readonly<Record<string, string>> = {
  US_SUPPLEMENTAL_METHOD: "US supplemental withholding method",
  US_SUPPLEMENTAL_RATE: "US supplemental withholding rate",
  US_SUPPLEMENTAL_TAX: "US supplemental tax withheld",
};

/**
 * A sub-region levy whose code differs from the engine's own state code.
 *
 * Small, explicit and in one place. The pack's levy codes are the jurisdiction
 * names an operator types (`PHILADELPHIA`); the engines' codes are the ones the
 * conformance goldens were written against (`PA-PHILA`). Deriving one from the
 * other with string surgery would work for three of the four and break on the
 * fourth.
 */
const SUB_REGION_ENGINE_CODE: Readonly<Record<string, string>> = {
  "NY:NYC": "NY-NYC",
  "NY:YONKERS": "NY-YONKERS",
  "PA:PHILADELPHIA": "PA-PHILA",
  "MI:DETROIT": "MI-DETROIT",
  "DE:WILMINGTON": "DE-WILM",
  "KY:LOUISVILLE": "KY-LOU",
};

export interface UsWithholdingInput {
  levy: ResolvedWithholdingLevy;
  payDate: string;
  /** Utah only: the Commission's effective-dated employer waiver covers the payroll period. */
  employerWithholdingWaiver?: boolean;
  /** First day of the payroll period; Utah's tables key to this date. */
  periodStart?: string;
  /** Employer headcount for state-specific statutory thresholds. */
  employerEmployeeCount?: number;
  /**
   * The last day of the payroll period. Ohio keys its table sets to the period
   * END rather than the pay date and REFUSES without it — see
   * `UsStateWithholdingInput.periodEnd`.
   */
  periodEnd: string;
  periodsPerYear: number;
  /** Periodic state-taxable wages. */
  wages: string;
  /** Statutory wage bases declared by the resolved state's engine. */
  taxableWageBases?: PayrollTaxBases;
  /** Federal W-4 Step 1(c) status for state methods that use the federal form. */
  federalFilingStatus?: "single" | "married_joint" | "head_household";
  /** Federal W-4 additional amount, for states that declare a fallback share. */
  federalAdditionalPerPeriod?: string;
  /** Preserved status and allowances from an effective 2019-or-earlier federal W-4. */
  federalLegacyW4?: UsStateWithholdingInput["federalLegacyW4"];
  /** Federal W-4 exempt claim, used by state rules that inherit it. */
  federalTaxExempt?: boolean;
  /** Supplemental wages this period. */
  supplemental?: string;
  /** Per-category taxable supplemental amounts, sourced from earning components. */
  supplementalWageAmounts?: readonly UsSupplementalWageAmount[];
  /** Per-class federally exempt earning amounts, sourced from earning components. */
  statutoryExemptionAmounts?: readonly UsStatutoryExemptionAmount[];
  /** Whether supplemental wages were paid with regular wages or separately. */
  supplementalPaymentTiming?: "combined" | "separate";
  /** Committed same-year regular-wage withholding history for conditional flat methods. */
  regularWageTaxWithheldThisYear?: boolean;
  /** Prior committed tax-factor keys, including local levies. */
  regularWageTaxWithheldFor?: readonly string[];
  /** Resolved exact work shares used by state and local allocation rules. */
  wageAllocations?: readonly UsWageAllocation[];
  /**
   * Every other Michigan taxing city a Detroit resident works in this
   * period, with that city's entered nonresident rate (null when unentered —
   * the Detroit engine refuses it by name). The resident rate prices per
   * work-city wage allocation, never first-match.
   */
  detroitOtherCities?: { code: string; nonresidentRate: string | null }[];
  /** Verified out-of-region wage source and current work-region tax amounts. */
  residentWithholdingFacts?: UsResidentWithholdingFacts;
  /** Current paycheck's computed federal income-tax withholding. */
  federalIncomeTax: string;
  /** Employee's total-exemption claim on the federal Form W-4, when known. */
  federalWithholdingExempt?: boolean;
  /** Tax-qualified deductions from this period, used by Nebraska's floor. */
  taxQualifiedDeductions?: string;
  /**
   * The employee's resolved answers on a pack-declared certificate, or null
   * when they have filed none of that certificate.
   */
  certificateFor: (key: string) => ResolvedCertificate | null;
  /** Employee's residence region for pack-declared subject-scope checks. */
  residenceRegion?: string;
  /** The REGION's withholding this period — the Yonkers surcharge's base. */
  regionTax?: string;
  /** Employee-side FICA, for the Massachusetts subtraction. */
  socialInsuranceDeducted?: { period: string; yearToDate?: string };
  ytd?: UsStateYtd;
  /**
   * The employer-entered rate values for a `tenant`-sourced levy, from
   * `payroll_statutory_rates` at `sub_region` scope. Undefined means the
   * employer has not entered them, which every caller of it REFUSES on.
   */
  tenantRates: (rateKey: string, subRegion: string) => Record<string, string> | undefined;
}

export interface UsWithholdingResult {
  /** The engine's or jurisdiction's own code, for the stub trace. */
  code: string;
  /** What the jurisdiction calls the tax, for the stub line. */
  label: string;
  tax: string;
  statutoryTax?: string;
  additionalWithholding?: string;
  factors: Record<string, string>;
  /** Local W-2 box 18 wages; absent when a work-locality split is unknown. */
  localTaxableWages?: string;
  /**
   * Further stub lines the same levy assesses beyond the primary tax — the
   * PA worksite Local Services Tax rides the settled Act 32 levy this way.
   * Posted by the compute pass under the shared local-income-tax component
   * with each entry's own code, so a second tax never dissolves into the
   * first one's line.
   */
  additionalLines?: { code: string; label: string; tax: string; factors: Record<string, string> }[];
}

export function utahEmployerWaiverResult(): UsWithholdingResult {
  return {
    code: "UT",
    label: "Utah income tax",
    tax: "0.0000",
    factors: { UT_EMPLOYER_WAIVER: "approved", UT_TAX: "0.0000" },
  };
}

/**
 * The withholding for ONE resolved levy, or null where the jurisdiction levies
 * no wage income tax.
 */
export function computeUsWithholding(input: UsWithholdingInput): UsWithholdingResult | null {
  const { levy } = input;
  // A Commission-approved waiver suppresses Utah withholding entirely: no
  // wage bases are required and no state engine runs for this levy.
  if (input.employerWithholdingWaiver === true && levy.level === "region" && levy.region === "UT") {
    return utahEmployerWaiverResult();
  }
  const regionalEngine = levy.level === "region" ? requireUsStateWithholding(levy.region) : null;
  const declaredBase = (kind: "income" | "nonPeriodic", fallback: string): string => {
    const key = regionalEngine?.taxableWageBases?.[kind];
    if (!key) return fallback;
    const value = input.taxableWageBases?.[key];
    if (value == null) {
      throw new UsWithholdingError(
        `${regionalEngine?.label ?? levy.label} requires the declared ${kind} wage base ${key}; `
        + "recalculate with the pack's deduction treatments before withholding — refused by name",
      );
    }
    // A derived supplemental base goes negative when pre-tax reductions exceed
    // that period's supplemental pay; supplemental pay itself is never negative,
    // so floor the artifact here instead of double-subtracting it in every state.
    if (kind === "nonPeriodic" && U(value) < 0n) return "0";
    return value;
  };
  const stateWages = declaredBase("income", input.wages);
  const stateSupplemental = declaredBase("nonPeriodic", input.supplemental ?? "0");
  const localTaxableWages = (() => {
    if (levy.level !== "sub_region") return undefined;
    if (levy.withholdingMethod) return undefined;
    const compensation = addMoney(input.wages, input.supplemental ?? "0");
    if (levy.side === "residence") return compensation;
    const matching = (input.wageAllocations ?? []).filter(
      (allocation) => allocation.region === levy.region && allocation.subRegion === levy.subRegion,
    );
    if (matching.length === 0) return undefined;
    const allocation = requireUsWageAllocation(input.wageAllocations, levy.region, levy.subRegion!);
    return mulRatio(compensation, rate6(allocation.workShare), 1_000_000n);
  })();
  const localWageTrace = localTaxableWages === undefined ? {} : { localTaxableWages };
  const residentMethod = levy.residentWithholdingMethod ?? { kind: "full" as const };
  const needsResidentWorkFacts = residentMethod.kind !== "full";
  const residentWithholdingFacts = levy.basis === "resident_out_of_region" && needsResidentWorkFacts
    ? requireUsResidentWithholdingFacts(
      input.residentWithholdingFacts,
      levy.creditAgainstRegion,
      levy.region,
    )
    : input.residentWithholdingFacts;
  const supplemental = input.supplemental == null ? 0n : U(input.supplemental);
  const waiverWages = levy.basis === "resident_out_of_region" && residentWithholdingFacts
    ? toUnits(residentWaivedWages(
      residentWithholdingFacts.workRegionTaxes,
      residentWithholdingFacts.workRegionWages,
      levy.residentWithholdingMethod,
    ))
    : 0n;
  const totalResidentWages = toUnits(input.wages) + supplemental;
  const eligibleResidentWages = totalResidentWages > waiverWages
    ? totalResidentWages - waiverWages
    : 0n;
  const residentWages = waiverWages === 0n || totalResidentWages === 0n
    ? stateWages
    : fromUnits(roundDiv(toUnits(stateWages) * eligibleResidentWages, totalResidentWages));
  const residentSupplemental = waiverWages === 0n || totalResidentWages === 0n
    ? stateSupplemental
    : fromUnits(roundDiv(toUnits(stateSupplemental) * eligibleResidentWages, totalResidentWages));
  const waiverOutcome = levy.basis === "resident_out_of_region"
    && residentMethod.kind === "waive_when_work_region_withheld"
    && waiverWages > 0n
    ? "eligible_to_waive_covered_wages"
    : "withheld";
  // Certificate resolvers are keyed by declaration. A mismatched result
  // resolves as absent so a caller cannot accidentally apply another form's
  // answers to this levy (supporting certificates declare different fields,
  // and the state guards refuse undeclared-field reads by name).
  const certificateForKey = (key: string) => {
    const resolved = input.certificateFor(key);
    return resolved?.certificate.key === key ? resolved : null;
  };
  const certificate = levy.certificateKey
    ? certificateForKey(levy.certificateKey) ?? emptyResolvedCertificate(levy.certificateKey)
    : emptyResolvedCertificate(`${levy.label} publishes no withholding certificate`);
  const supportingCertificates = (keys: readonly string[] | undefined) =>
    Object.fromEntries((keys ?? []).map((key) => [
      key,
      certificateForKey(key) ?? emptyResolvedCertificate(key),
    ]));
  let separateFlatRate: string | undefined;
  let separateFlatWholeDollar = false;
  let separateCategoryAmounts: { category: UsSupplementalWageCategory; amount: string; rate: string }[] | undefined;
  // Aggregate method: the supplement is priced as the difference between
  // withholding on (regular + supplement) and withholding on regular alone,
  // both through the state engine on the current period's regular wages.
  let separateAggregate = false;
  let combinedFlatRate: string | undefined;
  let combinedFlatHonorsCertificateExemption = false;
  if (supplemental > 0n && input.supplementalPaymentTiming == null) {
    throw new UsWithholdingError(
      `separately paid or combined supplemental timing is missing for ${levy.label}; record whether this payment was issued with regular wages before calculating — refused by name`,
    );
  }
  // A declared flat-rate method prices from the declaration when the caller
  // did not thread the levy's own method through: depending on caller
  // threading leaves declared-but-implemented levies (Oregon STT) refusing
  // as unwired. The tenant-rate body below prices assessed and elected
  // levies (Vermont CCC, Minnesota Paid Leave) off the same method shape.
  const levyMethod = levy.withholdingMethod
    ?? (levy.level === "sub_region" && levy.subRegion
      ? subRegionLevy("US", levy.region, levy.subRegion)?.withholdingMethod
      : undefined);
  if (levyMethod?.kind === "flat_rate") {
    const method = levyMethod;
    if (method.effectiveFrom !== undefined && input.payDate < method.effectiveFrom) {
      // The levy did not exist yet on the pay date (Minnesota Paid Leave
      // before January 1, 2026): nothing is owed, so no line prices — never
      // a refusal, and never a backdated rate.
      return null;
    }
    const declared = levy.level === "sub_region" && levy.subRegion
      ? subRegionLevy("US", levy.region, levy.subRegion)
      : undefined;
    // Wrong-pocket guard for this path: an employer flat-rate levy (Vermont
    // CCC) routed here would post the employer's tax as a stub deduction —
    // out of the employee's cheque. Same refusal as the guard below; the
    // employer path is the only way it posts.
    if (declared?.pocket === "employer") {
      throw new UsWithholdingError(
        `${levy.label} is an employer payroll tax, not employee withholding — `
        + "it posts as an employer contribution, never as a stub deduction.",
      );
    }
    let rate: string;
    if (declared?.rateSource.kind === "tenant") {
      // An assessed or elected rate the employer enters (Vermont's CCC
      // employee share): pack-carried rates cannot hold it, because no
      // publication a release can carry supplies the employer's own figure.
      const entered = input.tenantRates(declared.rateSource.rateKey, levy.subRegion!)?.rate;
      if (entered == null || entered === "") {
        if (method.absentTenantRate === "skip") return null;
        throw new UsWithholdingError(
          `no ${levy.label} rate has been entered for ${input.payDate}; `
          + "the rate is employer-entered because no publication carries it — "
          + "enter the assessed figure before calculating; refused by name",
        );
      }
      let enteredRate: bigint;
      try {
        enteredRate = rate6(entered);
      } catch {
        throw new UsWithholdingError(
          `${levy.label} has an unreadable entered rate "${entered}"; `
          + "enter an exact decimal rate before calculating — refused by name",
        );
      }
      if (method.maxRate !== undefined && enteredRate > rate6(method.maxRate)) {
        throw new UsWithholdingError(
          `${levy.label} entered rate ${entered} exceeds the published maximum of ${method.maxRate}; `
          + "enter a rate within the statutory maximum before calculating — refused by name",
        );
      }
      rate = entered;
    } else {
      const published = method.rates
        .filter((entry) => entry.effectiveFrom <= input.payDate)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .at(-1);
      if (!published) {
        if (method.rates.length > 0
          && input.payDate < method.rates.map((entry) => entry.effectiveFrom).sort()[0]!) {
          // The levy did not exist yet on the pay date (a pre-introduction
          // run priced directly): nothing is owed, so no line prices — never
          // a refusal, and never a backdated rate.
          return null;
        }
        throw new UsWithholdingError(
          `${levy.label} has no published flat rate effective on ${input.payDate}; `
          + "transcribe the official effective rate before calculating — refused by name",
        );
      }
      rate = published.rate;
    }
    let base = addMoney(input.wages, input.supplemental ?? "0");
    if (levy.basis === "nonresident") {
      const allocation = requireUsWageAllocation(input.wageAllocations, levy.region, null);
      base = mulRatio(base, rate6(allocation.workShare), 1_000_000n);
    }
    if (method.wageBase === "social_security") {
      // A base-capped levy (Minnesota Paid Leave) prices only the remaining
      // room under the year's Social Security wage base — the federal rates'
      // figure, never a transcribed copy. No supplied history means the
      // caller never established it, which refuses; an exhausted base prices
      // zero, a fact, not a refusal.
      const history = input.ytd?.wages;
      if (history == null || history === "") {
        throw new UsWithholdingError(
          `${levy.label} needs the employee's priced base history this year to enforce its wage base; `
          + "recalculate with the year-to-date base before calculating — refused by name",
        );
      }
      const room = U(ratesForPayDate(input.payDate).fica.ssWageBase) - U(history);
      const covered = U(base);
      base = D(room <= 0n ? 0n : (covered < room ? covered : room));
    }
    const tax = D(mulRateCents(U(base), rate));
    return {
      code: levy.subRegion ?? levy.region,
      label: levy.label,
      tax,
      factors: {
        STATUTORY_LEVY_RATE: rate,
        STATUTORY_LEVY_BASE: base,
        STATUTORY_LEVY_TAX: tax,
        // The priced base under the levy's own posting key, so year-to-date
        // history accumulates on wages (rate-invariant) rather than on tax.
        ...(levy.statutoryComponent ? { [`${levy.statutoryComponent.systemKey}_BASE`]: base } : {}),
      },
    };
  }
  if (supplemental > 0n && input.supplementalPaymentTiming === "separate") {
    const declaredMethod = US_SEPARATE_SUPPLEMENTAL_METHODS[
      levy.region as keyof typeof US_SEPARATE_SUPPLEMENTAL_METHODS
    ];
    const subRegionMethods = declaredMethod.kind === "flat" && "subRegionMethods" in declaredMethod
      ? declaredMethod.subRegionMethods as Readonly<Record<string, UsSeparateSupplementalSubRegionMethod>>
      : undefined;
    const method: UsSeparateSupplementalMethod | UsSeparateSupplementalSubRegionMethod =
      input.levy.level === "sub_region" && subRegionMethods
        ? subRegionMethods[input.levy.subRegion!]
          ?? {
            kind: "refuse",
            detail: `no separate-supplemental method is declared for ${input.levy.region}/${input.levy.subRegion}`,
          }
        : declaredMethod;
    if (method.kind === "not_applicable") return null;
    if (method.kind === "refuse") {
      throw new UsWithholdingError(
        `${levy.label} separately paid supplemental wages require a declared state method; ${method.detail}. `
        + "Record the jurisdiction's official method and required inputs before calculating — refused by name",
      );
    }
    if (method.kind === "engine") {
      if (input.levy.level !== "region") {
        throw new UsWithholdingError(
          `${levy.label} separately paid supplemental wages route to the state engine, `
          + "which prices region-level supplements only — refused by name",
        );
      }
      const stateEngine = requireUsStateWithholding(input.levy.region);
      if (!stateEngine) return null;
      const routed = stateEngine.compute({
        payDate: input.payDate,
        periodStart: input.periodStart,
        employerEmployeeCount: input.employerEmployeeCount,
        periodEnd: input.periodEnd,
        periodsPerYear: input.periodsPerYear,
        wages: input.wages,
        federalFilingStatus: input.federalFilingStatus,
        federalLegacyW4: input.federalLegacyW4,
        federalTaxExempt: input.federalTaxExempt,
        supplemental: input.supplemental,
        supplementalPaymentTiming: input.supplementalPaymentTiming,
        federalIncomeTax: input.federalIncomeTax,
        federalWithholdingExempt: input.federalWithholdingExempt,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        supportingCertificates: supportingCertificates(stateEngine.supportingCertificateKeys),
        basis: levy.reach,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        statutoryExemptionAmounts: input.statutoryExemptionAmounts,
        ytd: input.ytd,
      });
      return {
        code: stateEngine.state, label: stateEngine.label, tax: routed.tax,
        factors: routed.factors, ...localWageTrace,
      };
    }
    if (method.kind === "aggregate") {
      separateAggregate = true;
    } else if (method.kind === "flat") {
      const hasRegularWithholding = input.levy.level === "region"
        ? input.regularWageTaxWithheldThisYear === true
        : input.regularWageTaxWithheldFor?.includes(
          `LIT_${input.levy.region}-${input.levy.subRegion}`,
        ) === true;
      if (
        "requiresRegularWithholding" in method && method.requiresRegularWithholding
        && !hasRegularWithholding
      ) {
        throw new UsWithholdingError(
          `${levy.label} cannot use its separate-supplemental flat rate without committed evidence of regular-wage withholding; `
          + "provide that history or the regular-period basis required by the aggregate method before calculating — refused by name",
        );
      }
      if (method.categoryRates && method.categoryRates.length > 0) {
        const categories = input.supplementalWageAmounts;
        const categoryTotal = categories?.reduce((total, item) => total + U(item.amount), 0n) ?? 0n;
        if (!categories || categories.length === 0 || categoryTotal !== supplemental) {
          throw new UsWithholdingError(
            `${levy.label} separate supplemental withholding needs earning-component amounts classified by the published wage category; `
            + "set each non-periodic earning component to Bonus or stock option or Other supplemental wage and recalculate — refused by name",
          );
        }
        const grouped = new Map<UsSupplementalWageCategory, bigint>();
        for (const item of categories) {
          if (item.category === null) {
            throw new UsWithholdingError(
              `${levy.label} separate supplemental wages include an unclassified earning component; `
              + "classify it as Bonus or stock option or Other supplemental wage in pay-component setup — refused by name",
            );
          }
          grouped.set(item.category, (grouped.get(item.category) ?? 0n) + U(item.amount));
        }
        separateCategoryAmounts = [];
        for (const [category, amount] of grouped) {
          const categoryMethod = method.categoryRates.find((entry) => entry.category === category);
          const applicable = categoryMethod?.rates
            .filter((rate) => rate.effectiveFrom <= input.payDate)
            .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
            .at(-1);
          if (!applicable) {
            throw new UsWithholdingError(
              `${levy.label} has no separate-supplemental rate for ${category} effective on ${input.payDate}; `
              + "transcribe the official category rate before calculating — refused by name",
            );
          }
          separateCategoryAmounts.push({ category, amount: D(amount), rate: applicable.rate });
        }
      } else {
        const applicable = method.rates
          .filter((rate) => rate.effectiveFrom <= input.payDate)
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
          .at(-1);
        if (!applicable) {
          throw new UsWithholdingError(
            `${levy.label} has no transcribed separate-supplemental flat rate for ${input.payDate}; `
            + "transcribe the official rate effective on the payment date before calculating — refused by name",
          );
        }
        separateFlatRate = applicable.rate;
        separateFlatWholeDollar = "rounding" in method && method.rounding === "whole_dollar";
      }
    } else {
      throw new UsWithholdingError(
        `${levy.label} separately paid supplemental method ${method.kind} is declared but its calculator is not available in this pack version — update the pack before calculating; refused by name`,
      );
    }
  }
  if (supplemental > 0n && input.supplementalPaymentTiming === "combined") {
    const method = US_COMBINED_SUPPLEMENTAL_METHODS[
      levy.region as keyof typeof US_COMBINED_SUPPLEMENTAL_METHODS
    ];
    if (method.kind === "flat_supplemental") {
      const applicable = method.rates
        .filter((rate) => rate.effectiveFrom <= input.payDate)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .at(-1);
      if (!applicable) {
        throw new UsWithholdingError(
          `${levy.label} has no transcribed combined-supplemental rate for ${input.payDate}; `
          + "transcribe the official rate effective on the payment date before calculating — refused by name",
        );
      }
      combinedFlatRate = applicable.rate;
      combinedFlatHonorsCertificateExemption = method.honorsCertificateExemption === true;
    }
  }

  if (levy.level === "region") {
    // Throws for a state that levies a tax the pack has not transcribed;
    // returns null ONLY for a state with no wage income tax at all.
    const engine = regionalEngine;
    if (!engine) return null;
    if (separateAggregate) {
      // Aggregate method (W-166 Alternate Method shape): the state engine
      // prices regular wages alone, then regular plus supplement as one
      // period amount; the supplement's share is the difference. Both legs
      // run timing-free so no flat election leaks in. Region-level only:
      // the basis is the current period's regular wages.
      if (input.levy.level !== "region") {
        throw new UsWithholdingError(
          `${levy.label} separately paid supplemental wages use the aggregate difference, `
          + "which prices region-level regular wages only — refused by name",
        );
      }
      const aggregateBase = {
        payDate: input.payDate,
        periodStart: input.periodStart,
        employerEmployeeCount: input.employerEmployeeCount,
        periodEnd: input.periodEnd,
        periodsPerYear: input.periodsPerYear,
        federalFilingStatus: input.federalFilingStatus,
        federalLegacyW4: input.federalLegacyW4,
        supplemental: "0",
        federalIncomeTax: input.federalIncomeTax,
        federalWithholdingExempt: input.federalWithholdingExempt,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
        basis: levy.reach,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        statutoryExemptionAmounts: input.statutoryExemptionAmounts,
        ytd: input.ytd,
      };
      const regular = engine.compute({ ...aggregateBase, wages: input.wages });
      const combined = engine.compute({ ...aggregateBase, wages: addAmounts(input.wages, input.supplemental) });
      const combinedExcess = U(combined.tax) - U(regular.tax);
      const supplementalTax = combinedExcess > 0n ? combinedExcess : 0n;
      return {
        code: engine.state,
        label: engine.label,
        tax: addMoney(regular.tax, D(supplementalTax)),
        ...localWageTrace,
        factors: {
          ...regular.factors,
          US_SUPPLEMENTAL_METHOD: "aggregate",
          US_SUPPLEMENTAL_TAX: D(supplementalTax),
        },
      };
    }
    if (separateFlatRate || separateCategoryAmounts) {
      // Flat-rate supplemental methods do not consume the employee's regular
      // certificate exemptions. The state engine still computes the regular
      // leg with no bonus; this dispatch computes the separately taxed bonus
      // from the effective-dated method declaration above.
      const regular = engine.compute({
        payDate: input.payDate,
        periodStart: input.periodStart,
        employerEmployeeCount: input.employerEmployeeCount,
        periodEnd: input.periodEnd,
        periodsPerYear: input.periodsPerYear,
        wages: residentWages,
        federalFilingStatus: input.federalFilingStatus,
        federalLegacyW4: input.federalLegacyW4,
        supplemental: "0",
        federalIncomeTax: input.federalIncomeTax,
        federalWithholdingExempt: input.federalWithholdingExempt,
        federalAdditionalPerPeriod: input.federalAdditionalPerPeriod,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
        basis: levy.reach,
        residenceRegion: input.residenceRegion,
        certificateFor: input.certificateFor,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        statutoryExemptionAmounts: input.statutoryExemptionAmounts,
        ytd: input.ytd,
      });
      const rawSupplementalTax = separateCategoryAmounts
        ? separateCategoryAmounts.reduce(
          (total, item) => total + mulRateCents(U(item.amount), item.rate),
          0n,
        )
        : mulRateCents(toUnits(residentSupplemental), separateFlatRate!);
      const supplementalTax = separateFlatWholeDollar
        ? roundDiv(rawSupplementalTax, 10_000n) * 10_000n
        : rawSupplementalTax;
      const categoryRateFactors = Object.fromEntries(
        (separateCategoryAmounts ?? []).map((item) => [
          `US_SUPPLEMENTAL_RATE_${item.category.toUpperCase()}`,
          item.rate,
        ]),
      );
      const separateStatutoryTax = fromUnits(
        toUnits(regular.statutoryTax ?? regular.tax) + supplementalTax,
      );
      if (levy.basis === "resident_out_of_region"
        && (regular.statutoryTax == null || regular.additionalWithholding == null)) {
        throw new UsWithholdingError(
          `${levy.region} resident withholding must separate statutory tax and additional withholding; update ${engine.ratesModule}; refused by name`,
        );
      }
      const separateAdditional = regular.additionalWithholding ?? "0.0000";
      const separateAdjustment = levy.basis === "resident_out_of_region"
        && levy.residentWithholdingMethod?.kind === "net_of_work_region_tax"
        ? adjustResidentWithholding(
          separateStatutoryTax,
          separateAdditional,
          residentWithholdingFacts!.workRegionTaxes,
          levy.residentWithholdingMethod,
        )
        : undefined;
      return {
        code: engine.state,
        label: engine.label,
        tax: separateAdjustment?.tax ?? fromUnits(toUnits(separateStatutoryTax) + toUnits(separateAdditional)),
        statutoryTax: separateAdjustment?.statutoryTax ?? separateStatutoryTax,
        additionalWithholding: separateAdditional,
        ...localWageTrace,
        factors: {
          ...regular.factors,
          US_SUPPLEMENTAL_METHOD: "flat",
          ...(separateFlatRate ? { US_SUPPLEMENTAL_RATE: separateFlatRate } : {}),
          ...categoryRateFactors,
          US_SUPPLEMENTAL_TAX: D(supplementalTax),
          ...(levy.basis === "resident_out_of_region" ? {
            US_RESIDENT_WITHHOLDING_OUTCOME: separateAdjustment?.outcome ?? waiverOutcome,
            US_RESIDENT_WORK_REGION_TAX_CREDIT: separateAdjustment?.workRegionTaxCredit ?? "0.0000",
            ...(waiverWages > 0n ? { US_RESIDENT_WAIVED_WAGES: fromUnits(waiverWages) } : {}),
          } : {}),
        },
      };
    }
    if (combinedFlatRate) {
      // Arkansas applies the formula to regular wages and a distinct 3.9% to
      // a bonus paid with them. The AR4ECSP exemption still covers both legs.
      const regular = engine.compute({
        payDate: input.payDate,
        periodStart: input.periodStart,
        employerEmployeeCount: input.employerEmployeeCount,
        periodEnd: input.periodEnd,
        periodsPerYear: input.periodsPerYear,
        wages: residentWages,
        federalFilingStatus: input.federalFilingStatus,
        federalLegacyW4: input.federalLegacyW4,
        supplemental: "0",
        federalIncomeTax: input.federalIncomeTax,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
        basis: levy.reach,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        statutoryExemptionAmounts: input.statutoryExemptionAmounts,
        ytd: input.ytd,
      });
      const exempt = combinedFlatHonorsCertificateExemption
        && certificateFlag(certificate, "exempt");
      const supplementalTax = exempt ? 0n : mulRateCents(toUnits(residentSupplemental), combinedFlatRate);
      return {
        code: engine.state,
        label: engine.label,
        tax: addMoney(regular.tax, D(supplementalTax)),
        statutoryTax: fromUnits(toUnits(regular.statutoryTax ?? regular.tax) + supplementalTax),
        additionalWithholding: regular.additionalWithholding ?? "0.0000",
        factors: {
          ...regular.factors,
          US_SUPPLEMENTAL_METHOD: "flat_supplemental",
          US_SUPPLEMENTAL_RATE: combinedFlatRate,
          US_SUPPLEMENTAL_TAX: D(supplementalTax),
        },
      };
    }
    const result = engine.compute({
      payDate: input.payDate,
      periodStart: input.periodStart,
      employerEmployeeCount: input.employerEmployeeCount,
      periodEnd: input.periodEnd,
      periodsPerYear: input.periodsPerYear,
      wages: residentWages,
      federalFilingStatus: input.federalFilingStatus,
      federalLegacyW4: input.federalLegacyW4,
      federalTaxExempt: input.federalTaxExempt,
      stateCertificateOnFile: certificate.onFile,
      supplemental: residentSupplemental,
      supplementalPaymentTiming: input.supplementalPaymentTiming,
      federalIncomeTax: input.federalIncomeTax,
      federalWithholdingExempt: input.federalWithholdingExempt,
      federalAdditionalPerPeriod: input.federalAdditionalPerPeriod,
      taxQualifiedDeductions: input.taxQualifiedDeductions,
      certificate,
      supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
      basis: levy.reach,
      residenceRegion: input.residenceRegion,
      certificateFor: input.certificateFor,
      wageAllocations: input.wageAllocations,
      residentWithholdingFacts,
      regionTax: input.regionTax,
      socialInsuranceDeducted: input.socialInsuranceDeducted,
      statutoryExemptionAmounts: input.statutoryExemptionAmounts,
      ytd: input.ytd,
    });
    // Guide-prescribed work-region schedule: a Maryland resident working
    // only in Delaware prices the Guide's dedicated Delaware schedule
    // (3.30% state+local less Delaware credit) instead of the county
    // combined tables, and takes no further work-region credit — the
    // credit is already inside the schedule.
    const delawareSchedule = levy.basis === "resident_out_of_region"
      && engine.state === "MD"
      && residentWithholdingFacts != null
      && mdDelawareScheduleApplies(
        residentWithholdingFacts.workRegionTaxes,
        residentWithholdingFacts.workRegionWages,
      )
      ? mdDelawareResidentTax({
        payDate: input.payDate,
        periodsPerYear: input.periodsPerYear,
        wages: residentWages,
        supplemental: residentSupplemental,
        certificate,
        supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
      })
      : undefined;
    const priced = delawareSchedule ?? result;
    const residentAdjustment = levy.basis === "resident_out_of_region"
      && residentMethod.kind === "net_of_work_region_tax"
      && delawareSchedule == null
      ? (() => {
        if (result.statutoryTax == null || result.additionalWithholding == null) {
          throw new UsWithholdingError(
            `${levy.region} resident withholding must separate statutory tax and additional withholding before applying its resident rule; update ${engine.ratesModule}; refused by name`,
          );
        }
        return adjustResidentWithholding(
          result.statutoryTax,
          result.additionalWithholding,
          residentWithholdingFacts!.workRegionTaxes,
          residentMethod,
        );
      })()
      : undefined;
    return {
      code: engine.state, label: engine.label,
      tax: residentAdjustment?.tax ?? priced.tax,
      statutoryTax: (() => {
        if (levy.basis === "resident_out_of_region" && (priced.statutoryTax == null || priced.additionalWithholding == null)) {
          throw new UsWithholdingError(
            `${levy.region} resident withholding must separate statutory tax and additional withholding; update ${engine.ratesModule}; refused by name`,
          );
        }
        return residentAdjustment?.statutoryTax ?? priced.statutoryTax;
      })(),
      additionalWithholding: priced.additionalWithholding,
      factors: {
        ...priced.factors,
        ...(levy.basis === "resident_out_of_region" ? {
          US_RESIDENT_WITHHOLDING_OUTCOME: residentAdjustment?.outcome ?? waiverOutcome,
          US_RESIDENT_WORK_REGION_TAX_CREDIT: residentAdjustment?.workRegionTaxCredit ?? "0.0000",
          ...(waiverWages > 0n ? { US_RESIDENT_WAIVED_WAGES: fromUnits(waiverWages) } : {}),
        } : {}),
      },
      ...localWageTrace,
    };
  }

  const subRegion = levy.subRegion!;
  // Wrong-pocket guard: an employer levy (Oregon transit) routed here would
  // post the employer's tax as a stub deduction — out of the employee's
  // cheque. It is refused by name; the employer path below is the only way
  // it posts.
  if (subRegionLevy("US", levy.region, subRegion)?.pocket === "employer") {
    throw new UsWithholdingError(
      `${levy.label} is an employer payroll tax, not employee withholding — `
      + "it posts as an employer contribution, never as a stub deduction.",
    );
  }
  const engineCode = SUB_REGION_ENGINE_CODE[`${levy.region}:${subRegion}`];
  if (engineCode) {
    const engine = usStateWithholding(engineCode);
    if (!engine) {
      throw new UsWithholdingError(
        `${levy.label} is declared with a published engine (${engineCode}) that is not registered `
        + "in engine/src/payroll/us/states/index.ts",
      );
    }
    // The per-allocation credit prices inside the Detroit engine, which sees
    // the wage allocations; the dispatch only forwards the other work
    // cities (a null rate refuses by name there, naming the city).
    const detroitOtherCities = engineCode === "MI-DETROIT" && levy.reach === "resident"
      ? input.detroitOtherCities ?? []
      : [];
    if (separateFlatRate) {
      const regular = engine.compute({
        payDate: input.payDate,
        periodStart: input.periodStart,
        employerEmployeeCount: input.employerEmployeeCount,
        periodEnd: input.periodEnd,
        periodsPerYear: input.periodsPerYear,
        wages: input.wages,
        supplemental: "0",
        federalIncomeTax: input.federalIncomeTax,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
        basis: levy.reach,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        statutoryExemptionAmounts: input.statutoryExemptionAmounts,
        ytd: input.ytd,
        detroitOtherCities,
      });
      const rawSupplementalTax = mulRateCents(supplemental, separateFlatRate);
      const supplementalTax = separateFlatWholeDollar
        ? roundDiv(rawSupplementalTax, 10_000n) * 10_000n
        : rawSupplementalTax;
      return {
        code: engine.state,
        label: engine.label,
        tax: addMoney(regular.tax, D(supplementalTax)),
        factors: {
          ...regular.factors,
          US_SUPPLEMENTAL_METHOD: "flat",
          US_SUPPLEMENTAL_RATE: separateFlatRate,
          US_SUPPLEMENTAL_TAX: D(supplementalTax),
        },
        // The W-2 box-18 trace, like every other sub-region return below:
        // a published-engine levy is still a locality levy, and dropping
        // the trace here makes the slip refuse by name downstream.
        ...localWageTrace,
      };
    }
    const result = engine.compute({
      payDate: input.payDate,
      periodStart: input.periodStart,
      employerEmployeeCount: input.employerEmployeeCount,
      periodEnd: input.periodEnd,
      periodsPerYear: input.periodsPerYear,
      wages: input.wages,
      federalFilingStatus: input.federalFilingStatus,
      federalLegacyW4: input.federalLegacyW4,
      federalTaxExempt: input.federalTaxExempt,
      stateCertificateOnFile: certificate.onFile,
      supplemental: input.supplemental,
      federalIncomeTax: input.federalIncomeTax,
      federalWithholdingExempt: input.federalWithholdingExempt,
      taxQualifiedDeductions: input.taxQualifiedDeductions,
      certificate,
      supportingCertificates: supportingCertificates(engine.supportingCertificateKeys),
      basis: levy.reach,
      residenceRegion: input.residenceRegion,
      certificateFor: input.certificateFor,
      wageAllocations: input.wageAllocations,
      residentWithholdingFacts,
      regionTax: input.regionTax,
      ytd: input.ytd,
      detroitOtherCities,
    });
    // The W-2 box-18 trace, like every other sub-region return in this
    // function: a published-engine levy (NYC, Yonkers, Philadelphia,
    // Detroit) is still a locality levy, and dropping the trace here makes
    // the slip refuse by name downstream.
    return { code: engine.state, label: engine.label, tax: result.tax, factors: result.factors, ...localWageTrace };
  }

  // No published engine. That is not a hole to skip: these are the levies whose
  // RATE the employer supplies, and each helper below refuses by name without
  // it. The declaration itself says which — `rateSource: { kind: "tenant" }`.
  const declared = subRegionLevy("US", levy.region, subRegion);
  // A parent-computed levy (a Maryland county local inside SIT_MD) is never
  // a separate posting: refusing by name here is the double-count guard, so
  // a future branch cannot wire it into a second stub line.
  if (declared?.computedByParent) {
    throw new UsWithholdingError(
      `${levy.label} is computed inside ${declared.computedByParent}, not as a separate levy — `
      + "posting it again would withhold the same tax twice.",
    );
  }
  const rates = declared?.rateSource.kind === "tenant"
    ? input.tenantRates(declared.rateSource.rateKey, subRegion)
    : undefined;
  const compensation = input.wages;

  switch (levy.region) {
    case "OH": {
      if (/^\d{4}$/.test(subRegion)) {
        // A school district: the RATE is published by the Department and
        // carried by the pack, the exemption count comes from the IT 4.
        const district = ohSchoolDistrict(input.payDate, subRegion);
        if (!district) {
          throw new UsWithholdingError(
            `Ohio school district ${subRegion} does not levy an income tax in the list loaded for `
            + `${input.payDate.slice(0, 4)} — only 214 of the state's districts do. Correct the `
            + "district number on the employee's IT 4.",
          );
        }
        const result = ohSchoolDistrictWithholding({
          periodEnd: input.periodEnd,
          periodsPerYear: input.periodsPerYear,
          wages: addAmounts(compensation, input.supplemental),
          exemptions: exemptionCount(certificate, "total_exemptions"),
          district,
        });
        return {
          code: `OH-${subRegion}`, label: declared?.label ?? `Ohio school district ${subRegion}`,
          tax: result.tax, factors: result.factors, ...localWageTrace,
        };
      }
      // A municipality. `ohMunicipalWithholding` throws, naming the
      // municipality and the `us_oh_municipal` slot, when no rate is entered.
      const municipalWages = levy.reach === "nonresident"
        ? requireUsSourceWages(input.wageAllocations, levy.region, subRegion)
        : addAmounts(compensation, input.supplemental);
      // The R.C. 718.011 occasional-entrant posture rides the employer-kept
      // municipal record (MI precedent below reads its own state record the
      // same way); an unrecorded posture prices normally, never as exempt.
      const municipalRecord = input.certificateFor("us_oh_municipal_record");
      const tax = ohMunicipalWithholding({
        wages: municipalWages,
        rate: rates?.rate,
        municipality: subRegion,
        entrant: {
          residentOfMunicipality: levy.reach === "resident",
          daysInMunicipality: municipalRecord
            ? certificateCount(municipalRecord, "annual_days_in_municipality")
            : null,
          principalWorkOutsideMunicipality: municipalRecord
            ? certificateFlag(municipalRecord, "principal_work_outside_municipality")
            : false,
          nonSmallEmployerQualifyingWages: municipalRecord
            ? certificateFlag(municipalRecord, "non_small_employer_qualifying_wages")
            : false,
        },
      });
      return {
        code: `OH-${subRegion}`, label: declared?.label ?? `${subRegion} municipal income tax`,
        tax,
        factors: { OH_MUNICIPAL: subRegion, OH_MUNICIPAL_RATE: rates?.rate ?? "", OH_MUNICIPAL_TAX: tax },
        ...localWageTrace,
      };
    }
    case "MI": {
      // The Detroit resident's two-city credit is not priced here: it prices
      // inside the Detroit engine on the published-engine path above, which
      // receives every other work city and its rate (`detroitOtherCities`).
      // This branch prices each work city's OWN levy at its entered rate.
      const result = miCityWithholding({
        city: subRegion,
        wages: compensation,
        supplemental: input.supplemental,
        rate: levy.reach === "resident" ? rates?.residentRate : rates?.nonresidentRate,
        exemptionPerYear: rates?.exemptionPerYear,
        exemptions: exemptionCount(
          input.certificateFor("us_mi_miw4") ?? certificate, "exemptions",
        ),
        periodsPerYear: input.periodsPerYear,
      });
      return {
        code: `MI-${subRegion}`, label: declared?.label ?? `${subRegion} city income tax`,
        tax: result.tax, factors: result.factors, ...localWageTrace,
      };
    }
    case "IN": {
      // Indiana county income tax (Departmental Notice #1): the same taxable
      // wages the state tax used — the period's wages less the WH-4
      // exemptions — at the January-1 county's published rate, plus WH-4
      // line 10 extra county withholding after the rate. The county comes
      // from the levy the resolver settled (residence county for an Indiana
      // resident, work county otherwise); the rate is a pack constant from
      // the notice, never employer-entered.
      const county = inCounty(Number(input.payDate.slice(0, 4)), subRegion);
      const countyResult = inCountyWithholding({
        payDate: input.payDate,
        periodsPerYear: input.periodsPerYear,
        wages: input.wages,
        supplemental: input.supplemental,
        exemptions: {
          personal: exemptionCount(certificate, "personal_exemptions"),
          additionalDependent: exemptionCount(certificate, "additional_dependent_exemptions"),
          firstTimeDependent: exemptionCount(certificate, "first_time_dependent_exemptions"),
          adoptedDependent: exemptionCount(certificate, "adopted_dependent_exemptions"),
        },
        county,
        additionalPerPeriod: certificate.certificate.fields.some(
          (field) => field.key === "additional_county_per_period",
        )
          ? certificateAmount(certificate, "additional_county_per_period") ?? undefined
          : undefined,
        exempt: certificateFlag(certificate, "exempt")
          || certificateFlag(certificate, "county_exempt"),
      });
      return {
        code: `IN-${subRegion}`, label: declared?.label ?? `${county.name} County income tax`,
        tax: countyResult.tax, factors: countyResult.factors, ...localWageTrace,
      };
    }
    case "PA": {
      // Act 32. The higher-of COMPARISON has already happened in the generic
      // resolver (the region declares `higher_rate`); what is left is the
      // arithmetic at the rate that won.
      const rate = levy.reach === "resident" ? rates?.residentRate : rates?.nonresidentRate;
      if (rate == null || rate === "") {
        throw new UsWithholdingError(
          `no Act 32 local earned income tax rate has been entered for PSD ${subRegion} `
          + `(${levy.reach} rate). Pennsylvania's roughly 2,500 taxing jurisdictions each set `
          + "their own and DCED revises the register annually, so the rate is employer-entered: "
          + "look the PSD up in DCED's register and record it against the jurisdiction "
          + "(statutory rate \"us_pa_local_eit\"). Withholding nothing would under-withhold the "
          + "employee and leave the tax collection district to assess it with interest.",
        );
      }
      const tax = act32LocalEit({
        compensation: addAmounts(compensation, input.supplemental), rate,
      });
      return {
        code: `PA-${subRegion}`, label: declared?.label ?? `PA local EIT (PSD ${subRegion})`,
        tax,
        factors: { PA_EIT_PSD: subRegion, PA_EIT_RATE: rate, PA_EIT_TAX: tax },
        ...localWageTrace,
        ...paWorksiteLst(input, levy, subRegion),
      };
    }
    default:
      // The last branch, and the reason this function exists: an unrecognised
      // sub-region is REFUSED by name. `requireUsStateWithholding` throws for
      // anything that is not a state code, which `${region}-${subRegion}` never
      // is — so this never returns, and it never returns zero.
      requireUsStateWithholding(`${levy.region}-${subRegion}`);
      throw new UsWithholdingError(
        `${levy.label} is declared inside ${levy.region} and the US pack has no way to compute it`,
      );
  }
}

/**
 * The worksite Local Services Tax riding a settled Act 32 levy.
 *
 * LST follows the WORK location and is a different tax from EIT (a flat
 * annual amount, not rate × wages), so it cannot fold into the EIT line —
 * it returns as an additional line the compute pass posts separately. The
 * worksite PSD is the levy's own code on the work side, else the
 * CLGS-32-6 work code; with neither on file no worksite jurisdiction is
 * known and there is nothing to assess. An entered annual amount IS the
 * levy on file (most PA worksites levy no LST, so unconfigured assesses
 * nothing); the exemption record zeroes it with the reason on the trace.
 */
function paWorksiteLst(
  input: UsWithholdingInput,
  levy: ResolvedWithholdingLevy,
  subRegion: string,
): Pick<UsWithholdingResult, "additionalLines"> {
  const clgs = input.certificateFor("us_pa_clgs32_6");
  const workPsd = levy.side === "work"
    ? subRegion
    : clgs == null ? null : certificateCode(clgs, "work_psd_code");
  if (workPsd == null || workPsd === "") return {};
  const annualAmount = input.tenantRates("us_pa_lst", workPsd)?.annualAmount;
  if (annualAmount == null || annualAmount === "") return {};
  const record = input.certificateFor("us_pa_lst_record");
  const exempt = record != null
    && (certificateFlag(record, "exempt_low_income")
      || certificateFlag(record, "principal_employer_withholds"));
  const factorKey = `LIT_PA-${workPsd}-LST`;
  const ytd = input.ytd?.lstWithheldYtd?.[factorKey] ?? "0";
  const tax = localServicesTaxPerPeriod({
    annualAmount,
    periodsPerYear: input.periodsPerYear,
    exempt,
    alreadyWithheldYtd: ytd,
  });
  return {
    additionalLines: [{
      code: `PA-${workPsd}-LST`,
      label: `PA Local Services Tax (worksite PSD ${workPsd})`,
      tax,
      factors: {
        PA_LST_PSD: workPsd,
        PA_LST_ANNUAL: annualAmount,
        PA_LST_TAX: tax,
        PA_LST_YTD: ytd,
        ...(exempt ? { PA_LST_EXEMPT: "1" } : {}),
      },
    }],
  };
}

/**
 * The EMPLOYER half of the sub-region dispatch — levies the pack declares
 * with `pocket: "employer"`.
 *
 * Oregon's TriMet and Lane Transit District payroll taxes are assessed on
 * the employer for wages paid for work performed in the district (Form OQ):
 * never withheld from the employee, so they never travel
 * `computeUsWithholding`'s deduction path (which refuses them by name above).
 * The result posts as an employer contribution: employer expense plus a
 * liability to the district, with net pay untouched.
 *
 * The rate is employer-entered (no Department publication carries it);
 * `orTransitWithholding` refuses a missing one by name. Its plain-Error
 * refusal is re-wrapped here so the run reports it as a payroll refusal
 * (422), not a server failure — the wording is the engine's own.
 */
export function computeUsEmployerWithholding(input: {
  levy: ResolvedWithholdingLevy;
  /**
   * Pay date, selecting the effective pack rate. Required by pack-rated
   * levies, which refuse without it (the periodEnd precedent); tenant-rated
   * levies price their entered figure datelessly.
   */
  payDate?: string;
  /**
   * Priced base history this year for a wage-based levy (Minnesota Paid
   * Leave), from committed stubs. Required where the declaration caps the
   * base; absent refuses, exhausted prices zero.
   */
  ytdWages?: string;
  /** Total state-taxable compensation this period (periodic plus supplemental). */
  wages: string;
  /** Verified district-source work wages for location-specific employer levies. */
  wageAllocations?: readonly UsWageAllocation[];
  /**
   * The employer-entered rate values for the levy's `tenant`-sourced slot,
   * from `payroll_statutory_rates` at `sub_region` scope. Undefined means
   * the employer has not entered them, which refuses below.
   */
  tenantRates: (rateKey: string, subRegion: string) => Record<string, string> | undefined;
}): UsWithholdingResult {
  const { levy } = input;
  const subRegion = levy.subRegion!;
  const declared = subRegionLevy("US", levy.region, subRegion);
  if (declared?.pocket !== "employer") {
    throw new UsWithholdingError(
      `${levy.label} is not declared as an employer payroll tax — `
      + "it posts through the employee withholding path, not here.",
    );
  }
  if (levy.region === "OR" && (subRegion === "TRIMET" || subRegion === "LTD")) {
    const rateKey = declared.rateSource.kind === "tenant" ? declared.rateSource.rateKey : null;
    const rate = rateKey ? input.tenantRates(rateKey, subRegion)?.rate : undefined;
    let tax: string;
    try {
      const districtWages = requireUsSourceWages(input.wageAllocations, levy.region, subRegion);
      tax = orTransitWithholding({ wages: districtWages, rate, district: declared.label });
    } catch (error) {
      throw new UsWithholdingError(error instanceof Error ? error.message : String(error));
    }
    return {
      code: `OR-${subRegion}`, label: declared.label, tax,
      factors: {
        OR_TRANSIT_DISTRICT: subRegion,
        OR_TRANSIT_RATE: rate ?? "",
        OR_TRANSIT_TAX: tax,
      },
    };
  }
  // Assessed flat-rate employer levies (Vermont Child Care Contribution):
  // pack-published or employer-entered rate on covered work-region wages.
  // The region share prices multi-state work; with no allocations recorded
  // the run's own work region is the whole base. An employer levy is always
  // owed when it resolves, so a missing tenant rate refuses — never skips.
  const method = declared.withholdingMethod;
  if (method?.kind === "flat_rate") {
    if (method.effectiveFrom !== undefined && (input.payDate ?? "") < method.effectiveFrom) {
      throw new UsWithholdingError(
        `${levy.label} starts ${method.effectiveFrom} and nothing is owed before then; `
        + "run it on or after its start date in a transcribed tax year",
      );
    }
    let rate: string;
    if (declared.rateSource.kind === "tenant") {
      const entered = input.tenantRates(declared.rateSource.rateKey, subRegion)?.rate;
      if (entered == null || entered === "") {
        throw new UsWithholdingError(
          `no ${levy.label} rate has been entered for this period; `
          + "the rate is employer-entered because no publication carries it — "
          + "enter the assessed figure before calculating; refused by name",
        );
      }
      try {
        rate6(entered);
      } catch {
        throw new UsWithholdingError(
          `${levy.label} has an unreadable entered rate "${entered}"; `
          + "enter an exact decimal rate before calculating — refused by name",
        );
      }
      rate = entered;
    } else {
      const payDate = input.payDate;
      if (payDate == null || payDate === "") {
        throw new UsWithholdingError(
          `${levy.label} needs the pay date to select its effective published rate; `
          + "pass the payroll pay date before calculating — refused by name",
        );
      }
      const published = method.rates
        .filter((entry) => entry.effectiveFrom <= payDate)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .at(-1);
      if (!published) {
        throw new UsWithholdingError(
          `${levy.label} has no published flat rate effective on ${payDate}; `
          + "transcribe the official effective rate before calculating — refused by name",
        );
      }
      rate = published.rate;
    }
    let base = input.wages;
    if ((input.wageAllocations ?? []).length > 0) {
      const allocation = requireUsWageAllocation(input.wageAllocations, levy.region, null);
      base = mulRatio(base, rate6(allocation.workShare), 1_000_000n);
    }
    if (method.wageBase === "social_security") {
      // As the employee leg: price only the remaining room under the year's
      // Social Security wage base from the supplied base history.
      const history = input.ytdWages;
      if (history == null || history === "") {
        throw new UsWithholdingError(
          `${levy.label} needs the employee's priced base history this year to enforce its wage base; `
          + "recalculate with the year-to-date base before calculating — refused by name",
        );
      }
      const room = U(ratesForPayDate(input.payDate ?? "").fica.ssWageBase) - U(history);
      const covered = U(base);
      base = D(room <= 0n ? 0n : (covered < room ? covered : room));
    }
    const tax = D(mulRateCents(U(base), rate));
    const factors: Record<string, string> = {
      STATUTORY_LEVY_RATE: rate,
      STATUTORY_LEVY_BASE: base,
      STATUTORY_LEVY_TAX: tax,
      ...(levy.statutoryComponent ? { [`${levy.statutoryComponent.systemKey}_BASE`]: base } : {}),
    };
    if (levy.region === "MN" && subRegion === "PL") {
      // Minnesota records the DEED-notified small-employer qualification
      // with the premium facts: the quarterly wage-detail report prices the
      // reduced rate off it, so a run without it refuses rather than
      // reporting an unqualified figure.
      const small = input.tenantRates("us_mn_pl", subRegion)?.small_employer;
      if (small !== "true" && small !== "false") {
        throw new UsWithholdingError(
          "Minnesota Paid Leave needs the employer's DEED-notified small-employer qualification; "
          + "record whether the employer qualifies before calculating — refused by name",
        );
      }
      factors.MNPL_SMALL_EMPLOYER = small;
    }
    return {
      code: `${levy.region}-${subRegion}`, label: declared.label, tax,
      factors,
    };
  }
  throw new UsWithholdingError(
    `${levy.label} is declared as an employer payroll tax inside ${levy.region} and the US pack `
    + "has no employer computation for it",
  );
}

/**
 * The rates the generic `higher_rate` settlement compares, keyed as
 * `resolveWithholding` reads them (`"<code>:<reach>"`).
 *
 * Pennsylvania Act 32's rule — withhold the higher of the employee's total
 * RESIDENT rate and the work location's NONRESIDENT rate — is applied by the
 * generic resolver, which cannot fetch a tenant-entered rate from inside a pure
 * function. It takes them from the caller, and this is what the US pack hands
 * over: every candidate jurisdiction's declared rate slot, read at the two
 * reaches. A code with nothing entered is simply absent, which the resolver
 * reports as a blocking gap naming both jurisdictions rather than picking one.
 *
 * `residentRate` / `nonresidentRate` are the field keys the pack's own
 * sub-region slots declare (`us_pa_local_eit`, `us_mi_city`), so this reads the
 * declaration rather than a second list of names.
 */
export function usSubRegionRateIndex(input: {
  codes: readonly { region: string; code: string }[];
  tenantRates: (rateKey: string, region: string, subRegion: string)
    => Record<string, string> | undefined;
}): Record<string, string> {
  const index: Record<string, string> = {};
  for (const { region, code } of input.codes) {
    const declared = subRegionLevy("US", region, code);
    if (declared?.rateSource.kind !== "tenant") continue;
    const values = input.tenantRates(declared.rateSource.rateKey, region, code);
    if (!values) continue;
    if (values.residentRate) index[`${code}:resident`] = values.residentRate;
    if (values.nonresidentRate) index[`${code}:nonresident`] = values.nonresidentRate;
    // A single-rate jurisdiction (an Ohio municipality applies one rate to
    // residents and nonresidents alike) answers both reaches with it.
    if (values.rate) {
      index[`${code}:resident`] ??= values.rate;
      index[`${code}:nonresident`] ??= values.rate;
    }
  }
  return index;
}

/** An exemption count the levy's certificate declares, or zero when unfiled. */
function exemptionCount(certificate: ResolvedCertificate, key: string): number {
  if (!certificate.certificate.fields.some((field) => field.key === key)) return 0;
  return certificateCount(certificate, key) ?? 0;
}

/**
 * `a + b` where b may be absent. Through money.ts, never a float: these are
 * cents that end up on a stub.
 */
function addAmounts(a: string, b: string | undefined): string {
  if (b == null || b === "") return a;
  return addMoney(a, b);
}
