import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { apportion, fromUnits, normalizeMoney, roundDiv, toUnits } from "../../money/money.ts";
import { daysInCivilMonth } from "../../platform/civil-date.ts";
import { InvalidCivilDateError, parseCivilDate } from "../temporal.ts";
import type {
  BenefitAllocation,
  BenefitFrequency,
  BenefitMetric,
  BenefitMetricScope,
  BenefitProgram,
  BenefitProgramMember,
  BenefitValuation,
} from "./program-types.ts";
import { BenefitsError } from "./errors.ts";

/**
 * Pure incentive valuation math: fixed awards, percent-of-measure awards,
 * and shared-pool apportionment over dated membership.
 *
 * Every amount crosses as an exact canonical decimal string
 * (numeric(19,4)); all arithmetic is integer units (bigint) — floating point
 * never touches an incentive value. No database, no clock, no imports from
 * the domain services: the settlement layer maps stored program rows onto
 * the inputs here, and the same function feeds previews, settlement, and
 * the plaintext policy explanation, so the explanation cannot drift from
 * the calculation.
 *
 * Percent rates are plain percentages ("2.5" is two and a half percent),
 * the same convention as the payroll money helpers.
 */

/**
 * Real calendar-date validation through the HRM temporal primitive — the
 * same validator behind benefits shared date checks (imported from its pure
 * source so this module stays database-free). Nonexistent dates such as
 * February 30th refuse here, never reach a period comparison.
 */
function requireDay(value: string, label: string): string {
  try {
    return parseCivilDate(value);
  } catch (error) {
    if (error instanceof InvalidCivilDateError) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `${label} ${JSON.stringify(value)} is not a real calendar date — use YYYY-MM-DD`,
      );
    }
    throw error;
  }
}

/**
 * Public exact-decimal contract: the shared plain grammar first, then the
 * kernel normalizer. Anything the
 * first gate refuses is named here with the remedy — never rounded, never
 * coerced.
 */
function requireCanonicalDecimal(value: string, label: string): string {
  if (canonicalDecimal(value, 4) === null) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(value)} is not an exact plain decimal — record digits like "1234.56" with at most 4 fraction digits, never exponents, separators, or symbols`,
    );
  }
  try {
    return normalizeMoney(value);
  } catch {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(value)} is not an exact decimal amount — record plain digits with at most 4 fraction digits, never separators or symbols`,
    );
  }
}

/** Measured source value for one settlement period. */
export interface IncentiveMeasured {
  readonly metric: BenefitMetric;
  readonly scope: BenefitMetricScope;
  /** Account ids the money measure summed (empty for approved_hours). */
  readonly sourceAccountIds: readonly string[];
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Canonical decimal in the metric's unit (money or hours). */
  readonly value: string;
  /** ISO currency for money metrics; null for approved_hours. */
  readonly currency: string | null;
}

/** One membership's share evidence for the period. */
export interface IncentiveMemberShare {
  readonly employmentId: string;
  /** Recorded effective-dated membership weight (role allocation). */
  readonly weight: string | null;
  /** Approved hours in scope and period (hours allocation). */
  readonly hours: string | null;
  /** Membership span covering the settlement (evidence, not input to math). */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface IncentiveRecipientResult {
  readonly employmentId: string;
  /** Exact share of the distributable pool, as "numerator/denominator". */
  readonly share: string;
  /** Pre-cap award (canonical decimal). */
  readonly grossValue: string;
  /** Post-cap award (canonical decimal). */
  readonly value: string;
  readonly capped: boolean;
  /** Plaintext arithmetic for this recipient, from the same numbers. */
  readonly explanation: string;
}

export interface IncentiveComputation {
  readonly measuredValue: string;
  /** Distributable pool (percent and pool valuations; "0.0000" for fixed). */
  readonly poolValue: string;
  readonly thresholdMet: boolean;
  readonly recipients: readonly IncentiveRecipientResult[];
  /**
   * Named zero exclusions: shares that round to zero at payable precision.
   * They take nothing (a recorded zero is a no-op write) while the pool
   * still apportions exactly across the rest — a legitimate cent pool is
   * never refused because most shares round down.
   */
  readonly excludedZero: readonly string[];
  readonly totalAwarded: string;
  /** Pool left undistributed by per-recipient caps (never re-apportioned). */
  readonly undistributed: string;
  readonly currency: string;
  /** Plaintext policy explanation, one line per fact, from the same config. */
  readonly summaryLines: readonly string[];
}

function isMoneyMetric(metric: BenefitMetric): boolean {
  return metric === "revenue" || metric === "gross_profit" || metric === "net_profit";
}

function describeMetric(metric: BenefitMetric): string {
  switch (metric) {
    case "revenue": return "revenue";
    case "gross_profit": return "gross profit";
    case "net_profit": return "net profit";
    case "approved_hours": return "approved hours";
  }
}

/**
 * Rounding policy, stated once: apportionment is EXACT in ledger units
 * (0.0001). No rounding ever occurs — each part is its exact share floored
 * and the leftover units are dealt by largest remainder, so the parts sum
 * to the pool unit-for-unit and every cent is preserved. Determinism comes
 * from sorting recipients by employment id first: ties break to the earlier
 * id, so the same inputs always produce the same awards.
 *
 * Delegates to the shared money apportion helper rather than a local
 * splitter; the guards here translate its errors into named benefits
 * refusals and reject duplicate recipients, which a parallel array cannot
 * see.
 */
export function apportionExactUnits(
  totalUnits: bigint,
  weights: ReadonlyArray<{ readonly employmentId: string; readonly units: bigint }>,
): Map<string, bigint> {
  if (totalUnits < 0n) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "apportionment needs a non-negative pool — losses are refused before they reach the split",
    );
  }
  const ordered = [...weights].sort((a, b) => (a.employmentId < b.employmentId ? -1 : 1));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.employmentId === ordered[i - 1]!.employmentId) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `employment ${ordered[i]!.employmentId} appears twice in one apportionment — attribute each member's share once; duplicates would double-pay`,
      );
    }
  }
  let parts: bigint[];
  try {
    parts = apportion(totalUnits, ordered.map((w) => w.units), { residual: "largest_remainder" });
  } catch (error) {
    throw new BenefitsError(
      "REFUSED",
      `apportionment cannot split ${fromUnits(totalUnits)}: ${error instanceof Error ? error.message : String(error)} — record positive allocation evidence (hours or role weights) before settling`,
    );
  }
  return new Map(ordered.map((w, i) => [w.employmentId, parts[i]!]));
}

/**
 * Measurement basis for monthly/quarterly/annual frequencies. Calendar is
 * the Gregorian calendar named explicitly — never a silent default. Fiscal
 * names the organization's fiscal calendar (resolved from the native fiscal
 * calendar row and snapshotted with the settlement); quarterly and annual
 * spans follow its year-start month for monthly-cadence calendars. A
 * week-based fiscal calendar (4-4-5 and peers) has no month-aligned
 * quarters, so those frequencies refuse there and the program settles on
 * manual spans that match the fiscal periods.
 */
export type IncentivePeriodBasis =
  | { readonly kind: "calendar" }
  | {
    readonly kind: "fiscal";
    readonly calendarName: string;
    readonly yearStartMonth: number;
    readonly cadence: string;
  };

export function describePeriodBasis(basis: IncentivePeriodBasis): string {
  return basis.kind === "calendar" ? "calendar" : `fiscal calendar "${basis.calendarName}"`;
}

/** Eligible-period shape per measurement frequency; manual accepts any span. */
function requirePeriodShape(
  frequency: BenefitFrequency,
  from: string,
  to: string,
  basis: IncentivePeriodBasis,
): void {
  const parts = (value: string): [number, number, number] => {
    const [y, m, d] = value.split("-").map(Number);
    if (y === undefined || m === undefined || d === undefined) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `settlement period date ${JSON.stringify(value)} is not a civil date — use YYYY-MM-DD`,
      );
    }
    return [y, m, d];
  };
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (from > to) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `settlement period ${from}..${to} ends before it starts — name the measured span with periodFrom on or before periodTo`,
    );
  }
  const basisLabel = describePeriodBasis(basis);
  const yearStartMonth = basis.kind === "calendar" ? 1 : basis.yearStartMonth;
  if (
    basis.kind === "fiscal" && basis.cadence !== "monthly" &&
    (frequency === "monthly" || frequency === "quarterly" || frequency === "annual")
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `a ${frequency} program cannot follow ${basisLabel} (cadence ${basis.cadence} has no month-aligned periods) — settle this period on a manual span that matches the fiscal periods, or reconfigure the frequency`,
    );
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
  switch (frequency) {
    case "monthly": {
      if (!(fy === ty && fm === tm && fd === 1 && td === daysInCivilMonth(ty, tm))) {
        throw new BenefitsError(
          "INVALID_INPUT",
          `a monthly program settles whole months — ${from}..${to} is not one on the ${basisLabel}; settle ${from.slice(0, 7)}-01..month-end or reconfigure the frequency`,
        );
      }
      return;
    }
    case "quarterly": {
      // Quarter containing `from`, counted from the basis year-start month.
      const startIdx = yearStartMonth - 1;
      const fromIdx = fm! - 1;
      const startYear = fromIdx >= startIdx ? fy! : fy! - 1;
      const quarter = Math.floor((((fromIdx - startIdx + 12) % 12) / 3));
      const qStart = (startIdx + quarter * 3) % 12;
      const qStartYear = startYear + (startIdx + quarter * 3 >= 12 ? 1 : 0);
      const qEnd = (qStart + 2) % 12;
      const qEndYear = qStartYear + (qStart + 2 >= 12 ? 1 : 0);
      const expectFrom = day(qStartYear, qStart + 1, 1);
      const expectTo = day(qEndYear, qEnd + 1, daysInCivilMonth(qEndYear, qEnd + 1));
      if (from !== expectFrom || to !== expectTo) {
        throw new BenefitsError(
          "INVALID_INPUT",
          `a quarterly program settles whole quarters — ${from}..${to} is not ${expectFrom}..${expectTo} on the ${basisLabel}; settle the full quarter or reconfigure the frequency`,
        );
      }
      return;
    }
    case "annual": {
      const startYear = (fm! - 1) >= (yearStartMonth - 1) ? fy! : fy! - 1;
      const endIdx = (yearStartMonth - 1 + 11) % 12;
      const endYear = startYear + (yearStartMonth - 1 + 11 >= 12 ? 1 : 0);
      const expectFrom = day(startYear, yearStartMonth, 1);
      const expectTo = day(endYear, endIdx + 1, daysInCivilMonth(endYear, endIdx + 1));
      if (from !== expectFrom || to !== expectTo) {
        throw new BenefitsError(
          "INVALID_INPUT",
          `an annual program settles whole years — ${from}..${to} is not ${expectFrom}..${expectTo} on the ${basisLabel}; settle the full year or reconfigure the frequency`,
        );
      }
      return;
    }
    case "project_complete":
      // Source measurement separately requires the selected native projects
      // to be closed; the pure date validator only validates the chosen span.
    case "manual":
      return;
  }
}

/** Memberships whose effective span touches the settlement period. */
export function eligibleMembers(
  members: readonly BenefitProgramMember[],
  periodFrom: string,
  periodTo: string,
): BenefitProgramMember[] {
  for (const m of members) validateMembershipSpan(m);
  return members.filter((m) =>
    m.effectiveFrom <= periodTo && (m.effectiveTo === null || m.effectiveTo >= periodFrom),
  );
}

function validateMembershipSpan(m: BenefitProgramMember): void {
  requireDay(m.effectiveFrom, "membership effective_from");
  if (m.effectiveTo !== null) requireDay(m.effectiveTo, "membership effective_to");
  if (m.effectiveTo !== null && m.effectiveTo < m.effectiveFrom) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `membership for employment ${m.employmentId} ends ${m.effectiveTo} before it starts ${m.effectiveFrom} — end it on or after its start`,
    );
  }
}

export interface MemberCoverage {
  /** Members covering the whole period: full shares, no proration. */
  readonly covered: BenefitProgramMember[];
  /**
   * Members touching but not covering the period. No proration policy
   * exists in configuration, so a partial member cannot take a full
   * share — the settlement excludes them with a named line (hours
   * allocations excepted: approved time already prorates by nature).
   */
  readonly partial: BenefitProgramMember[];
}

/** Split touching memberships into full-period and partial coverage. */
export function partitionMembers(
  members: readonly BenefitProgramMember[],
  periodFrom: string,
  periodTo: string,
): MemberCoverage {
  const touching = eligibleMembers(members, periodFrom, periodTo);
  const covered = touching.filter(
    (m) => m.effectiveFrom <= periodFrom && (m.effectiveTo === null || m.effectiveTo >= periodTo),
  );
  const coveredIds = new Set(covered.map((m) => m.employmentId));
  return { covered, partial: touching.filter((m) => !coveredIds.has(m.employmentId)) };
}

export interface ComputeIncentiveInput {
  readonly program: BenefitProgram;
  readonly measured: IncentiveMeasured;
  readonly shares: readonly IncentiveMemberShare[];
  /** Named measurement basis; the settlement layer resolves and snapshots it. */
  readonly periodBasis: IncentivePeriodBasis;
  /**
   * Payable minor units of the settlement currency (2 for USD/EUR, 0 for
   * JPY). Awards apportion in these units so the payable parts sum exactly
   * to the payable pool — no cash rounding happens downstream.
   */
  readonly minorUnits: number;
}

/**
 * Value every eligible member's award for the period. Refuses by name on
 * unconfigured or incoherent inputs (missing rate/pool, losses on a money
 * metric, missing share evidence, budget overrun) — never a guessed zero.
 * A threshold miss or an all-zero measure returns zero awards with the
 * reason in the summary lines; the settlement layer refuses to persist
 * those (a persisted zero is a no-op write).
 */
export function computeIncentiveAwards(input: ComputeIncentiveInput): IncentiveComputation {
  const { program, measured, shares, periodBasis, minorUnits } = input;
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `payable minor units ${minorUnits} is not 0..4 — resolve it from the settlement currency's minor units; the payable precision is never guessed`,
    );
  }
  // Payable-unit policy, stated once: awards apportion in the currency's
  // minor units (cents, yen), not ledger ten-thousandths. The pool rounds
  // once, halves away from zero, to payable precision BEFORE the split, and
  // the split is exact in those units — payroll, UI, and tax consume the
  // payable figures with no rounding left to do downstream. Fixed and cap
  // amounts finer than payable precision refuse: configured cash must BE
  // payable, never silently rounded.
  const quantum = 10n ** BigInt(4 - minorUnits);
  const toMinor = (units4dp: bigint): bigint => roundDiv(units4dp, quantum);
  const fromMinor = (minor: bigint): string => fromUnits(minor * quantum);
  if (periodBasis.kind === "fiscal") {
    if (!Number.isInteger(periodBasis.yearStartMonth) || periodBasis.yearStartMonth < 1 || periodBasis.yearStartMonth > 12) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `fiscal year-start month ${periodBasis.yearStartMonth} is not 1..12 — resolve it from the organization's fiscal calendar row; the basis is never hand-typed`,
      );
    }
  }
  const valuation: BenefitValuation = program.valuation;
  if (valuation !== "fixed" && valuation !== "percent" && valuation !== "pool") {
    throw new BenefitsError(
      "INVALID_INPUT",
      `valuation ${JSON.stringify(valuation)} is unknown — configure fixed, percent, or pool with no silent default`,
    );
  }
  if (measured.metric !== "revenue" && measured.metric !== "gross_profit" &&
      measured.metric !== "net_profit" && measured.metric !== "approved_hours") {
    throw new BenefitsError(
      "INVALID_INPUT",
      `metric ${JSON.stringify(measured.metric)} is unknown — configure revenue, gross_profit, net_profit, or approved_hours`,
    );
  }
  if (program.metric !== null && program.metric !== measured.metric) {
    throw new BenefitsError(
      "REFUSED",
      `the program measures ${program.metric} but the settlement measured ${measured.metric} — re-run the preview for the configured metric; a program never settles a measure it did not declare`,
    );
  }
  requireDay(measured.periodFrom, "periodFrom");
  requireDay(measured.periodTo, "periodTo");
  requirePeriodShape(program.frequency, measured.periodFrom, measured.periodTo, periodBasis);
  const measuredValue = requireCanonicalDecimal(measured.value, "measured value");
  const measuredUnits = toUnits(measuredValue);
  const moneyMetric = isMoneyMetric(measured.metric);
  if (moneyMetric && measured.currency === null) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `a ${describeMetric(measured.metric)} measure needs its currency — measures never mix currencies`,
    );
  }
  if (moneyMetric && measuredUnits < 0n) {
    throw new BenefitsError(
      "REFUSED",
      `the measured ${describeMetric(measured.metric)} for ${measured.periodFrom}..${measured.periodTo} is a loss (${measuredValue}) — losses are never auto-shared; record an explicit loss rule or settle a period that earned`,
    );
  }
  const currency = moneyMetric ? measured.currency! : program.currency;
  const summary: string[] = [
    `${program.code} — ${program.name}: ${valuation} ${describeMetric(measured.metric)} ` +
      `over ${measured.periodFrom}..${measured.periodTo} (${describePeriodBasis(periodBasis)}), measured ${measuredValue}` +
      (moneyMetric ? ` ${currency}` : " hours"),
  ];

  const noAwards = (lines: string[]): IncentiveComputation => ({
    measuredValue, poolValue: "0.0000", thresholdMet: false, recipients: [],
    excludedZero: [], totalAwarded: "0.0000", undistributed: "0.0000",
    currency, summaryLines: lines,
  });
  if (program.thresholdAmount !== null) {
    const threshold = requireCanonicalDecimal(program.thresholdAmount, "threshold amount");
    if (measuredUnits < toUnits(threshold)) {
      return noAwards([
        ...summary,
        `threshold ${threshold} not met by measured ${measuredValue} — no award is owed for this period`,
      ]);
    }
    summary.push(`threshold ${threshold} met by measured ${measuredValue}`);
  }

  const capUnits4dp = program.capAmount !== null ? toUnits(requireCanonicalDecimal(program.capAmount, "cap amount")) : null;
  if (capUnits4dp !== null && capUnits4dp <= 0n) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `cap ${program.capAmount} caps every award at zero or less — raise the cap or remove it; a program that can never pay refuses at configuration, not at settlement`,
    );
  }
  const capMinor = capUnits4dp !== null ? toMinor(capUnits4dp) : null;
  if (capUnits4dp !== null && capMinor! * quantum !== capUnits4dp) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `cap ${program.capAmount} is finer than payable precision — configure the cap to a payable figure; configured cash is never silently rounded`,
    );
  }

  const shareById = new Map(shares.map((s) => [s.employmentId, s]));
  const eligible = shares.map((s) => s.employmentId);
  if (eligible.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      `no member is eligible for ${measured.periodFrom}..${measured.periodTo} — check program membership dates cover the period before settling`,
    );
  }

  // Fixed awards: one amount per eligible member (hours allocation additionally
  // requires positive approved time as the work evidence).
  if (valuation === "fixed") {
    if (program.fixedAmount === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} values fixed awards but names no fixed amount — set the award amount before settling`,
      );
    }
    const fixedUnits = toUnits(requireCanonicalDecimal(program.fixedAmount, "fixed amount"));
    if (fixedUnits <= 0n) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `fixed amount ${program.fixedAmount} is not positive — a fixed award must be a positive amount`,
      );
    }
    if (fixedUnits % quantum !== 0n) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `fixed amount ${program.fixedAmount} is finer than payable precision — configure a payable figure; configured cash is never silently rounded`,
      );
    }
    const fixedMinor = fixedUnits / quantum;
    const recipients: IncentiveRecipientResult[] = [];
    for (const employmentId of [...eligible].sort()) {
      if (program.allocation === "hours") {
        const hours = shareById.get(employmentId)?.hours;
        if (hours === null || hours === undefined || toUnits(requireCanonicalDecimal(hours, "member hours")) <= 0n) {
          continue;
        }
      }
      const gross = fromMinor(fixedMinor);
      const capped = capMinor !== null && fixedMinor > capMinor;
      const value = fromMinor(capped ? capMinor! : fixedMinor);
      const span = describeShareSpan(shareById.get(employmentId));
      recipients.push({
        employmentId,
        share: "fixed",
        grossValue: gross,
        value,
        capped,
        explanation: `${employmentId}${span}: fixed ${gross}${capped ? ` capped to ${value}` : ""}`,
      });
    }
    if (recipients.length === 0) {
      throw new BenefitsError(
        "REFUSED",
        "no member holds the required evidence for this period (approved hours under an hours allocation) — record the time or widen the allocation before settling",
      );
    }
    const totalMinor = recipients.reduce((acc, r) => acc + toMinor(toUnits(r.value)), 0n);
    const total = fromMinor(totalMinor);
    assertBudget(program, total, summary);
    return {
      measuredValue, poolValue: "0.0000", thresholdMet: true, recipients,
      excludedZero: [], totalAwarded: total, undistributed: "0.0000", currency,
      summaryLines: [...summary, `${recipients.length} fixed award(s) of ${fromMinor(fixedMinor)} totalling ${total}${capMinor !== null ? ` (cap ${fromMinor(capMinor)} each)` : ""}`],
    };
  }

  // Percent and pool awards: size the pool in ledger units, round once to
  // payable precision (halves away from zero), then split exactly.
  let poolUnits4dp: bigint;
  if (valuation === "percent") {
    if (program.percentRate === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} values percent awards but names no percent rate — set the rate before settling`,
      );
    }
    const rate = requirePlainPercent(program.percentRate);
    poolUnits4dp = (measuredUnits * rate.units) / (100n * rate.scale);
    summary.push(`pool is ${program.percentRate}% of measured ${measuredValue} = ${fromUnits(poolUnits4dp)}`);
  } else {
    if (program.fixedAmount === null && program.budgetAmount === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} shares a pool but neither a fixed pool amount nor a budget sizes it — size the pool before settling`,
      );
    }
    poolUnits4dp = toUnits(requireCanonicalDecimal(
      (program.fixedAmount ?? program.budgetAmount)!, "pool amount",
    ));
    summary.push(`pool is fixed at ${fromUnits(poolUnits4dp)}`);
  }
  if (poolUnits4dp < 0n) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "the distributable pool is negative — losses are refused before they reach the split",
    );
  }
  const poolMinor = toMinor(poolUnits4dp);
  summary.push(`payable pool ${fromMinor(poolMinor)} in ${currency} payable units`);

  const weights = shares.map((s) => ({
    employmentId: s.employmentId,
    units: allocationWeightUnits(program.allocation, s),
  }));
  const parts = apportionExactUnits(poolMinor, weights);
  const denominator = weights.reduce((acc, w) => acc + w.units, 0n);
  const computed: IncentiveRecipientResult[] = [...eligible].sort().map((employmentId) => {
    const weight = weights.find((w) => w.employmentId === employmentId)!.units;
    const gross = parts.get(employmentId)!;
    const capped = capMinor !== null && gross > capMinor;
    const value = capped ? capMinor! : gross;
    const span = describeShareSpan(shareById.get(employmentId));
    return {
      employmentId,
      share: `${weight}/${denominator}`,
      grossValue: fromMinor(gross),
      value: fromMinor(value),
      capped,
      explanation:
        `${employmentId}${span}: share ${weight}/${denominator} of ${fromMinor(poolMinor)} = ${fromMinor(gross)}` +
        (capped ? ` capped to ${fromMinor(value)}` : ""),
    };
  });
  // Nonzero-only apportionment: shares that round to zero at payable
  // precision are named and excluded, never recorded — while the pool
  // still apportions exactly across the rest.
  const recipients = computed.filter((r) => toMinor(toUnits(r.value)) > 0n);
  const excludedZero = computed
    .filter((r) => toMinor(toUnits(r.value)) <= 0n)
    .map((r) => `${r.employmentId}: share ${r.share} rounds to zero at payable precision — excluded, never zero-awarded`);
  const totalMinor = recipients.reduce((acc, r) => acc + toMinor(toUnits(r.value)), 0n);
  const total = fromMinor(totalMinor);
  assertBudget(program, total, summary);
  const undistributed = fromMinor(poolMinor - totalMinor);
  return {
    measuredValue,
    poolValue: fromMinor(poolMinor),
    thresholdMet: true,
    recipients,
    excludedZero,
    totalAwarded: total,
    undistributed,
    currency,
    summaryLines: [
      ...summary,
      `${recipients.length} award(s) totalling ${total}` +
        (excludedZero.length > 0 ? `, ${excludedZero.length} share(s) rounded to zero and excluded by name` : "") +
        (toMinor(toUnits(undistributed)) > 0n ? `, ${undistributed} undistributed by caps (kept, never re-apportioned)` : ", fully apportioned to the payable unit"),
    ],
  };
}

/** Per-recipient membership and hours evidence appended to every explanation. */
function describeShareSpan(share: IncentiveMemberShare | undefined): string {
  if (!share) return "";
  const span = ` member ${share.effectiveFrom}..${share.effectiveTo ?? "open"}`;
  const hours = share.hours !== null && share.hours !== undefined ? `, ${share.hours} approved hours` : "";
  const role = share.weight !== null && share.weight !== undefined ? `, weight ${share.weight}` : "";
  return `${span}${hours}${role}`;
}

function requirePlainPercent(rate: string): { units: bigint; scale: bigint } {
  const canonical = canonicalDecimal(rate, 10);
  if (canonical === null) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `percent rate ${JSON.stringify(rate)} is not a plain percentage — record digits like "2.5" for two and a half percent, never symbols or fractions`,
    );
  }
  const [whole, fraction = ""] = canonical.split(".");
  const units = BigInt(`${whole}${fraction}`);
  if (units <= 0n) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `percent rate ${JSON.stringify(rate)} is not positive — a percent award must name a positive rate`,
    );
  }
  return { units, scale: 10n ** BigInt(fraction.length) };
}

/**
 * Allocation weight in integer units. Hours and role weights are exact
 * decimals scaled to 4dp; equal splits weight every member one. A missing
 * or non-positive weight is a named refusal — the layer never imputes
 * effort from job titles, departments, or pay grades.
 */
function allocationWeightUnits(allocation: BenefitAllocation, share: IncentiveMemberShare): bigint {
  switch (allocation) {
    case "equal":
      return 1n;
    case "hours": {
      if (share.hours === null || share.hours === undefined) {
        throw new BenefitsError(
          "REFUSED",
          `employment ${share.employmentId} has no approved-hours evidence for the period — approve the time or remove the member before settling; effort is never imputed`,
        );
      }
      const units = toUnitsSafe(share.hours, `approved hours for employment ${share.employmentId}`);
      if (units <= 0n) {
        throw new BenefitsError(
          "REFUSED",
          `employment ${share.employmentId} holds no approved hours in the period — a zero-hours member takes no share of an hours allocation`,
        );
      }
      return units;
    }
    case "role": {
      if (share.weight === null || share.weight === undefined) {
        throw new BenefitsError(
          "REFUSED",
          `employment ${share.employmentId} has no recorded membership weight for the period — record the role weight effective for the period; roles are never inferred from current job titles`,
        );
      }
      const units = toUnitsSafe(share.weight, `membership weight for employment ${share.employmentId}`);
      if (units <= 0n) {
        throw new BenefitsError(
          "REFUSED",
          `employment ${share.employmentId} carries a non-positive membership weight — record a positive weight or end the membership before settling`,
        );
      }
      return units;
    }
  }
}

function toUnitsSafe(value: string, label: string): bigint {
  try {
    return toUnits(requireCanonicalDecimal(value, label));
  } catch (error) {
    if (error instanceof BenefitsError) throw error;
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(value)} is not an exact decimal — record plain digits with at most 4 fraction digits`,
    );
  }
}

/** Budget is a hard ceiling on the payout: an overrun refuses with both figures. */
function assertBudget(program: BenefitProgram, total: string, summary: string[]): void {
  if (program.budgetAmount === null) return;
  const budget = requireCanonicalDecimal(program.budgetAmount, "budget amount");
  if (toUnits(total) > toUnits(budget)) {
    throw new BenefitsError(
      "REFUSED",
      `computed awards ${total} exceed the program budget ${budget} — raise the budget through a new program revision or narrow the settlement before awards exist`,
    );
  }
  summary.push(`within budget ${budget}`);
}
