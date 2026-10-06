import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { analyticsQuery } from "./analytics/query";
import { add, mulDecimal } from "@openbooks/engine/money";

/**
 * Presentation-currency translation for consolidated operational reads
 * (cockpits, tiles, analytics loaders, cash primitives).
 *
 * Doctrine: the presentation currency of a consolidated view
 * is the reporting subsidiary's functional currency — the org base for root
 * views. Journal legs are already stamped in their line entity's functional
 * currency (`jl.amount`; `jl.currency` describes `txn_amount`), and documents
 * carry the txn→posting-functional first leg (`d.fx_rate`). What every reader
 * was missing is the SECOND leg: functional→presentation.
 *
 * - Balances (AR/AP/cash/registers) translate at the closing spot: the latest
 *   dated spot on or before the as-of date.
 * - Flows (spend/revenue/pipeline/commitments) translate at the document-date
 *   spot, matching the first leg's timing.
 * - Single-functional orgs translate 1:1, so the landed document-FX fixes
 *   stay exactly correct.
 * - Missing coverage fails closed (a clear error), never a silent mix — the
 *   same contract as the posting kernel's own lookup, mirrored here
 *   (direct-or-inverse spot, `rate_type = 'spot'`, direct wins ties).
 *
 * Formal statements keep the matrix (`statement-matrix.ts`), which translates
 * flow at average / balance at current / equity at historical per period.
 */

/** The org's base (functional) currency — the consolidated presentation currency. */
export async function presentationCurrency(orgId: string): Promise<string> {
  const r = await analyticsQuery(
    sql`select base_currency as "baseCurrency" from orgs where id = ${orgId}`,
  );
  const base = r.rows[0]?.baseCurrency;
  if (typeof base !== "string" || !base) {
    throw new Error(`organization ${orgId} has no base currency`);
  }
  return base;
}

/** Functional currency of a journal line's entity; null (root-owned) lines read the org base. */
export function lineFunctional(
  subsidiaryBase: string | null,
  orgBase: string,
): string {
  return subsidiaryBase ?? orgBase;
}

/** Shared direct-or-inverse closing spot selection. Direct rates win ties;
 * callers supply the needed currencies as a SQL relation with a ccy column. */
export function presentationSpotRatesSql(orgId: string, base: string, currencies: SQL, refDate: string): SQL {
  return sql`
    select distinct on (s.from_currency) s.from_currency, s.rate::text as rate
      from (
        select from_currency, rate, as_of, 0 as priority from fx_rates
         where org_id = ${orgId} and from_currency in (select ccy from (${currencies}) needed)
           and to_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
        union all
        select to_currency as from_currency, (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
         where org_id = ${orgId} and to_currency in (select ccy from (${currencies}) needed)
           and from_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
      ) s
     order by s.from_currency, s.as_of desc, s.priority asc
  `;
}

/** Exact four-decimal ledger conversion, equivalent to money.mulDecimal:
 * PostgreSQL numeric round and the bigint kernel both round halves away from zero. */
export function presentationAmountSql(amount: SQL, currency: SQL, target: string, rate: SQL): SQL {
  return sql`case when ${currency} = ${target} then ${amount} else round((${amount}) * (${rate}), 4) end`;
}

/**
 * Latest dated spot rate per requested functional currency → presentation
 * base, on or before `refDate`. Same-currency legs resolve to "1" with no
 * rate row. Throws when any needed pair has no coverage.
 */
export async function presentationRates(
  orgId: string,
  base: string,
  froms: Iterable<string | null>,
  refDate: string,
): Promise<Map<string, string>> {
  const needed = [...new Set([...froms].map((c) => c ?? base))].filter(
    (c) => c !== base,
  );
  const rates = new Map<string, string>([[base, "1"]]);
  if (needed.length === 0) return rates;
  const list = `{${needed.join(",")}}`;
  const r = await analyticsQuery<{ from_currency: string; rate: string }>(
    presentationSpotRatesSql(orgId, base, sql`select unnest(${list}::text[]) as ccy`, refDate),
  );
  for (const row of r.rows) rates.set(row.from_currency, row.rate);
  const missing = needed.filter((c) => !rates.has(c));
  if (missing.length > 0) {
    // One typed refusal for the cash tiles and forecast readers to catch
    // exactly; every missing currency is named, never just the first.
    throw new MissingExchangeRateError(missing[0]!, base, refDate, missing);
  }
  return rates;
}

/**
 * Translate dated functional subtotal rows (flows: spend, revenue, payments,
 * trends) to presentation and sum. Each row translates at the document-date
 * spot — the flow doctrine's counterpart to the balance closing spot — so a
 * 30-day window spanning a rate move translates each day through its own
 * rate. One batched rate-timeline query for all functionals in view; missing coverage
 * fails closed. Amounts must already carry their first leg (e.g. documents
 * at `total * fx_rate`); `func` is the posting subsidiary's functional
 * currency (null = root = base).
 */
export interface FlowRates {
  base: string;
  /** Latest dated spot for a functional on/before a date ("1" for the base). Throws when uncovered. */
  rateAt: (func: string | null, date: string) => string;
}

export class MissingExchangeRateError extends Error {
  readonly status = 422
  /** First missing functional — the structured readers key on this. */
  readonly func: string
  /** Every missing functional — the message names them all, never just the first. */
  readonly funcs: string[]
  readonly base: string
  readonly date: string

  constructor(func: string, base: string, date: string, funcs?: string[]) {
    const all = funcs?.length ? [...new Set(funcs)] : [func]
    super(
      all.length === 1
        ? `no spot rate for ${all[0]}→${base} on or before ${date} — add it at Setup → Exchange Rates`
        : `no spot rates for ${all.map((f) => `${f}→${base}`).join(', ')} on or before ${date} — add them at Setup → Exchange Rates`,
    )
    this.name = 'MissingExchangeRateError'
    this.func = all[0]!
    this.funcs = all
    this.base = base
    this.date = date
  }
}

/**
 * Rate timelines covering every (functional, date) in `rows` — one
 * batched query for all requested functionals. Callers translating several buckets
 * (trend weeks) share the one context; `translateFlows` covers single totals.
 */
export async function flowRates(
  orgId: string,
  rows: ReadonlyArray<{ func: string | null; date: string }>,
): Promise<FlowRates> {
  if (rows.length === 0) {
    // No legs, no translation: the identity context without touching the
    // org/rate tables, so empty scopes stay query-free (and never demand a
    // base currency for nothing). rateAt is unreachable with no legs; base
    // is unset because no caller reads it on an empty context.
    return { base: "", rateAt: () => "1" };
  }
  const base = await presentationCurrency(orgId);
  const dated = rows.filter((r) => lineFunctional(r.func, base) !== base);
  const timelines = new Map<string, { asOf: string; rate: string }[]>();
  if (dated.length > 0) {
    const maxDate = dated.reduce((a, b) => (a > b.date ? a : b.date), dated[0]!.date);
    const minDate = dated.reduce((a, b) => (a < b.date ? a : b.date), dated[0]!.date);
    const funcs = [...new Set(dated.map((r) => lineFunctional(r.func, base)))].sort();
    const list = `{${funcs.join(",")}}`;
    // Only requested-date coverage plus the preceding quote travels from
    // PostgreSQL. Old rate history cannot amplify every card or tab payload.
    const result = await analyticsQuery<{ func: string; as_of: string; rate: string }>(sql`
      with needed as (select unnest(${list}::text[]) as func), quotes as (
        select from_currency as func, as_of, rate, 0 as priority from fx_rates
        where org_id = ${orgId} and from_currency = any(${list}::text[])
          and to_currency = ${base} and rate_type = 'spot'
          and as_of >= ${minDate}::date and as_of <= ${maxDate}::date
        union all
        select to_currency as func, as_of, (1 / rate)::numeric(19,10) as rate, 1 as priority from fx_rates
        where org_id = ${orgId} and to_currency = any(${list}::text[])
          and from_currency = ${base} and rate_type = 'spot'
          and as_of >= ${minDate}::date and as_of <= ${maxDate}::date
        union all
        select n.func, prior.as_of, prior.rate, prior.priority from needed n
        cross join lateral (
          select * from (
            (select as_of, rate, 0 as priority from fx_rates
             where org_id = ${orgId} and from_currency = n.func and to_currency = ${base}
               and rate_type = 'spot' and as_of < ${minDate}::date order by as_of desc limit 1)
            union all
            (select as_of, (1 / rate)::numeric(19,10) as rate, 1 as priority from fx_rates
             where org_id = ${orgId} and from_currency = ${base} and to_currency = n.func
               and rate_type = 'spot' and as_of < ${minDate}::date order by as_of desc limit 1)
          ) candidates order by as_of desc, priority asc limit 1
        ) prior
      )
      select distinct on (func, as_of) func, as_of::text as as_of, rate::text as rate
      from quotes order by func, as_of desc, priority asc
    `);
    for (const func of funcs) timelines.set(func, []);
    for (const row of result.rows) timelines.get(row.func)!.push({ asOf: row.as_of, rate: row.rate });
  }

  return {
    base,
    rateAt: (func, date) => {
      const resolved = lineFunctional(func, base);
      if (resolved === base) return "1";
      const rate = flowRateOnOrBefore(timelines.get(resolved) ?? [], date);
      if (!rate) {
        throw new MissingExchangeRateError(resolved, base, date)
      }
      return rate;
    },
  };
}

/** Descending, date-unique spot timelines use logarithmic dated lookup.
 * The SQL reader preserves the direct-quote tie rule before this lookup. */
export function flowRateOnOrBefore(timeline: readonly { asOf: string; rate: string }[], date: string): string | undefined {
  let first = 0, last = timeline.length;
  while (first < last) {
    const middle = first + Math.floor((last - first) / 2);
    if (timeline[middle]!.asOf > date) first = middle + 1;
    else last = middle;
  }
  return timeline[first]?.rate;
}

export async function translateFlows(
  orgId: string,
  rows: ReadonlyArray<{ func: string | null; date: string; amount: string }>,
): Promise<string> {
  const ctx = await flowRates(orgId, rows);
  let total = "0";
  for (const r of rows) {
    total = add(total, mulDecimal(r.amount, ctx.rateAt(r.func, r.date)));
  }
  return total;
}
