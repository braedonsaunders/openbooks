import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { add, mulDecimal } from "@openbooks/engine/src/money.ts";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { flowRates } from "../fx-presentation";

/**
 * Canonical operating-expense definition (F-t09-001).
 *
 * Spend Velocity and Financial Health used the identical label
 * "Operating expenses … of revenue" for two different numerators: the
 * spend-document universe (expense/COGS lines from bills, expense reports,
 * checks net of credits — which mixes in COGS and misses every non-spend
 * journal such as depreciation) versus true P&L operating expenses. Both
 * readers now share this definition: debit-positive `expense` +
 * `expense_deferred` over every posted statement-book line, exactly the
 * split the P&L report and Budget vs Actual use. `cogs` and
 * `expense_other` are never operating expenses.
 */
export const OPERATING_EXPENSE_TYPES = ["expense", "expense_deferred"] as const;

/** Revenue side of the ratio: operating + other income, as the P&L reads it. */
export const OPEX_RATIO_REVENUE_TYPES = ["income", "income_other"] as const;

/** Whole-percent operating-expenses-to-revenue ratio; 0 when revenue is not positive. */
export function operatingExpenseRatio(opex: number, revenue: number): number {
  return revenue > 0 ? Math.round((opex / revenue) * 100) : 0;
}

interface OpexRevenueRow extends Record<string, unknown> {
  opex: string | number | null;
  revenue: string | number | null;
  func: string | null;
  late: string | null;
}

/**
 * One reader for period P&L operating expenses and revenue. Every leg
 * translates at its latest posting date into presentation currency (the same
 * basis as the spend-velocity revenue normalisation and the health monthly
 * series), so both dashboards report the same ratio. Missing FX coverage
 * fails closed via flowRates.
 */
export async function periodOperatingExpenses(
  orgId: string,
  from: string,
  to: string,
  allowed: ReadonlySet<string> | null,
): Promise<{ opex: number; revenue: number }> {
  const opexTypes = sql.join(
    OPERATING_EXPENSE_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const revenueTypes = sql.join(
    OPEX_RATIO_REVENUE_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const r = await db.execute<OpexRevenueRow>(sql`
    select sum(case when a.type in (${opexTypes}) then l.amount else 0 end) as opex,
      -sum(case when a.type in (${revenueTypes}) then l.amount else 0 end) as revenue,
      sub.base_currency as func,
      max(e.posting_date)::text as late
    from journal_lines l
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    where l.org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
      and e.posting_date >= ${from} and e.posting_date <= ${to}
    group by sub.base_currency
  `);
  const ctx = await flowRates(
    orgId,
    r.rows.map((row) => ({ func: row.func ?? null, date: String(row.late ?? to).slice(0, 10) })),
  );
  let opex = "0";
  let revenue = "0";
  for (const row of r.rows) {
    const date = String(row.late ?? to).slice(0, 10);
    opex = add(opex, mulDecimal(String(row.opex ?? 0), ctx.rateAt(row.func ?? null, date)));
    revenue = add(revenue, mulDecimal(String(row.revenue ?? 0), ctx.rateAt(row.func ?? null, date)));
  }
  return { opex: Number(opex), revenue: Number(revenue) };
}
