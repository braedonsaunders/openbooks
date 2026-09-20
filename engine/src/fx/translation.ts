import { sql } from 'drizzle-orm'
import { db } from '../platform/db.ts'
import { mulDecimal } from '../money/money.ts'

/**
 * Presentation-currency translation for consolidated engine readers.
 *
 * Mirrors the web `fx-presentation` doctrine (which engine code cannot
 * import): journal legs are stamped in their line entity's functional
 * currency and documents carry the txn→posting-functional first leg
 * (`d.fx_rate`). What readers miss is the SECOND leg,
 * functional→presentation (the org base currency):
 *
 * - Balances translate at the closing spot: the latest dated spot on or
 *   before the as-of date.
 * - Flows translate at the document-date spot, matching the first leg's
 *   timing.
 * - Single-functional scopes translate 1:1.
 * - Missing coverage fails closed (a clear error), never a silent mix —
 *   the same contract as the posting kernel's own lookup (direct-or-inverse
 *   spot, `rate_type = 'spot'`, direct wins ties).
 */

/** The org's base (functional) currency — the consolidated presentation currency. */
export async function presentationBaseCurrency(orgId: string): Promise<string> {
  const r = await db.execute(
    sql`select base_currency as "baseCurrency" from orgs where id = ${orgId}`,
  )
  const base = (r.rows[0] as { baseCurrency?: unknown } | undefined)?.baseCurrency
  if (typeof base !== 'string' || !base) {
    throw new Error(`organization ${orgId} has no base currency`)
  }
  return base
}

export interface FlowTranslation {
  base: string
  /** Latest dated spot for a functional on/before a date ("1" for the base). Throws when uncovered. */
  rateAt: (func: string | null, date: string) => string
}

/**
 * Rate timelines covering every (functional, date) in `rows` — one
 * timeline query per functional in view. Null functionals are root-owned
 * legs in org base and translate 1:1 without coverage.
 */
export async function flowTranslation(
  orgId: string,
  rows: ReadonlyArray<{ func: string | null; date: string }>,
): Promise<FlowTranslation> {
  if (rows.length === 0) {
    // No legs, no translation: the identity context without touching the
    // org/rate tables, so empty scopes stay query-free.
    return { base: '', rateAt: () => '1' }
  }
  const base = await presentationBaseCurrency(orgId)
  const dated = rows.filter((r) => (r.func ?? base) !== base)
  const timelines = new Map<string, { asOf: string; rate: string }[]>()
  if (dated.length > 0) {
    const maxDate = dated.reduce((a, b) => (a > b.date ? a : b.date), dated[0]!.date)
    const funcs = [...new Set(dated.map((r) => r.func as string))]
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
      `)
      // Direct quotes win ties (same rule as the kernel lookup): keep the
      // first row per date.
      const seen = new Set<string>()
      const timeline: { asOf: string; rate: string }[] = []
      for (const row of r.rows) {
        if (seen.has(row.as_of)) continue
        seen.add(row.as_of)
        timeline.push({ asOf: row.as_of, rate: row.rate })
      }
      timelines.set(func, timeline)
    }
  }
  return {
    base,
    rateAt: (func, date) => {
      const resolved = func ?? base
      if (resolved === base) return '1'
      const rate = timelines.get(resolved)!.find((t) => t.asOf <= date)?.rate
      if (!rate) {
        throw new Error(
          `no spot rate for ${resolved}→${base} on or before ${date}`,
        )
      }
      return rate
    },
  }
}

/**
 * Translate one consolidated leg to presentation, skipping the rate lookup
 * for zero money so an empty window never demands coverage. Nonzero money
 * without coverage still fails closed in rateAt.
 */
export function translateFlowAmount(
  amountValue: string,
  func: string | null,
  date: string,
  rateAt: (func: string | null, date: string) => string,
): string {
  return Number(amountValue) === 0 ? '0' : mulDecimal(amountValue, rateAt(func, date))
}
