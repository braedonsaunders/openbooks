import { sql, type SQL } from "drizzle-orm";
import type { db } from "../platform/db.ts";

type Runner = Pick<typeof db, "execute">;

/**
 * Shared direct-or-inverse spot candidate set for one currency pair: the
 * direct quotes plus the inverted reverse quotes, each tagged with its
 * precedence (direct 0 beats inverse 1). Both readers below build on this
 * fragment so the per-date precedence cannot drift between them.
 *
 * The fx_rates unique index on (org, pair, as_of, rate_type) allows at most
 * one stored row per direction per date, so the 0/1 priority fully determines
 * the per-date winner — no created_at/id tiebreak exists or is needed.
 */
function spotCandidates(orgId: string, from: string, to: string, dateCond: SQL): SQL {
  return sql`
    select as_of, rate, 0 as priority from fx_rates
     where org_id = ${orgId} and from_currency = ${from}
       and to_currency = ${to} and rate_type = 'spot'
       and ${dateCond}
    union all
    select as_of, (1 / rate)::numeric(19,10) as rate, 1 as priority from fx_rates
     where org_id = ${orgId} and from_currency = ${to}
       and to_currency = ${from} and rate_type = 'spot'
       and ${dateCond}`;
}

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
  const candidates = spotCandidates(orgId, from, to, sql`as_of <= ${asOf}`);
  const r = await runner.execute<{ rate: string }>(sql`
    select rate::text as rate from (${candidates}) candidates
     order by as_of desc, priority asc limit 1`);
  return r.rows[0]?.rate ?? null;
}

/**
 * Mean spot over a date window under the same direct-or-inverse doctrine:
 * ONE observation per as_of date contributes — the direct quote wins when a
 * date is quoted in both directions (same precedence as lookupSpotRate, via
 * the shared candidate fragment above), otherwise the inverted reverse
 * quote. Without the per-date collapse a date quoted both ways would count
 * twice and skew the mean toward itself. Null when the window holds no quote
 * in either direction (callers fall back to the closing spot, exactly as a
 * quote-free window did before).
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
  const candidates = spotCandidates(orgId, from, to, sql`as_of between ${fromDate} and ${toDate}`);
  const r = await runner.execute<{ average: string | null }>(sql`
    select avg(rate)::numeric(19,10)::text as average from (
      select distinct on (as_of) as_of, rate from (${candidates}) candidates
       order by as_of, priority asc
    ) per_date`);
  return r.rows[0]?.average ?? null;
}
