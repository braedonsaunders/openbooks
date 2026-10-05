import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { calendarDaysBetween } from "../platform/civil-date.ts";
import { averageSpotRateWindow, lookupSpotRateWithEvidence } from "./spot-rate.ts";

type Runner = Pick<typeof db, "execute">;

/**
 * How old an exchange rate may be when a period is priced with it.
 *
 * Spot lookups take the newest quote on or before a date, so a rate feed that
 * stopped in March would otherwise price a December close. FX revaluation and
 * consolidation translation therefore check the age of the rate they would
 * use against an effective-dated organization limit per rate kind:
 *
 * - `closing`: the period-end spot rate (revaluation and the consolidated
 *   current rate); its age is the period end less the quote date.
 * - `average`: the period-average rate; its age is the period end less the
 *   date of the newest quote averaged, so a feed that stopped early in the
 *   period does not pass as a period average.
 *
 * The limit in force is the `fx_rate_age_policies` row with the latest
 * effective date on or before the period end, else the documented default
 * below — the same figure Setup shows. Same-currency pairs are exact par and
 * have no age.
 */
export const FX_RATE_AGE_KINDS = ["closing", "average"] as const;
export type FxRateAgeKind = (typeof FX_RATE_AGE_KINDS)[number];

/**
 * The limit when an organization has set none: long enough for rates entered
 * once a month, short enough that a stopped feed is refused within a period.
 * Setup states this figure; change both together.
 */
export const FX_RATE_AGE_DEFAULT_DAYS = 31;

export interface FxRateAgeLimit {
  kind: FxRateAgeKind;
  maxAgeDays: number;
  /** Effective date of the governing policy row; null for the default. */
  effectiveFrom: string | null;
}

export async function resolveFxRateAgeLimit(
  runner: Runner,
  orgId: string,
  kind: FxRateAgeKind,
  asOf: string,
): Promise<FxRateAgeLimit> {
  const row = (await runner.execute<{ max_age_days: number; effective_from: string }>(sql`
    select max_age_days, effective_from::text as effective_from
      from fx_rate_age_policies
     where org_id = ${orgId} and rate_kind = ${kind} and effective_from <= ${asOf}
     order by effective_from desc
     limit 1`)).rows[0];
  return row
    ? { kind, maxAgeDays: Number(row.max_age_days), effectiveFrom: row.effective_from }
    : { kind, maxAgeDays: FX_RATE_AGE_DEFAULT_DAYS, effectiveFrom: null };
}

/**
 * The refusal for a rate older than its limit, or null. Pure: names the pair,
 * the rate's date, its age, the limit and where it came from, and both
 * remedies — refresh the rate, or change the limit.
 */
export function fxRateAgeRefusal(input: {
  from: string;
  to: string;
  rateDate: string;
  asOf: string;
  limit: FxRateAgeLimit;
}): string | null {
  const { from, to, rateDate, asOf, limit } = input;
  const age = calendarDaysBetween(rateDate, asOf);
  if (age <= limit.maxAgeDays) return null;
  const subject = limit.kind === "closing"
    ? `the newest ${from}→${to} spot rate on or before ${asOf}`
    : `the newest ${from}→${to} spot rate averaged into the period ending ${asOf}`;
  const source = limit.effectiveFrom
    ? `the ${limit.kind} rate age policy effective ${limit.effectiveFrom}`
    : "the default when no policy is set";
  return `${subject} is dated ${rateDate}, ${age} days old, beyond the ${limit.maxAgeDays}-day limit for ${limit.kind} `
    + `rates (${source}). Enter or refresh the ${from}→${to} rate in Setup → Exchange Rates, or change the limit `
    + "in Setup → FX Rate Age Policies.";
}

export interface FxPolicedRate {
  /** The rate, or null when the pair has no usable quote. */
  rate: string | null;
  /** Why the rate cannot be used; set exactly when a quote exists but is too old. */
  refusal: string | null;
}

/** The period-end spot rate under the closing-rate age limit. */
export async function closingSpotRateWithinAgeLimit(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  asOf: string,
): Promise<FxPolicedRate> {
  const evidence = await lookupSpotRateWithEvidence(runner, orgId, from, to, asOf);
  const quote = evidence.observations[0];
  if (evidence.rate === null || !quote) return { rate: evidence.rate, refusal: null };
  const limit = await resolveFxRateAgeLimit(runner, orgId, "closing", asOf);
  const refusal = fxRateAgeRefusal({ from, to, rateDate: quote.asOf, asOf, limit });
  return refusal ? { rate: null, refusal } : { rate: evidence.rate, refusal: null };
}

/** The window-average spot rate under the average-rate age limit. */
export async function averageSpotRateWithinAgeLimit(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  fromDate: string,
  toDate: string,
): Promise<FxPolicedRate> {
  const window = await averageSpotRateWindow(runner, orgId, from, to, fromDate, toDate);
  if (window.rate === null || window.newestAsOf === null) return { rate: window.rate, refusal: null };
  const limit = await resolveFxRateAgeLimit(runner, orgId, "average", toDate);
  const refusal = fxRateAgeRefusal({ from, to, rateDate: window.newestAsOf, asOf: toDate, limit });
  return refusal ? { rate: null, refusal } : { rate: window.rate, refusal: null };
}
