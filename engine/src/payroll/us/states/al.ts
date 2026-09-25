/**
 * Alabama income-tax withholding — ALDOR formula method.
 *
 * Source (fetched from revenue.alabama.gov, not memory):
 *   Withholding Tax Tables and Instructions for Employers and Withholding
 *     Agents, Revised August 2024,
 *     https://www.revenue.alabama.gov/wp-content/uploads/2024/10/whbooklet_1024.pdf
 *     — Formula For Computing Alabama Withholding Tax, lines 1–6; Schedule
 *       of Standard Deduction Amounts (the printed phase-out); official
 *       M-2 / $850 weekly example; no A-4 → zero exemptions; optional 5%
 *       on separately-paid supplementals.
 *   Ala. Admin. Code r. 810-3-71-.02 — A-4 codes 0 / S / M / H / MS.
 *
 * The August 2024 booklet is the live official publication. 2026 pay dates
 * use that formula; they do not invent a January 2026 reprint.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, type PayrollCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  requireUsWageAllocation,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/al.ts";

export type AlExemption = "0" | "S" | "MS" | "M" | "H";

export interface AlYearRates {
  year: number;
  status: "published" | "draft";
  supplementalRate: string;
}

export const AL_RATES_2026: AlYearRates = {
  year: 2026,
  status: "published",
  supplementalRate: pctToRate("5"),
};

const AL_EDITIONS_BY_YEAR: Record<number, AlYearRates> = {
  [AL_RATES_2026.year]: AL_RATES_2026,
};

export const AL_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "ALDOR withholding formula (booklet Revised August 2024)",
  effectiveFrom: "2026-01-01",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024 — formula lines 1–6, "
    + "standard-deduction phase-out, M-2 $850 weekly example; Form A-4",
  status: "published",
  region: "AL",
}];

export function alRatesForPayDate(payDate: string): AlYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = AL_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(AL_WITHHOLDING, year);
  }
  return rates;
}

/** "less $X for each $step increment or part thereof of GI above the first ceiling." */
function phasedDeduction(
  gi: bigint,
  firstUpTo: string,
  firstAmount: string,
  floorFrom: string,
  floorAmount: string,
  step: string,
  reduction: string,
): bigint {
  if (gi <= U(firstUpTo)) return U(firstAmount);
  if (gi >= U(floorFrom)) return U(floorAmount);
  const excess = gi - U(firstUpTo);
  const steps = (excess + U(step) - 1n) / U(step);
  return max0(U(firstAmount) - steps * U(reduction));
}

export function alStandardDeduction(exemption: AlExemption, gi: bigint): bigint {
  if (exemption === "0" || exemption === "S") {
    return phasedDeduction(gi, "25999", "3000", "35500", "2500", "500", "25");
  }
  if (exemption === "MS") {
    return phasedDeduction(gi, "12999", "4250", "17750", "2500", "250", "88");
  }
  if (exemption === "M") {
    return phasedDeduction(gi, "25999", "8500", "35500", "5000", "500", "175");
  }
  return phasedDeduction(gi, "25999", "5200", "35500", "2500", "500", "135");
}

export function alPersonalExemption(exemption: AlExemption): bigint {
  if (exemption === "0") return 0n;
  if (exemption === "S" || exemption === "MS") return U("1500");
  return U("3000");
}

export function alDependentAllowance(gi: bigint, dependents: number): bigint {
  const per = gi <= U("50000") ? U("1000") : gi <= U("100000") ? U("500") : U("300");
  return per * BigInt(dependents < 0 ? 0 : dependents);
}

/** Line 5. Only "M" uses the doubled brackets. */
export function alAnnualTax(exemption: AlExemption, taxable: bigint): bigint {
  if (exemption === "M") {
    const first = mulRateCents(bmin(taxable, U("1000")), pctToRate("2"));
    const second = mulRateCents(bmin(max0(taxable - U("1000")), U("5000")), pctToRate("4"));
    const rest = mulRateCents(max0(taxable - U("6000")), pctToRate("5"));
    return first + second + rest;
  }
  const first = mulRateCents(bmin(taxable, U("500")), pctToRate("2"));
  const second = mulRateCents(bmin(max0(taxable - U("500")), U("2500")), pctToRate("4"));
  const rest = mulRateCents(max0(taxable - U("3000")), pctToRate("5"));
  return first + second + rest;
}

function bmin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function alSupplementalFlat(supplemental: string, rates: AlYearRates = AL_RATES_2026): string {
  return D(mulRateCents(U(supplemental), rates.supplementalRate));
}

/**
 * This period's ALDOR-approved exempt severance, or zero when no approval
 * attestation is on file. Validates the approval gate ($50,000 cap, written
 * approval, period amount within the approved total) and refuses by name —
 * shared by the formula carve-out and the separate-flat gate so both paths
 * enforce the identical gate.
 */
export function alApprovedSeverance(
  approval: ResolvedCertificate | null | undefined,
): bigint {
  if (!approval?.onFile) return 0n;
  if (approval.answers["aldor_approval_on_file"] !== "true") {
    throw new PayrollError(
      "Alabama severance attestation does not certify ALDOR written approval — "
      + "the exemption needs an employer-requested, ALDOR-approved plan; refused by name",
    );
  }
  const rawApproved = approval.answers["approved_amount"];
  if (rawApproved == null || rawApproved === "") {
    throw new PayrollError(
      "Alabama severance attestation is missing the approved exempt total — "
      + "attest the ALDOR-approved amount before calculating; refused by name",
    );
  }
  const approved = U(rawApproved);
  if (approved > U("50000")) {
    throw new PayrollError(
      `Alabama approved severance ${D(approved)} exceeds the $50,000 program cap — `
      + "only the first $50,000 is excludable; correct the attestation",
    );
  }
  const rawPeriod = approval.answers["period_severance"];
  if (rawPeriod == null || rawPeriod === "") {
    throw new PayrollError(
      "Alabama severance attestation is missing this period's severance — "
      + "attest the period amount before calculating; refused by name",
    );
  }
  const period = U(rawPeriod);
  if (period > approved) {
    throw new PayrollError(
      "Alabama attested period severance exceeds the approved exempt total — "
      + "correct the attestation before calculating; refused by name",
    );
  }
  return period;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = alRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for Alabama withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const militarySpouseCertificate = input.supportingCertificates?.us_al_a4_ms;
  if (militarySpouseCertificate?.onFile) {
    requireMilitarySpouseEligibility(militarySpouseCertificate, "Alabama", [
      { key: "spouse_is_active_duty_member", description: "the employee's spouse is an active-duty military servicemember" },
      { key: "employee_is_not_servicemember", description: "the employee is not a military servicemember" },
      { key: "current_orders_assign_al", description: "current military orders assign the servicemember to Alabama" },
      { key: "employee_here_to_accompany", description: "the employee is in Alabama solely to be with the servicemember" },
      { key: "same_current_address", description: "the employee and servicemember live at the same address" },
      { key: "employee_domicile_outside_al", description: "the employee's domicile is outside Alabama" },
      { key: "same_domicile", description: "the employee and servicemember share the same domicile" },
      { key: "military_id_on_file", description: "a current military spouse identification is on file" },
      { key: "dd2058_on_file", description: "the servicemember's DD Form 2058 is on file" },
      { key: "recent_les_on_file", description: "a recent Leave and Earnings Statement is on file" },
    ]);
    factors.AL_MILITARY_SPOUSE_EXEMPT = "1";
    return { state: "AL", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Act 2025-334 30-day safe harbor (2026 ALDOR booklet, p. 3): an
  // out-of-state worker at 30 or fewer Alabama days is exempt, and until
  // the 31st day keeps withholding to the state of residence. The day
  // count rides the approved work allocation for the period, so a
  // nonresident run refuses by name only when the employee has no
  // approved Alabama location data — never merely for being a
  // nonresident. Residents never reach this branch.
  if (input.basis === "nonresident") {
    const allocation = requireUsWageAllocation(input.wageAllocations, "AL", null);
    const days = allocation.serviceDaysYearToDate;
    if (days == null || !Number.isInteger(days) || days < 0) {
      throw new PayrollError(
        "Alabama withholding for a nonresident needs the approved year-to-date count of Alabama "
        + "service days (Act 2025-334: 30 or fewer days is exempt from Alabama withholding). "
        + "Record approved dated Alabama work before calculating — refused by name",
      );
    }
    trace("AL_NONRESIDENT_DAYS", BigInt(days));
    if (days <= 30) {
      factors.AL_SAFE_HARBOR_EXEMPT = "1";
      return { state: "AL", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
    }
  }

  const code = (certificateChoice(input.certificate, "exemption") ?? "0") as AlExemption;
  if (code !== "0" && code !== "S" && code !== "MS" && code !== "M" && code !== "H") {
    throw new PayrollError(`Alabama exemption "${code}" is not 0, S, MS, M, or H`);
  }
  const dependents = certificateCount(input.certificate, "dependents") ?? 0;
  const periodFederal = input.federalIncomeTax;
  if (periodFederal == null || periodFederal.trim() === "") {
    throw new PayrollError(
      "Alabama withholding (ALDOR formula line 2B) requires this period's federal "
      + "income tax withheld from the current Pub 15-T calculation. The engine will not assume $0.",
    );
  }

  // Approved exempt severance (2024 booklet p. 14: employer-requested,
  // ALDOR-written-approval severance up to $50,000) is carved out of the
  // formula base — regular and supplemental alike — and traced as separate
  // wages. When this computation prices a separately paid supplemental
  // stream the dispatcher, not the formula, removes it (see
  // separateFlatExclusion below): the formula only ever carves the combined
  // stream it actually prices.
  const periodSeverance = alApprovedSeverance(input.supportingCertificates?.us_al_severance_approval);
  const wagesTotal = U(input.wages) + U(input.supplemental ?? "0");
  if (input.supplementalPaymentTiming !== "separate" && periodSeverance > 0n) {
    if (periodSeverance > wagesTotal) {
      throw new PayrollError(
        "Alabama attested severance exceeds this period's pay — "
        + "correct the attestation before calculating; refused by name",
      );
    }
    trace("AL_EXEMPT_SEVERANCE", periodSeverance);
  }
  const wages = wagesTotal - (input.supplementalPaymentTiming !== "separate" ? periodSeverance : 0n);
  const gi = wages * BigInt(P);
  trace("AL_GI", gi);

  const standard = alStandardDeduction(code, gi);
  trace("AL_STANDARD_DEDUCTION", standard);
  const federal = U(periodFederal) * BigInt(P);
  trace("AL_FEDERAL_ANNUAL", federal);
  const personal = alPersonalExemption(code);
  trace("AL_PERSONAL_EXEMPTION", personal);
  const deps = alDependentAllowance(gi, dependents);
  trace("AL_DEPENDENTS", deps);

  const deductions = standard + federal + personal + deps;
  trace("AL_DEDUCTIONS", deductions);
  const taxable = max0(gi - deductions);
  trace("AL_TAXABLE", taxable);

  const annualTax = alAnnualTax(code, taxable);
  trace("AL_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("AL_WITHHELD", total);

  return {
    state: "AL",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the ALDOR booklet's own (Formula lines 1–6) — see
 * the module header.
 */
export const AL_FACTOR_LABELS: Readonly<Record<string, string>> = {
  AL_MILITARY_SPOUSE_EXEMPT: "Alabama military-spouse wages exempt from withholding",
  AL_EXEMPT_SEVERANCE: "Alabama ALDOR-approved exempt severance, priced as separate wages",
  AL_NONRESIDENT_DAYS: "Alabama services calendar-day count this year",
  AL_SAFE_HARBOR_EXEMPT: "Alabama 30-day safe-harbor wages exempt from withholding",
  AL_GI: "Alabama gross income (annualized)",
  AL_STANDARD_DEDUCTION: "Alabama standard deduction",
  AL_FEDERAL_ANNUAL: "Alabama federal-tax deduction (annualized)",
  AL_PERSONAL_EXEMPTION: "Alabama personal exemption",
  AL_DEPENDENTS: "Alabama dependent allowance",
  AL_DEDUCTIONS: "Alabama total deductions",
  AL_TAXABLE: "Alabama taxable income",
  AL_ANNUAL_TAX: "Alabama tax (annual)",
  AL_WITHHELD: "Alabama tax withheld this period",
};

export const AL_WITHHOLDING: UsStateWithholdingEngine = {
  state: "AL",
  label: "Alabama income tax",
  certificateKey: "us_al_a4",
  supportingCertificateKeys: ["us_al_a4_ms", "us_al_severance_approval"],
  separateFlatExclusion: (supporting) => D(alApprovedSeverance(supporting.us_al_severance_approval)),
  ratesModule: RATES_MODULE,
  editions: AL_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Alabama withholding declarations — Form A-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form A-4, Employee's Withholding Exemption Certificate. */
export const AL_CERTIFICATE: PayrollCertificate = {
  key: "us_al_a4",
  form: "A-4",
  label: "Employee's Withholding Exemption Certificate (Alabama)",
  scope: { level: "region", region: "AL" },
  purpose: "withholding",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024; Form A-4; Ala. Admin. "
    + "Code r. 810-3-71-.02",
  summary:
    "Sets the Alabama withholding exemption (0, S, MS, M, H) and dependents. "
    + "Federal Form W-4 is not an acceptable substitute. If an employee fails to "
    + "furnish Form A-4, the employer withholds using zero exemptions.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemption",
      label: "Withholding exemption (Form A-4)",
      kind: "choice",
      default: "0",
      choices: [
        { value: "0", label: "0 — no personal exemption" },
        { value: "S", label: "S — single personal exemption ($1,500)" },
        { value: "MS", label: "MS — married filing separately ($1,500)" },
        { value: "M", label: "M — married filing jointly ($3,000)" },
        { value: "H", label: "H — head of family ($3,000)" },
      ],
      help:
        "Default 0 is ALDOR's own rule when no A-4 is on file. H uses the head-of-family "
        + "standard deduction and the 0/S/MS tax brackets. M is the only status that "
        + "uses the doubled brackets.",
    },
    {
      key: "dependents",
      label: "Dependents other than spouse",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each dependent is $1,000 / $500 / $300 a year depending on annualized GI "
        + "(≤ $50,000 / ≤ $100,000 / above). Not the spouse — M already covers both "
        + "personal exemptions.",
    },
    {
      key: "additional_per_period",
      label: "Additional Alabama withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help: "Added AFTER the formula is de-annualized. A flat dollar amount.",
    },
  ],
};

/** Alabama Form A4-MS, separate from the ordinary A-4 allowance certificate. */
export const AL_A4_MS_CERTIFICATE: PayrollCertificate = {
  key: "us_al_a4_ms",
  form: "A4-MS",
  label: "Alabama Nonresident Military Spouse Withholding Tax Exemption Certificate",
  scope: { level: "region", region: "AL" },
  purpose: "withholding",
  citation:
    "Alabama Department of Revenue, Form A4-MS (Rev. 09/2019); ALDOR military-spouse withholding FAQ",
  summary:
    "A separate MSRRA certificate. All seven employee eligibility statements must be true, and the employer retains the current military ID, DD Form 2058, and a recent Leave and Earnings Statement.",
  storage: "certificate_rows",
  fields: [
    { key: "spouse_is_active_duty_member", label: "Employee's spouse is an active-duty military servicemember", kind: "flag", help: "Required A4-MS condition 1." },
    { key: "employee_is_not_servicemember", label: "Employee is not a military servicemember", kind: "flag", help: "Required A4-MS condition 2." },
    { key: "current_orders_assign_al", label: "Current orders assign the servicemember to a military location in Alabama", kind: "flag", help: "Required A4-MS condition 3." },
    { key: "employee_here_to_accompany", label: "Employee is in Alabama solely to be with the servicemember", kind: "flag", help: "Required A4-MS condition 4." },
    { key: "same_current_address", label: "Employee and servicemember live at the same address", kind: "flag", help: "Required A4-MS condition 5." },
    { key: "employee_domicile_outside_al", label: "Employee is domiciled outside Alabama", kind: "flag", help: "Required A4-MS condition 6." },
    { key: "same_domicile", label: "Employee and servicemember share the same domicile", kind: "flag", help: "Required A4-MS condition 7." },
    { key: "military_id_on_file", label: "Current military spouse identification is on file", kind: "flag", help: "ALDOR requires the employer to retain a clear copy of the current military spouse ID." },
    { key: "dd2058_on_file", label: "DD Form 2058 is on file", kind: "flag", help: "ALDOR requires the servicemember's state-of-legal-residence certificate." },
    { key: "recent_les_on_file", label: "Recent Leave and Earnings Statement is on file", kind: "flag", help: "ALDOR requires a recent servicemember LES." },
  ],
};

/**
 * Payer-held approved-severance attestation (no state form exists — the
 * 2024 booklet describes an employer-requested, ALDOR-written-approval
 * program covering the first $50,000 of severance).
 */
export const AL_SEVERANCE_APPROVAL_CERTIFICATE: PayrollCertificate = {
  key: "us_al_severance_approval",
  form: "Severance approval attestation",
  label: "Alabama approved severance attestation",
  scope: { level: "region", region: "AL" },
  purpose: "withholding",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024, p. 14",
  summary:
    "The employer attests the ALDOR written approval and the approved and "
    + "period severance amounts so only the first $50,000 of approved severance is excluded.",
  storage: "certificate_rows",
  fields: [
    {
      key: "aldor_approval_on_file",
      label: "ALDOR written approval of the severance plan is on file",
      kind: "flag", required: true,
      help: "The exemption needs an employer-requested plan with ALDOR written approval.",
    },
    {
      key: "approved_amount",
      label: "ALDOR-approved exempt severance total",
      kind: "amount", decimals: 4, min: "0.01", required: true,
      help: "Only the first $50,000 of approved severance is excludable.",
    },
    {
      key: "period_severance",
      label: "This period's severance in the approved program",
      kind: "amount", decimals: 4, min: "0", required: true,
      help: "Must not exceed the approved total, nor this period's pay on the combined path.",
    },
  ],
};

export const AL_REGION: PayrollRegionWithholding = {
  region: "AL",
  label: "Alabama income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // ALDOR Withholding Booklet: an Alabama employer withholds from Alabama
  // residents regardless of where the wages are earned, except when already
  // withholding for the work state — a conditional waiver, not a credit.
  residentWithholding: "required",
  residentWithholdingImplemented: true,
  residentWithholdingMethod: { kind: "waive_when_work_region_withheld" },
  certificateKey: "us_al_a4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents (Booklet 1-26); Ala. Admin. Code r. 810-3-71-.02",
};
