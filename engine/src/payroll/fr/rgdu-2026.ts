import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { PayrollPackError } from "../payroll-error.ts";

export interface FrRgduYearToDate {
  remuneration: string;
  smic: string;
  reduction: string;
}

/** Committed French runs only; draft or calculated stubs never consume YTD. */
export async function committedFrRgduYearToDate(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  subsidiaryId: string;
  employeePartyId: string;
  employmentId: string;
  taxYear: number;
  payDate: string;
  excludeDocumentId: string;
}): Promise<FrRgduYearToDate> {
  const row = (await input.tx.execute<{
    remuneration: string;
    smic: string;
    reduction: string;
  }>(sql`
    select round(coalesce(sum(s.gross), 0), 4)::numeric(24, 4)::text as remuneration,
           round(coalesce(sum(coalesce((s.factors->>'FR_RGDU_SMIC')::numeric, 0)), 0), 4)::numeric(24, 4)::text as smic,
           round(coalesce(sum(coalesce((s.factors->>'FR_RGDU_ADJUSTMENT')::numeric, 0)), 0), 4)::numeric(24, 4)::text as reduction
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id
                    and r.document_id = s.pay_run_document_id
                    and r.run_status = 'committed'
      join documents d on d.org_id = r.org_id and d.id = r.document_id
     where s.org_id = ${input.orgId}
       and s.employee_party_id = ${input.employeePartyId}
       and s.employment_id = ${input.employmentId}::uuid
       and s.country = 'FR'
       and s.tax_year = ${input.taxYear}
       and s.pay_date <= ${input.payDate}::date
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and d.subsidiary_id = ${input.subsidiaryId}::uuid
  `)).rows[0];
  return row ?? { remuneration: "0", smic: "0", reduction: "0" };
}

/** Pure calculation for the French 2026 reduction générale dégressive unique. */
export interface FrRgdu2026Input {
  /** Effective-dated legal employer effectif, not the live payroll roster. */
  employerEffectif: string;
  eligible: boolean;
  remunerationYearToDate: string;
  smicYearToDate: string;
  priorReductionYearToDate: string;
  /** Employer rates covered by the RGDU and recouvrées by URSSAF, as a fraction. */
  urssafCoveredRate: string;
  /** Employer rates covered by the RGDU and recouvrées by AGIRC-ARRCO, as a fraction. */
  agircArrcoCoveredRate: string;
}

export interface FrRgdu2026Result {
  coefficient: string;
  cumulativeReduction: string;
  periodAdjustment: string;
  urssafAdjustment: string;
  agircArrcoAdjustment: string;
  maximumCoefficient: string;
}

/**
 * Calculate the annualised/progressively regularised RGDU amount. Amounts are
 * exact decimal strings; implementation follows CSS D.241-7 and URSSAF's
 * progressive-regularisation example.
 */
const CENT_UNITS = 100n;
const COEFFICIENT_SCALE = 100_000_000n;
const POWER_SCALE = 100_000_000_000_000n;
const SMIC_HOURLY_UNITS = toUnits("12.02");
function amount(value: string, label: string): bigint {
  try {
    const parsed = toUnits(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new PayrollPackError(`FR RGDU ${label} must be a non-negative exact decimal amount: "${value}"`);
  }
}

function rate(value: string, label: string): bigint {
  const parsed = amount(value, label);
  if (parsed > 10_000n) {
    throw new PayrollPackError(`FR RGDU ${label} must not exceed 1.0, got "${value}"`);
  }
  return parsed * 10_000n;
}

/**
 * 2026 annual minimum-wage base for the paid hours in one payroll period.
 * Ordinary contractual hours and eligible overtime/complementary hours are
 * separate inputs because only the latter are added to the part-time ratio.
 */
export function frRgduSmicFromHours2026(
  ordinaryHours: string,
  eligibleExtraHours: string,
): string {
  const ordinary = amount(ordinaryHours, "ordinary hours");
  const extra = amount(eligibleExtraHours, "overtime/complementary hours");
  const base = roundDiv((ordinary + extra) * SMIC_HOURLY_UNITS, 10_000n);
  return fromUnits(roundDiv(base, CENT_UNITS) * CENT_UNITS);
}

/** Integer nth-root rounded down; no floating-point exponentiation. */
function integerRoot(value: bigint, degree: bigint): bigint {
  if (value < 0n || degree < 1n) throw new Error("invalid integer root");
  if (value < 2n || degree === 1n) return value;
  const bits = BigInt(value.toString(2).length);
  let estimate = 1n << ((bits + degree - 1n) / degree);
  for (;;) {
    const divisor = estimate ** (degree - 1n);
    const next = ((degree - 1n) * estimate + value / divisor) / degree;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function coefficientUnits(
  remuneration: bigint,
  smic: bigint,
  tMin: bigint,
  tDelta: bigint,
): bigint {
  if (remuneration === 0n) return tMin + tDelta;
  if (remuneration >= 3n * smic) return 0n;

  // q = 1/2 × (3 × SMIC / annual remuneration − 1), then q^1.75.
  // Scaling q by 1e8 lets its seventh power have an exact integer fourth
  // root scale of 1e14 because 1e8 = 100^4.
  const q = roundDiv((3n * smic - remuneration) * COEFFICIENT_SCALE, 2n * remuneration);
  const qToSeven = q ** 7n;
  const powered = integerRoot(qToSeven, 4n);
  return tMin + roundDiv(tDelta * powered, POWER_SCALE);
}

export function calculateFrRgdu2026(input: FrRgdu2026Input): FrRgdu2026Result {
  let effectif: bigint;
  try {
    effectif = toUnits(input.employerEffectif);
  } catch {
    throw new PayrollPackError(`FR RGDU employer effectif is not an exact decimal: "${input.employerEffectif}"`);
  }
  if (effectif < 0n) {
    throw new PayrollPackError(`FR RGDU employer effectif must be non-negative, got "${input.employerEffectif}"`);
  }
  const remuneration = amount(input.remunerationYearToDate, "year-to-date remuneration");
  const smic = amount(input.smicYearToDate, "year-to-date SMIC");
  const prior = amount(input.priorReductionYearToDate, "prior year-to-date reduction");
  const urssafRate = rate(input.urssafCoveredRate, "covered URSSAF rate");
  const agircArrcoRate = rate(input.agircArrcoCoveredRate, "covered AGIRC-ARRCO rate");
  const actualCoveredRate = urssafRate + agircArrcoRate;
  const statutoryMaximum = effectif < 50n * 10_000n ? 39_810_000n : 40_210_000n;
  const maximumCoefficient = actualCoveredRate < statutoryMaximum
    ? actualCoveredRate : statutoryMaximum;
  const tMin = maximumCoefficient < 2_000_000n ? maximumCoefficient : 2_000_000n;
  const tDelta = maximumCoefficient - tMin;

  let coefficient = input.eligible && tDelta >= 0n
    ? coefficientUnits(remuneration, smic, tMin, tDelta)
    : 0n;
  // CSS D.241-7 rounds the coefficient to four decimals before applying it.
  coefficient = roundDiv(coefficient, 10_000n) * 10_000n;
  if (coefficient > maximumCoefficient) coefficient = maximumCoefficient;
  const target = input.eligible && remuneration < 3n * smic
    ? roundDiv(roundDiv(remuneration * coefficient, COEFFICIENT_SCALE), CENT_UNITS) * CENT_UNITS
    : 0n;
  const adjustment = target - prior;
  const cappedUrssafRate = actualCoveredRate > maximumCoefficient && actualCoveredRate > 0n
    ? roundDiv(urssafRate * maximumCoefficient, actualCoveredRate)
    : urssafRate;
  const urssafAdjustment = maximumCoefficient === 0n
    ? 0n
    : roundDiv(roundDiv(adjustment * cappedUrssafRate, maximumCoefficient), CENT_UNITS) * CENT_UNITS;
  const agircArrcoAdjustment = adjustment - urssafAdjustment;

  return {
    coefficient: fromUnits(coefficient / 10_000n),
    cumulativeReduction: fromUnits(target),
    periodAdjustment: fromUnits(adjustment),
    urssafAdjustment: fromUnits(urssafAdjustment),
    agircArrcoAdjustment: fromUnits(agircArrcoAdjustment),
    maximumCoefficient: fromUnits(maximumCoefficient / 10_000n),
  };
}
