import { sql } from "drizzle-orm";
import { resolveCoveringPeriod } from "../close/period-resolution.ts";
import type { db } from "../platform/db.ts";
import type { AllocationDriverAsOf, DriverAsOf } from "./types.ts";

/**
 * The period a driver vintage is measured against: the runner's own shape,
 * so both callers speak calendar dates, never period ids they do not hold.
 */
export interface DriverVintagePeriod {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

/**
 * What a version's driver_as_of vintage means, resolved identically for the
 * period runner and at-posting document contributions:
 *
 * - `prior_period`: the latest non-adjustment period ending before the
 *   reference period starts;
 * - `document_date`: the document's own date at posting; the run period's
 *   end date in a period sweep, which has no document;
 * - anything else (`period`): the reference period itself.
 *
 * The reference period is the period the allocation lands in: the sweep's
 * period for a period run, the posting period for a document contribution.
 * A vintage with no honest window (no prior period, no covering posting
 * period) is a refusal, never a silent live-vector measure. Callers throw
 * their own error class around the refusal so every boundary keeps its
 * named status.
 */
export async function resolveDriverVintage(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  driverAsOf: AllocationDriverAsOf,
  ref:
    | { kind: "period"; period: DriverVintagePeriod }
    | { kind: "posting"; postingDate: string; documentDate: string },
): Promise<{ asOf: DriverAsOf } | { refusal: string }> {
  if (driverAsOf === "document_date") {
    return { asOf: { date: ref.kind === "posting" ? ref.documentDate : ref.period.endsOn } };
  }
  let period: DriverVintagePeriod | null = null;
  if (ref.kind === "period") {
    period = ref.period;
  } else {
    const covering = await resolveCoveringPeriod(runner, orgId, ref.postingDate);
    period = covering
      ? { id: covering.id, name: covering.name, startsOn: covering.starts_on, endsOn: covering.ends_on }
      : null;
  }
  if (!period) {
    return { refusal: `no accounting period covers the posting date for driver lookback` };
  }
  if (driverAsOf === "prior_period") {
    const prior = (
      await runner.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and not is_adjustment and ends_on < ${period.startsOn}
       order by ends_on desc limit 1`)
    ).rows[0];
    if (!prior) return { refusal: `no prior period exists for driver lookback on ${period.name}` };
    return { asOf: { periodId: prior.id } };
  }
  return { asOf: { periodId: period.id } };
}
