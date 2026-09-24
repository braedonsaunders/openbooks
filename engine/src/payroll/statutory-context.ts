import type { db } from "../platform/db.ts";
import type { ResolvedCertificate, StoredCertificate } from "./certificates.ts";
import type { PayrollAssessedOn, PayrollTaxBaseKey } from "./packs.ts";

/** One line in the stub set `calculateStub` builds before the statutory pass. */
export interface StubLine {
  componentId: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  description: string;
  hours?: string;
  rate?: string;
  amount: string;
  projectId?: string | null;
  departmentId?: string | null;
  timeTypeId?: string | null;
  sequence: number;
  taxable?: boolean;
  pensionable?: boolean;
  insurable?: boolean;
  vacationable?: boolean;
  nonPeriodic?: boolean;
  taxTreatment?: string;
  accrualOnly?: boolean;
  assessedOn?: PayrollAssessedOn;
  classification?: string;
  protectionBase?: string;
  protectionMaxPercent?: string | null;
  protectionPriority?: number;
  includeInDisposableEarnings?: boolean;
}

export interface StatutoryAllocation {
  amount: string;
  projectId?: string | null;
  departmentId?: string | null;
}

/**
 * Push one statutory line. `kind` answers what the money IS:
 *
 * - `deduction` — withheld from pay; DECREASES net.
 * - `employer_contribution` — accrued at the employer's cost; leaves net
 *   alone and raises employer cost.
 * - `credit` — a refundable employment credit the employer PAYS the employee
 *   through payroll and reclaims from the tax authority (Italy’s trattamento
 *   integrativo and c. 4 somma, recovered via F24 compensation). A credit is
 *   earnings-assessed, computed from gross, pushed ONCE and never re-derived
 *   by the protection fixpoint (exactly like an earnings line); it INCREASES
 *   net pay, and its `remittance: "tax_authority"` is the reclaim — the
 *   remittance summary nets it against the same destination’s withholdings.
 */
export type PushStatutoryFn = (
  systemKey: string,
  kind: "deduction" | "employer_contribution" | "credit",
  description: string,
  amount: string,
  sequence: number,
  options?: { allocations?: readonly StatutoryAllocation[] },
) => void;

/** Phase-8 employer levy factors consumed by the pack's statutory pass. */
export interface PayrollEmployerLevyFactors {
  wcbAmount: string;
  wcbAssessable: string;
  ehtAmount: string;
  ehtEarnings: string;
  hsfAmount: string;
  hsfEarnings: string;
}

export const EMPTY_EMPLOYER_LEVY_FACTORS: PayrollEmployerLevyFactors = {
  wcbAmount: "0",
  wcbAssessable: "0",
  ehtAmount: "0",
  ehtEarnings: "0",
  hsfAmount: "0",
  hsfEarnings: "0",
};

/** Phase 8 — pack-declared earnings-assessed employer levies (WCB/EHT/HSF for CA). */
export interface PayrollEmployerLevyContext {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  employeePartyId: string;
  employeeName: string;
  taxYear: number;
  region: string;
  lines: readonly StubLine[];
  pushStatutory: PushStatutoryFn;
  /** ISO pay date the tenant-rate resolution is as-of; absent reads current. */
  payDate?: string;
}

/** Verified share of current-period wages sourced to one subregion. */
export interface PayrollWorkAllocation {
  region: string;
  /** Null is the region-wide share; a code scopes a city/local allocation. */
  subRegion: string | null;
  /** Exact decimal share from 0 through 1; no floating-point percentage. */
  workShare: string;
  /** Certificate or work-record provenance retained for the statutory trace. */
  source: string;
}

/** Phase 9 — one re-runnable statutory pass over the current line set. */
export interface PayrollStatutoryComputeContext {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  employeePartyId: string;
  employeeName: string;
  taxYear: number;
  country: string;
  region: string;
  run: Record<string, string>;
  emp: Record<string, string | null>;
  filingAccountId: string | null;
  periodsPerYear: number;
  /** Employee headcount of the paying employer, isolated to its legal entity. */
  employerEmployeeCount?: number;
  /** Work-location allocations shared by regional and subregional payroll rules. */
  workAllocations?: readonly PayrollWorkAllocation[];
  /**
   * THE MONEY CONTRACT. Every amount below is the ledger's canonical
   * numeric(19,4) decimal string (engine/src/money/money.ts `toUnits`/`fromUnits`):
   * up to 4 decimal places, trailing zeros included, plain integers accepted
   * ("0.0000", "999.0000", "0", "0.00" are all legal money; "" is not money —
   * it means absent, and only `insurable`/`nonPeriodic` admit it).
   *
   * `calculateStub` sums earning lines with money.ts `sum`, so these ALWAYS
   * arrive at 4 decimals — even "0.0000" for an empty base. A pack MUST parse
   * them with money.ts (`toUnits`, or `toCents` for cent-based publications)
   * and MUST NOT use its own 1-or-2-decimal regex: that shape refuses the
   * pipeline's canonical output and no Dutch employee gets paid. Sub-cent
   * fractions round half-up to the cent through `toCents` unless the
   * publication states its own boundary rule (BR truncates per
   * BR_2026_ROUNDING, stated there).
   */
  income: string;
  nonPeriodic: string;
  pensionable: string;
  insurable: string;
  /**
   * Per-program bases for contribution programs the pack declares, keyed by
   * program key (see `PayrollContributionProgram`). Absent (undefined) only
   * on unit-constructed contexts, where every program reads the `insurable`
   * leg (legacy math, bit-identical); the engine always provides it. A pack
   * prices and files each program off its own base, never another's.
   */
  programBases?: Record<string, string>;
  /**
   * The pensionable-flagged share of the period's non-periodic one-offs — a
   * subset of `pensionable` (and, for taxable one-offs, of `nonPeriodic`).
   * `pensionable` itself carries every pensionable period line INCLUDING a
   * one-off, so a pack that annualises the leg and adds the one-off again
   * counts it periodsPerYear + 1 times. Absent (undefined) only on
   * unit-constructed contexts, where it defaults to "0" (legacy math,
   * bit-identical); the engine always provides it.
   */
  pensionableNonPeriodic?: string;
  /**
   * Each base above less the deduction lines carrying a treatment the pack
   * declares as reducing that base (`reduceTaxBases` over the pack's
   * `deductionTreatments`). An engine whose levy is assessed on income after
   * pre-tax deductions prices off the reduced leg and leaves the others
   * alone — salary sacrifice moves PAYG but not superannuation guarantee.
   * Keys the pack does not declare are inert here, so a foreign factor can
   * never leak across packs. Engines that predate the channel keep reading
   * the raw legs plus `deduction()` and are untouched by it.
   */
  reducedBases: Record<PayrollTaxBaseKey, string>;
  deduction: (treatment: string) => string;
  pushStatutory: PushStatutoryFn;
  storedCertificates: readonly StoredCertificate[];
  certificateFor: (key: string) => ResolvedCertificate | null;
  /**
   * Report a named, non-blocking advisory for the run's per-employee warning
   * channel (a reciprocity form to collect, not a refusal). Optional so packs
   * that have nothing advisory keep ignoring it; the stub carries the
   * advisories that matter on its own trace factors.
   */
  noteAdvisory?: (message: string) => void;
  bool: (value: string | null | undefined) => boolean;
  /** Bound by `calculateStub` — the pack refuses unsupported regions itself. */
  assertRegionSupported: (region: string) => void;
  employerLevies: PayrollEmployerLevyFactors;
}
