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
  certificateCount,
  emptyResolvedCertificate,
  type ResolvedCertificate,
} from "../certificates.ts";
import { add as addMoney } from "../../money/money.ts";
import type { ResolvedWithholdingLevy } from "../withholding-resolution.ts";
import { subRegionLevy } from "../withholding-jurisdictions.ts";
import { PayrollError } from "../error.ts";
import { D, mulRateCents, U } from "../canada/decimal.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "./rates.ts";
import {
  miCityWithholding,
  ohMunicipalWithholding,
  ohSchoolDistrict,
  ohSchoolDistrictWithholding,
  requireUsStateWithholding,
  usStateWithholding,
  type UsStateYtd,
} from "./states/index.ts";
import { act32LocalEit } from "./states/pa.ts";
import { inCounty, inCountyWithholding } from "./states/in.ts";
import { orTransitWithholding } from "./states/or.ts";
import {
  requireUsResidentWithholdingFacts,
  type UsResidentWithholdingFacts,
  type UsWageAllocation,
} from "./states/types.ts";

export class UsWithholdingError extends PayrollError {}

export type UsSeparateSupplementalMethod =
  | { kind: "refuse"; detail: string }
  | { kind: "not_applicable" }
  | { kind: "aggregate"; source: string }
  | { kind: "differential"; source: string }
  | { kind: "flat"; rates: readonly { effectiveFrom: string; rate: string; source: string }[] };

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
} satisfies Readonly<Record<(typeof US_STATES)[number], UsSeparateSupplementalMethod>>;

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
  OR_TRANSIT_TAX: "Oregon transit payroll tax (employer)",
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
};

export interface UsWithholdingInput {
  levy: ResolvedWithholdingLevy;
  payDate: string;
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
  /** Supplemental wages this period. */
  supplemental?: string;
  /** Whether supplemental wages were paid with regular wages or separately. */
  supplementalPaymentTiming?: "combined" | "separate";
  /** Resolved exact work shares used by state and local allocation rules. */
  wageAllocations?: readonly UsWageAllocation[];
  /** Verified out-of-region wage source and current work-region tax amounts. */
  residentWithholdingFacts?: UsResidentWithholdingFacts;
  /** Current paycheck's computed federal income-tax withholding. */
  federalIncomeTax: string;
  /** Tax-qualified deductions from this period, used by Nebraska's floor. */
  taxQualifiedDeductions?: string;
  /**
   * The employee's resolved answers on a pack-declared certificate, or null
   * when they have filed none of that certificate.
   */
  certificateFor: (key: string) => ResolvedCertificate | null;
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
  factors: Record<string, string>;
}

/**
 * The withholding for ONE resolved levy, or null where the jurisdiction levies
 * no wage income tax.
 */
export function computeUsWithholding(input: UsWithholdingInput): UsWithholdingResult | null {
  const { levy } = input;
  const residentWithholdingFacts = levy.basis === "resident_out_of_region"
    ? requireUsResidentWithholdingFacts(
      input.residentWithholdingFacts,
      levy.creditAgainstRegion,
      levy.region,
    )
    : input.residentWithholdingFacts;
  const supplemental = input.supplemental == null ? 0n : U(input.supplemental);
  let separateFlatRate: string | undefined;
  if (supplemental > 0n && input.supplementalPaymentTiming == null) {
    throw new UsWithholdingError(
      `separately paid or combined supplemental timing is missing for ${levy.label}; record whether this payment was issued with regular wages before calculating — refused by name`,
    );
  }
  if (supplemental > 0n && input.supplementalPaymentTiming === "separate") {
    const method = US_SEPARATE_SUPPLEMENTAL_METHODS[levy.region as keyof typeof US_SEPARATE_SUPPLEMENTAL_METHODS];
    if (method.kind === "not_applicable") return null;
    if (method.kind === "refuse") {
      throw new UsWithholdingError(
        `${levy.label} separately paid supplemental wages require a declared state method; ${method.detail}. `
        + "Record the jurisdiction's official method and required inputs before calculating — refused by name",
      );
    }
    if (method.kind === "flat") {
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
    } else {
      throw new UsWithholdingError(
        `${levy.label} separately paid supplemental method ${method.kind} is declared but its calculator is not available in this pack version — update the pack before calculating; refused by name`,
      );
    }
  }
  const certificate = levy.certificateKey
    ? input.certificateFor(levy.certificateKey) ?? emptyResolvedCertificate(levy.certificateKey)
    : emptyResolvedCertificate(`${levy.label} publishes no withholding certificate`);

  if (levy.level === "region") {
    // Throws for a state that levies a tax the pack has not transcribed;
    // returns null ONLY for a state with no wage income tax at all.
    const engine = requireUsStateWithholding(levy.region);
    if (!engine) return null;
    if (separateFlatRate) {
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
        wages: input.wages,
        supplemental: "0",
        federalIncomeTax: input.federalIncomeTax,
        taxQualifiedDeductions: input.taxQualifiedDeductions,
        certificate,
        basis: levy.reach,
        wageAllocations: input.wageAllocations,
        residentWithholdingFacts,
        regionTax: input.regionTax,
        socialInsuranceDeducted: input.socialInsuranceDeducted,
        ytd: input.ytd,
      });
      const supplementalTax = mulRateCents(supplemental, separateFlatRate);
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
      };
    }
    const result = engine.compute({
      payDate: input.payDate,
      periodStart: input.periodStart,
      employerEmployeeCount: input.employerEmployeeCount,
      periodEnd: input.periodEnd,
      periodsPerYear: input.periodsPerYear,
      wages: input.wages,
      supplemental: input.supplemental,
      supplementalPaymentTiming: input.supplementalPaymentTiming,
      federalIncomeTax: input.federalIncomeTax,
      taxQualifiedDeductions: input.taxQualifiedDeductions,
      certificate,
      basis: levy.reach,
      wageAllocations: input.wageAllocations,
      residentWithholdingFacts,
      regionTax: input.regionTax,
      socialInsuranceDeducted: input.socialInsuranceDeducted,
      ytd: input.ytd,
    });
    return { code: engine.state, label: engine.label, tax: result.tax, factors: result.factors };
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
    const result = engine.compute({
      payDate: input.payDate,
      periodStart: input.periodStart,
      employerEmployeeCount: input.employerEmployeeCount,
      periodEnd: input.periodEnd,
      periodsPerYear: input.periodsPerYear,
      wages: input.wages,
      supplemental: input.supplemental,
      federalIncomeTax: input.federalIncomeTax,
      taxQualifiedDeductions: input.taxQualifiedDeductions,
      certificate,
      basis: levy.reach,
      wageAllocations: input.wageAllocations,
      residentWithholdingFacts,
      regionTax: input.regionTax,
      ytd: input.ytd,
    });
    return { code: engine.state, label: engine.label, tax: result.tax, factors: result.factors };
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
          tax: result.tax, factors: result.factors,
        };
      }
      // A municipality. `ohMunicipalWithholding` throws, naming the
      // municipality and the `us_oh_municipal` slot, when no rate is entered.
      const tax = ohMunicipalWithholding({
        wages: addAmounts(compensation, input.supplemental),
        rate: rates?.rate,
        municipality: subRegion,
      });
      return {
        code: `OH-${subRegion}`, label: declared?.label ?? `${subRegion} municipal income tax`,
        tax,
        factors: { OH_MUNICIPAL: subRegion, OH_MUNICIPAL_RATE: rates?.rate ?? "", OH_MUNICIPAL_TAX: tax },
      };
    }
    case "MI": {
      // Not applied here, and it is a known gap rather than an oversight:
      // Michigan's two-city rule reduces a DETROIT RESIDENT's rate by the work
      // city's nonresident rate (`miDetroitResidentRate`). Detroit is computed
      // by its published engine above, which applies its full resident rate —
      // correct for the Detroit resident working in Detroit, and an
      // OVER-withholding of at most the other city's nonresident rate for the
      // employee who works in a second taxing city. Wiring it needs the sibling
      // levy's rate handed to a Detroit path that bypasses the engine, which is
      // a decision for the state's own module.
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
        tax: result.tax, factors: result.factors,
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
      });
      return {
        code: `IN-${subRegion}`, label: declared?.label ?? `${county.name} County income tax`,
        tax: countyResult.tax, factors: countyResult.factors,
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
  /** Total state-taxable compensation this period (periodic plus supplemental). */
  wages: string;
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
      tax = orTransitWithholding({ wages: input.wages, rate, district: declared.label });
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
