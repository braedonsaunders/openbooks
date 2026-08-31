import "server-only";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { glActivityBuckets, glSummaryEligibleDims, bucketSubsidiaryFilter, statementBookExpr } from "../gl-summary";
import { resolveOrgId } from "../org-scope";
import { decimalAdd, decimalIsMaterial, decimalNeg, decimalSum, type ExactDecimal } from "../statement-format";
import { ZERO, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";

/**
 * Financial statement queries. Sign convention: journal amounts are
 * debit-positive. Income/liability/equity present naturally as credits, so
 * statement values flip sign where the reader expects positive numbers.
 */
export interface StatementRow {
  id: string;
  number: string | null;
  name: string;
  type: string;
  balance: ExactDecimal; // reader-signed (revenue positive, expense positive)
  depth: number;
  isSummary: boolean;
}

export const PNL_TYPES = ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"];
export const CREDIT_NORMAL = new Set([
  "income", "income_other",
  "liability_payable", "liability_card", "liability_current_other", "liability_long_term",
  "equity",
]);

async function accountBalances(where: ReturnType<typeof sql>, dims?: DimFilter, orgId?: string, bookId?: string | null) {
  const resolvedOrgId = await resolveOrgId(orgId);
  // The qualifying entry set (org + status + the caller's e.* predicates,
  // which reference only e.posting_date / e.org_id) materializes once via an
  // index-only scan and hash-joins to the lines. The predicates MUST live
  // inside the CTE: applied at the outer join they leave the CTE unfiltered
  // and the planner falls back to a per-account nested loop over it. The old
  // per-line join to journal_entries re-fetched the entry heap for every
  // journal line in the tenant. Statements answer for one accounting book —
  // entries are book-mandatory and an unscoped read would fuse parallel books.
  const r = (await db.execute(sql`
    with e as materialized (
      select e.id from journal_entries e
       where e.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed') and ${where}
         and e.book_id = ${statementBookExpr(resolvedOrgId, bookId)}
    )
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary,
           coalesce(sum(l.amount), 0) as raw
      from accounts a
      left join (journal_lines l join e on e.id = l.entry_id)
        on l.account_id = a.id and l.org_id = ${resolvedOrgId} and ${dimWhere(dims)}
     where a.org_id = ${resolvedOrgId}
     group by a.id
     order by a.number nulls last, a.name
  `));
  return r.rows as {
    id: string; parent_id: string | null; number: string | null; name: string;
    type: string; is_summary: boolean; raw: string;
  }[];
}

/** Roll child balances into parents, return tree-ordered rows with depth. */
function treeify(rows: Awaited<ReturnType<typeof accountBalances>>, types: string[]): StatementRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rolled = new Map<string, ExactDecimal>(rows.map((r) => [r.id, r.raw]));
  for (const r of rows) {
    let p = r.parent_id;
    while (p) {
      rolled.set(p, decimalAdd(rolled.get(p) ?? ZERO, r.raw));
      p = byId.get(p)?.parent_id ?? null;
    }
  }
  const children = new Map<string | null, typeof rows>();
  for (const r of rows) {
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id)!.push(r);
  }
  const out: StatementRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (!types.includes(r.type)) continue;
      const bal = rolled.get(r.id) ?? ZERO;
      const signed = CREDIT_NORMAL.has(r.type) ? decimalNeg(bal) : bal;
      if (decimalIsMaterial(signed) || r.is_summary) {
        out.push({
          id: r.id, number: r.number, name: r.name, type: r.type,
          balance: signed, depth, isSummary: r.is_summary,
        });
      }
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  // prune empty summary rows (no visible descendants, zero balance)
  return out.filter((r, i) => {
    if (!r.isSummary || decimalIsMaterial(r.balance)) return true;
    const next = out[i + 1];
    return next !== undefined && next.depth > r.depth;
  });
}

/**
 * accountBalances answered from the gl_month_activity summary — same row
 * shape, whole months from the aggregate, split boundary months from lines.
 */
async function summaryAccountBalances(orgId: string, from: string | null, to: string, subsidiaryIds?: string[], bookId?: string | null) {
  const buckets = glActivityBuckets(orgId, {
    minDate: from,
    maxDate: to,
    boundaries: [],
    bookId,
  });
  // Split boundary months come back as individual lines for the whole month;
  // the bucket date is therefore the authoritative inclusive report window.
  const dateFilter = from === null
    ? sql`b.d <= ${to}`
    : sql`b.d >= ${from} and b.d <= ${to}`;
  // Aggregate the buckets FIRST, then join accounts to the tiny per-account
  // result — joining accounts against the raw union invites a plan that
  // re-executes the union once per account.
  const r = (await db.execute(sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary,
           coalesce(s.raw, 0) as raw
      from accounts a
      left join (
        select b.account_id, sum(b.amount) as raw
          from ${buckets} b
         where ${dateFilter} ${bucketSubsidiaryFilter(subsidiaryIds)}
         group by b.account_id
      ) s on s.account_id = a.id
     where a.org_id = ${orgId}
     order by a.number nulls last, a.name
  `));
  return r.rows as Awaited<ReturnType<typeof accountBalances>>;
}

export async function profitAndLoss(from: string, to: string, dims?: DimFilter, orgId?: string, bookId?: string | null) {
  const resolvedOrgId = await resolveOrgId(orgId);
  const rows = glSummaryEligibleDims(dims)
    ? await summaryAccountBalances(resolvedOrgId, from, to, dims?.subsidiaryIds, bookId)
    : await accountBalances(
        sql`e.posting_date >= ${from} and e.posting_date <= ${to} and e.org_id = ${resolvedOrgId}`,
        dims,
        resolvedOrgId,
        bookId,
      );
  const items = treeify(rows, PNL_TYPES);
  const total = (types: string[]) =>
    decimalSum(items.filter((r) => types.includes(r.type) && r.depth === 0).map((r) => r.balance));
  const revenue = total(["income", "income_other"]);
  const cogs = total(["cogs"]);
  const expenses = total(["expense", "expense_other", "expense_deferred"]);
  const grossProfit = decimalSubtract(revenue, cogs);
  return { items, revenue, cogs, grossProfit, expenses, netIncome: decimalSubtract(grossProfit, expenses) };
}

/**
 * Balance sheet through an inclusive date. The dimensions argument is kept at
 * the end for backwards compatibility with callers that use the historical
 * `(asOf, orgId, bookId)` shape; subsidiary-aware callers can pass it as the
 * fourth argument without changing those call sites.
 */
export async function balanceSheet(
  asOf: string,
  orgId?: string,
  bookId?: string | null,
  dims?: DimFilter,
) {
  const resolvedOrgId = orgId ?? (await resolveOrgId());
  const rows = await summaryAccountBalances(resolvedOrgId, null, asOf, dims?.subsidiaryIds, bookId);
  const assets = treeify(rows, ["asset_bank", "asset_receivable", "asset_current_other", "asset_fixed", "asset_other"]);
  const liabilities = treeify(rows, ["liability_payable", "liability_card", "liability_current_other", "liability_long_term"]);
  const equity = treeify(rows, ["equity"]);

  const sum = (xs: StatementRow[]) => decimalSum(xs.filter((r) => r.depth === 0).map((r) => r.balance));
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const statedEquity = sum(equity);

  // No closing entries exist (by design): accumulated earnings = lifetime P&L,
  // which is already present per account in the cumulative rows above.
  const accumulatedEarnings = decimalNeg(
    decimalSum(rows.filter((r) => PNL_TYPES.includes(r.type)).map((r) => r.raw)),
  );
  equity.push({
    id: "computed-earnings", number: null, name: "Accumulated earnings (computed)",
    type: "equity", balance: accumulatedEarnings, depth: 0, isSummary: false,
  });
  const totalEquity = decimalAdd(statedEquity, accumulatedEarnings);

  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
}

export async function trialBalance(asOf: string, dims?: DimFilter, orgId?: string, bookId?: string | null) {
  const resolvedOrgId = orgId ?? (await resolveOrgId());
  if (glSummaryEligibleDims(dims)) {
    // Whole months from gl_month_activity, boundary sliver from lines.
    const buckets = glActivityBuckets(resolvedOrgId, { minDate: null, maxDate: asOf, boundaries: [], bookId });
    const r = (await db.execute(sql`
      select a.id, a.number, a.name, a.type, s.debits, s.credits, s.balance
        from (
          select b.account_id, sum(b.debit_total) as debits, sum(b.credit_total) as credits,
                 sum(b.amount) as balance
            from ${buckets} b
           where b.d <= ${asOf} ${bucketSubsidiaryFilter(dims?.subsidiaryIds)}
           group by b.account_id having abs(sum(b.amount)) > 0
        ) s
        join accounts a on a.id = s.account_id and a.org_id = ${resolvedOrgId}
       order by a.number nulls last, a.name
    `));
    return r.rows as { id: string; number: string | null; name: string; type: string; debits: string; credits: string; balance: string }[];
  }
  // Materialized entry set + hash join — see accountBalances.
  const r = (await db.execute(sql`
    with e as materialized (
      select id from journal_entries
       where org_id = ${resolvedOrgId} and status in ('posted', 'reversed')
         and posting_date <= ${asOf}
         and book_id = ${statementBookExpr(resolvedOrgId, bookId)}
    )
    select a.id, a.number, a.name, a.type,
           sum(case when l.amount > 0 then l.amount else 0 end) as debits,
           sum(case when l.amount < 0 then -l.amount else 0 end) as credits,
           sum(l.amount) as balance
      from journal_lines l
      join e on e.id = l.entry_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${resolvedOrgId}
       and a.org_id = ${resolvedOrgId} and ${dimWhere(dims)}
     group by a.id having abs(sum(l.amount)) > 0
     order by a.number nulls last, a.name
  `));
  return r.rows as { id: string; number: string | null; name: string; type: string; debits: string; credits: string; balance: string }[];
}

/**
 * Outstanding control-account balances through one inclusive business date.
 * Interactive callers default to the org's business day; exports and other
 * reproducible reads can pin that same boundary explicitly.
 */
export async function partnerBalances(kind: "receivable" | "payable", orgId?: string, asOf?: string, bookId?: string | null) {
  const resolvedOrgId = orgId ?? (await resolveOrgId());
  const resolvedAsOf = asOf ?? (await businessToday(resolvedOrgId));
  const type = kind === "receivable" ? "asset_receivable" : "liability_payable";
  const r = (await db.execute(sql`
    with e as materialized (
      select id from journal_entries
       where org_id = ${resolvedOrgId} and status in ('posted', 'reversed')
         and posting_date <= ${resolvedAsOf}
         and book_id = ${statementBookExpr(resolvedOrgId, bookId)}
    )
    select p.id, p.display_name, sum(l.amount) as balance, count(*) as line_count,
           max(l.due_date) as latest_due
      from journal_lines l
      join e on e.id = l.entry_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = ${resolvedOrgId}
     where a.org_id = ${resolvedOrgId} and l.org_id = ${resolvedOrgId}
       and a.type = ${type}
     group by p.id, p.display_name
    having abs(sum(l.amount)) > 0
     order by abs(sum(l.amount)) desc
  `));
  return r.rows as { id: string | null; display_name: string | null; balance: string; line_count: string; latest_due: string | null }[];
}
