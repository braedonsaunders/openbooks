import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { add, mulDecimal } from "@openbooks/engine/src/money.ts";

/**
 * Presentation-currency translation for consolidated operational reads
 * (cockpits, tiles, analytics loaders, cash primitives).
 *
 * Doctrine (fleet-3 wave 2): the presentation currency of a consolidated view
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
  const r = await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${orgId}`,
  );
  const base = r.rows[0]?.base_currency;
  if (!base) throw new Error(`organization ${orgId} has no base currency`);
  return base;
}

/** Functional currency of a journal line's entity; null (root-owned) lines read the org base. */
export function lineFunctional(
  subsidiaryBase: string | null,
  orgBase: string,
): string {
  return subsidiaryBase ?? orgBase;
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
  const r = await db.execute<{ from_currency: string; rate: string }>(sql`
    select distinct on (s.from_currency) s.from_currency, s.rate::text as rate
      from (
        select from_currency, rate, as_of, 0 as priority from fx_rates
         where org_id = ${orgId} and from_currency = any(${list}::text[])
           and to_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
        union all
        select to_currency as from_currency, (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
         where org_id = ${orgId} and to_currency = any(${list}::text[])
           and from_currency = ${base} and rate_type = 'spot'
           and as_of <= ${refDate}::date
      ) s
     order by s.from_currency, s.as_of desc, s.priority asc
  `);
  for (const row of r.rows) rates.set(row.from_currency, row.rate);
  const missing = needed.filter((c) => !rates.has(c));
  if (missing.length > 0) {
    throw new Error(
      `no spot rate for ${missing.join(", ")}→${base} on or before ${refDate}`,
    );
  }
  return rates;
}

/**
 * Translate dated functional subtotal rows (flows: spend, revenue, payments,
 * trends) to presentation and sum. Each row translates at the document-date
 * spot — the flow doctrine's counterpart to the balance closing spot — so a
 * 30-day window spanning a rate move translates each day through its own
 * rate. One rate-timeline query per functional in view; missing coverage
 * fails closed. Amounts must already carry their first leg (e.g. documents
 * at `total * fx_rate`); `func` is the posting subsidiary's functional
 * currency (null = root = base).
 */
export interface FlowRates {
  base: string;
  /** Latest dated spot for a functional on/before a date ("1" for the base). Throws when uncovered. */
  rateAt: (func: string | null, date: string) => string;
}

/**
 * Rate timelines covering every (functional, date) in `rows` — one
 * timeline query per functional in view. Callers translating several buckets
 * (trend weeks) share the one context; `translateFlows` covers single totals.
 */
export async function flowRates(
  orgId: string,
  rows: ReadonlyArray<{ func: string | null; date: string }>,
): Promise<FlowRates> {
  const base = await presentationCurrency(orgId);
  const dated = rows.filter((r) => lineFunctional(r.func, base) !== base);
  const timelines = new Map<string, { asOf: string; rate: string }[]>();
  if (dated.length > 0) {
    const maxDate = dated.reduce((a, b) => (a > b.date ? a : b.date), dated[0]!.date);
    const funcs = [...new Set(dated.map((r) => lineFunctional(r.func, base)))];
    for (const func of funcs) {
      const r = await db.execute<{ as_of: string; rate: string }>(sql`
        select s.as_of::text as as_of, s.rate::text as rate from (
          select as_of, rate, 0 as priority from fx_rates
           where org_id = ${orgId} and from_currency = ${func}
             and to_currency = ${base} and rate_type = 'spot'
             and as_of <= ${maxDate}::date
          union all
          select as_of, (1 / rate)::numeric(19,10) as rate, 1 as priority from fx_rates
           where org_id = ${orgId} and from_currency = ${base}
             and to_currency = ${func} and rate_type = 'spot'
             and as_of <= ${maxDate}::date
        ) s
       order by s.as_of desc, s.priority asc
      `);
      // Direct quotes win ties (same rule as the kernel lookup): keep the
      // first row per date.
      const seen = new Set<string>();
      const timeline: { asOf: string; rate: string }[] = [];
      for (const row of r.rows) {
        if (seen.has(row.as_of)) continue;
        seen.add(row.as_of);
        timeline.push({ asOf: row.as_of, rate: row.rate });
      }
      timelines.set(func, timeline);
    }
  }
  return {
    base,
    rateAt: (func, date) => {
      const resolved = lineFunctional(func, base);
      if (resolved === base) return "1";
      const rate = timelines.get(resolved)!.find((t) => t.asOf <= date)?.rate;
      if (!rate) {
        throw new Error(
          `no spot rate for ${resolved}→${base} on or before ${date}`,
        );
      }
      return rate;
    },
  };
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
