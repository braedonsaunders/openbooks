import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

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
