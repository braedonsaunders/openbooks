import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";

type Runner = Pick<typeof db, "execute">;

/**
 * Spot-rate lookup shared by the posting kernel, period-close derivation and
 * statement translation (direct-or-inverse, `rate_type = 'spot'`).
 *
 * When the direct pair and an inverted quote share the newest as_of, the
 * DIRECT row wins (priority 0 beats 1): provider syncs write every directed
 * pair per date, and double rounding can separate the candidates by a unit,
 * so one pair/date must always convert alike. Returns null when the pair is
 * uncovered on/before the date — callers fail closed with their own refusal,
 * never a silent mix or a defaulted 1.
 */
export async function lookupSpotRate(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  asOf: string,
): Promise<string | null> {
  if (from === to) return "1";
  const r = await runner.execute<{ rate: string }>(sql`
    select rate::text as rate from (
      select rate, as_of, 0 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${from}
         and to_currency = ${to} and rate_type = 'spot'
         and as_of <= ${asOf}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${to}
         and to_currency = ${from} and rate_type = 'spot'
         and as_of <= ${asOf}
    ) candidates order by as_of desc, priority asc limit 1`);
  return r.rows[0]?.rate ?? null;
}

/**
 * Mean spot over a date window under the same direct-or-inverse doctrine:
 * every quote in the window contributes, inverted when stored backwards.
 * Null when the window holds no quote in either direction (callers fall back
 * to the closing spot, exactly as a quote-free window did before).
 */
export async function averageSpotRate(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  fromDate: string,
  toDate: string,
): Promise<string | null> {
  if (from === to) return "1";
  const r = await runner.execute<{ average: string | null }>(sql`
    select avg(rate)::numeric(19,10)::text as average from (
      select rate from fx_rates
       where org_id = ${orgId} and from_currency = ${from}
         and to_currency = ${to} and rate_type = 'spot'
         and as_of between ${fromDate} and ${toDate}
      union all
      select (1 / rate)::numeric(19,10) as rate from fx_rates
       where org_id = ${orgId} and from_currency = ${to}
         and to_currency = ${from} and rate_type = 'spot'
         and as_of between ${fromDate} and ${toDate}
    ) quotes`);
  return r.rows[0]?.average ?? null;
}
