import { add, cmp, neg } from "../money/money.ts";
import { refuse } from "./asset-refusal.ts";
import { daysBetween } from "./maintenance-math.ts";

/**
 * Pure insurance rules: the renewal alert ladder for a policy and how an
 * asset's insured value compares with its net book value.
 */

/** The policy's own lead time, then one week, then the expiry day itself. */
export function renewalLadder(renewalLeadDays: number): number[] {
  if (!Number.isInteger(renewalLeadDays) || renewalLeadDays < 0 || renewalLeadDays > 365) {
    refuse("lead_days_invalid", "renewal lead days must be a whole number from 0 to 365");
  }
  return [...new Set([renewalLeadDays, 7, 0].filter((days) => days <= renewalLeadDays))].sort(
    (a, b) => b - a,
  );
}

/**
 * Lead times on the ladder that have been reached by `today`. A missed scan
 * catches up: every reached rung is returned, the most urgent last.
 */
export function reachedRenewalLeads(
  today: string,
  coverageEndsOn: string,
  renewalLeadDays: number,
): number[] {
  const remaining = daysBetween(today, coverageEndsOn);
  return renewalLadder(renewalLeadDays).filter((lead) => remaining <= lead);
}

export function assertCoveragePeriod(startsOn: string, endsOn: string): void {
  if (daysBetween(startsOn, endsOn) < 0)
    refuse("coverage_period_invalid", "coverage must end on or after it starts");
}

export type InsuranceStanding = "underinsured" | "matched" | "overinsured";

/** Insured value against net book value: the gap is insured − NBV. */
export function insuredValueStanding(
  insuredValue: string,
  netBookValue: string,
): { gap: string; standing: InsuranceStanding } {
  const gap = add(insuredValue, neg(netBookValue));
  const compared = cmp(insuredValue, netBookValue);
  return {
    gap,
    standing: compared < 0 ? "underinsured" : compared > 0 ? "overinsured" : "matched",
  };
}
