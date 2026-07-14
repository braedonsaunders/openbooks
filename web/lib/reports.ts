import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

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
  balance: number; // reader-signed (revenue positive, expense positive)
  depth: number;
  isSummary: boolean;
}

const PNL_TYPES = ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"];
const CREDIT_NORMAL = new Set([
  "income", "income_other",
  "liability_payable", "liability_card", "liability_current_other", "liability_long_term",
  "equity",
]);

export interface DimFilter {
  departmentId?: string;
  projectId?: string;
}

function dimWhere(dims: DimFilter | undefined) {
  let w = sql`true`;
  if (dims?.departmentId) w = sql`${w} and l.department_id = ${dims.departmentId}`;
  if (dims?.projectId) w = sql`${w} and l.project_id = ${dims.projectId}`;
  return w;
}

async function accountBalances(where: ReturnType<typeof sql>, dims?: DimFilter) {
  const r = (await db.execute(sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary,
           coalesce(sum(l.amount), 0) as raw
      from accounts a
      left join (journal_lines l join journal_entries e on e.id = l.entry_id)
        on l.account_id = a.id and ${where} and ${dimWhere(dims)}
     group by a.id
     order by a.number nulls last, a.name
  `)) as any;
  return r.rows as {
    id: string; parent_id: string | null; number: string | null; name: string;
    type: string; is_summary: boolean; raw: string;
  }[];
}

/** Roll child balances into parents, return tree-ordered rows with depth. */
function treeify(rows: Awaited<ReturnType<typeof accountBalances>>, types: string[]): StatementRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rolled = new Map<string, number>(rows.map((r) => [r.id, Number(r.raw)]));
  for (const r of rows) {
    let p = r.parent_id;
    while (p) {
      rolled.set(p, (rolled.get(p) ?? 0) + Number(r.raw));
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
      const bal = rolled.get(r.id) ?? 0;
      const signed = CREDIT_NORMAL.has(r.type) ? -bal : bal;
      if (Math.abs(signed) >= 0.005 || r.is_summary) {
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
    if (!r.isSummary || Math.abs(r.balance) >= 0.005) return true;
    const next = out[i + 1];
    return next !== undefined && next.depth > r.depth;
  });
}

export async function profitAndLoss(from: string, to: string, dims?: DimFilter) {
  const rows = await accountBalances(sql`e.posting_date >= ${from} and e.posting_date <= ${to}`, dims);
  const items = treeify(rows, PNL_TYPES);
  const total = (types: string[]) =>
    items.filter((r) => types.includes(r.type) && r.depth === 0).reduce((a, r) => a + r.balance, 0);
  const revenue = total(["income", "income_other"]);
  const cogs = total(["cogs"]);
  const expenses = total(["expense", "expense_other", "expense_deferred"]);
  return { items, revenue, cogs, grossProfit: revenue - cogs, expenses, netIncome: revenue - cogs - expenses };
}

export async function balanceSheet(asOf: string) {
  const rows = await accountBalances(sql`e.posting_date <= ${asOf}`);
  const assets = treeify(rows, ["asset_bank", "asset_receivable", "asset_current_other", "asset_fixed", "asset_other"]);
  const liabilities = treeify(rows, ["liability_payable", "liability_card", "liability_current_other", "liability_long_term"]);
  const equity = treeify(rows, ["equity"]);

  const sum = (xs: StatementRow[]) => xs.filter((r) => r.depth === 0).reduce((a, r) => a + r.balance, 0);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  let totalEquity = sum(equity);

  // No closing entries exist (by design): accumulated earnings = lifetime P&L.
  const pl = (await db.execute(sql`
    select coalesce(sum(l.amount), 0) as s
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
     where a.type in ${PNL_TYPES} and e.posting_date <= ${asOf}
  `)) as any;
  const accumulatedEarnings = -Number(pl.rows[0].s);
  equity.push({
    id: "computed-earnings", number: null, name: "Accumulated earnings (computed)",
    type: "equity", balance: accumulatedEarnings, depth: 0, isSummary: false,
  });
  totalEquity += accumulatedEarnings;

  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
}

export async function trialBalance(asOf: string, dims?: DimFilter) {
  const r = (await db.execute(sql`
    select a.id, a.number, a.name, a.type,
           sum(case when l.amount > 0 then l.amount else 0 end) as debits,
           sum(case when l.amount < 0 then -l.amount else 0 end) as credits,
           sum(l.amount) as balance
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
     where e.posting_date <= ${asOf} and ${dimWhere(dims)}
     group by a.id having abs(sum(l.amount)) >= 0.005
     order by a.number nulls last, a.name
  `)) as any;
  return r.rows as { id: string; number: string | null; name: string; type: string; debits: string; credits: string; balance: string }[];
}

export async function partnerBalances(kind: "receivable" | "payable") {
  const type = kind === "receivable" ? "asset_receivable" : "liability_payable";
  const r = (await db.execute(sql`
    select p.id, p.display_name, sum(l.amount) as balance, count(*) as line_count,
           max(l.due_date) as latest_due
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
     where a.type = ${type}
     group by p.id, p.display_name
    having abs(sum(l.amount)) >= 0.005
     order by abs(sum(l.amount)) desc
  `)) as any;
  return r.rows as { id: string | null; display_name: string | null; balance: string; line_count: string; latest_due: string | null }[];
}

export async function accountRegister(accountId: string, limit = 100, offset = 0) {
  const acct = (await db.execute(sql`select id, number, name, type from accounts where id = ${accountId}`)) as any;
  const r = (await db.execute(sql`
    select e.id as entry_id, e.entry_number, e.posting_date, e.memo as entry_memo,
           l.line_number, l.amount, l.memo, p.display_name as party
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join parties p on p.id = l.party_id
     where l.account_id = ${accountId}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${limit} offset ${offset}
  `)) as any;
  const c = (await db.execute(sql`select count(*) as n, coalesce(sum(amount),0) as bal from journal_lines where account_id = ${accountId}`)) as any;
  return { account: acct.rows[0], lines: r.rows, total: Number(c.rows[0].n), balance: c.rows[0].bal };
}

export async function dimensionOptions() {
  const depts = (await db.execute(sql`select id, name from departments where is_active order by name`)) as any;
  const projects = (await db.execute(sql`
    select p.id, p.name from projects p
     where exists (select 1 from journal_lines l where l.project_id = p.id)
     order by p.name limit 500`)) as any;
  return { departments: depts.rows, projects: projects.rows };
}

/** Fiscal years are April–March, named by ending year. */
export function fiscalYearRange(fyEndYear: number) {
  return { from: `${fyEndYear - 1}-04-01`, to: `${fyEndYear}-03-31`, label: `FY ${fyEndYear}` };
}

export function currentFiscalYearEnd(today = new Date()): number {
  return today.getUTCMonth() >= 3 ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
}
