import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentFiscalYear, fiscalStartMonth, fiscalYearRangeFor } from "./fiscal";

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

function dimWhere(dims: DimFilter | undefined, alias = sql`l`) {
  let w = sql`true`;
  if (dims?.departmentId) w = sql`${w} and ${alias}.department_id = ${dims.departmentId}`;
  if (dims?.projectId) w = sql`${w} and ${alias}.project_id = ${dims.projectId}`;
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

// ---------------------------------------------------------------------------
// AR / AP Aging
// ---------------------------------------------------------------------------

export type AgingSide = "ar" | "ap";

/** The five aging buckets, oldest last. `age` is days past due (or since posting). */
export interface AgingRow {
  partyId: string | null;
  partyName: string | null;
  current: number; // not yet due (age <= 0)
  b1: number; // 1–30
  b2: number; // 31–60
  b3: number; // 61–90
  b4: number; // 90+
  total: number;
}

export interface AgingResult {
  rows: AgingRow[];
  totals: Omit<AgingRow, "partyId" | "partyName">;
  asOf: string;
}

/**
 * Per-party open-item aging. Mirrors the payments open-item logic
 * (`engine/src/payments.ts#openItemsForParty`): an open item is an
 * `is_open_item` journal line on a POSTED entry with the right sign for the
 * side (AR = debit, AP = credit). Its remaining open balance is the absolute
 * line amount NET of live `applications` (unapplied_at is null) whose
 * `to_line_id` points at it — a payment applied to an invoice reduces what's
 * still owed. Only lines with a positive remaining balance are aged.
 *
 * Each open item is bucketed by age = (asOf − due_date), falling back to the
 * entry posting_date when the line carries no due date. All arithmetic is done
 * in Postgres against the netted remaining balance so it ties out exactly to
 * the payments open-items view and the Payables/Receivables-by-party report.
 */
export async function agingByParty(side: AgingSide, asOf: string, dims?: DimFilter): Promise<AgingResult> {
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const r = (await db.execute(sql`
    with open_items as (
      select jl.party_id,
             abs(jl.amount) - coalesce(ap.applied, 0) as open,
             (${asOf}::date - coalesce(jl.due_date, je.posting_date)) as age_days
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        left join lateral (
          select sum(a.amount) as applied
            from applications a
           where a.to_line_id = jl.id and a.unapplied_at is null
        ) ap on true
       where jl.is_open_item and ${signFilter}
         and je.posting_date <= ${asOf} and ${dimWhere(dims, sql`jl`)}
    )
    select oi.party_id, p.display_name as party_name,
           coalesce(sum(oi.open) filter (where oi.age_days <= 0), 0) as current,
           coalesce(sum(oi.open) filter (where oi.age_days between 1 and 30), 0) as b1,
           coalesce(sum(oi.open) filter (where oi.age_days between 31 and 60), 0) as b2,
           coalesce(sum(oi.open) filter (where oi.age_days between 61 and 90), 0) as b3,
           coalesce(sum(oi.open) filter (where oi.age_days > 90), 0) as b4,
           coalesce(sum(oi.open), 0) as total
      from open_items oi
      left join parties p on p.id = oi.party_id
     where oi.open > 0.005
     group by oi.party_id, p.display_name
    having sum(oi.open) > 0.005
     order by sum(oi.open) desc
  `)) as unknown as {
    rows: {
      party_id: string | null; party_name: string | null;
      current: string; b1: string; b2: string; b3: string; b4: string; total: string;
    }[];
  };
  const rows: AgingRow[] = r.rows.map((x) => ({
    partyId: x.party_id,
    partyName: x.party_name,
    current: Number(x.current),
    b1: Number(x.b1),
    b2: Number(x.b2),
    b3: Number(x.b3),
    b4: Number(x.b4),
    total: Number(x.total),
  }));
  const totals = rows.reduce(
    (a, r) => ({
      current: a.current + r.current,
      b1: a.b1 + r.b1,
      b2: a.b2 + r.b2,
      b3: a.b3 + r.b3,
      b4: a.b4 + r.b4,
      total: a.total + r.total,
    }),
    { current: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 },
  );
  return { rows, totals, asOf };
}

// ---------------------------------------------------------------------------
// Cash Flow Statement (direct classification of bank-account contra movements)
// ---------------------------------------------------------------------------

export type CashFlowSection = "operating" | "investing" | "financing";

/**
 * Single tunable mapping from an account type to a cash-flow section. Every
 * non-bank line that shares an entry with a bank movement is classified by its
 * account's type, so the three sections sum to the net change in cash.
 *
 *  - Operating: revenue, expense, COGS, and working-capital accounts (AR, AP,
 *    cards, other current assets/liabilities). Tax control accounts are
 *    `liability_current_other` / `asset_current_other`, so they land here too.
 *  - Investing: fixed assets and other long-term assets.
 *  - Financing: long-term liabilities and equity.
 */
export const CASH_FLOW_SECTION: Record<string, CashFlowSection> = {
  income: "operating",
  income_other: "operating",
  cogs: "operating",
  expense: "operating",
  expense_other: "operating",
  expense_deferred: "operating",
  asset_receivable: "operating",
  asset_current_other: "operating",
  liability_payable: "operating",
  liability_card: "operating",
  liability_current_other: "operating",
  asset_fixed: "investing",
  asset_other: "investing",
  liability_long_term: "financing",
  equity: "financing",
};

export interface CashFlowLine {
  type: string;
  label: string;
  amount: number; // effect on cash (debit-to-bank positive = cash in)
}

export interface CashFlowResult {
  sections: { section: CashFlowSection; lines: CashFlowLine[]; subtotal: number }[];
  netChange: number;
  openingCash: number;
  closingCash: number;
  /** closingCash − openingCash − netChange; should be ~0 when the statement ties. */
  reconciliationGap: number;
}

const CASH_FLOW_TYPE_LABEL: Record<string, string> = {
  income: "Income",
  income_other: "Other income",
  cogs: "Cost of goods sold",
  expense: "Operating expenses",
  expense_other: "Other expenses",
  expense_deferred: "Deferred expenses",
  asset_receivable: "Accounts receivable",
  asset_current_other: "Other current assets",
  liability_payable: "Accounts payable",
  liability_card: "Credit cards",
  liability_current_other: "Other current liabilities",
  asset_fixed: "Fixed assets",
  asset_other: "Other assets",
  liability_long_term: "Long-term liabilities",
  equity: "Equity & shareholder",
};

/**
 * Direct-method cash-flow statement for a period. Cash is the set of bank-type
 * (`asset_bank`) accounts. For every posted entry that touches a bank account
 * in the period, the NON-bank lines are the sources/uses of that cash; each is
 * classified into Operating / Investing / Financing by its account type
 * (`CASH_FLOW_SECTION`). The cash effect of a contra line is the negative of
 * its debit-signed amount (a credit to a non-bank account funds cash in).
 *
 * The three sections therefore sum to the net change in cash, which is proven
 * against the bank accounts' opening/closing balances.
 */
export async function cashFlow(from: string, to: string, dims?: DimFilter): Promise<CashFlowResult> {
  // Contra movements: non-bank lines on entries that also hit a bank account,
  // grouped by account type. `-sum(amount)` converts debit-signed line amounts
  // into their effect on cash (credit a contra → cash in → positive).
  const contra = (await db.execute(sql`
    with cash_entries as (
      select distinct e.id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
        join accounts a on a.id = l.account_id
       where a.type = 'asset_bank' and e.status = 'posted'
         and e.posting_date >= ${from} and e.posting_date <= ${to}
    )
    select a.type, -sum(l.amount) as cash_effect
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.id in (select id from cash_entries)
       and a.type <> 'asset_bank' and ${dimWhere(dims)}
     group by a.type
  `)) as unknown as { rows: { type: string; cash_effect: string }[] };

  const bySection: Record<CashFlowSection, CashFlowLine[]> = { operating: [], investing: [], financing: [] };
  for (const row of contra.rows) {
    const amount = Number(row.cash_effect);
    if (Math.abs(amount) < 0.005) continue;
    const section = CASH_FLOW_SECTION[row.type] ?? "operating";
    bySection[section].push({
      type: row.type,
      label: CASH_FLOW_TYPE_LABEL[row.type] ?? row.type,
      amount,
    });
  }

  const order: CashFlowSection[] = ["operating", "investing", "financing"];
  const sections = order.map((section) => {
    const lines = bySection[section].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return { section, lines, subtotal: lines.reduce((a, l) => a + l.amount, 0) };
  });
  const netChange = sections.reduce((a, s) => a + s.subtotal, 0);

  // Opening/closing cash straight from the bank accounts, proving the tie-out.
  const cash = (await db.execute(sql`
    select coalesce(sum(l.amount) filter (where e.posting_date < ${from}), 0) as opening,
           coalesce(sum(l.amount) filter (where e.posting_date <= ${to}), 0) as closing
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where a.type = 'asset_bank' and ${dimWhere(dims)}
  `)) as unknown as { rows: { opening: string; closing: string }[] };
  const openingCash = Number(cash.rows[0]?.opening ?? 0);
  const closingCash = Number(cash.rows[0]?.closing ?? 0);

  return {
    sections,
    netChange,
    openingCash,
    closingCash,
    reconciliationGap: closingCash - openingCash - netChange,
  };
}

export async function accountRegister(
  accountId: string,
  limit = 100,
  offset = 0,
  period?: { from?: string; to?: string },
) {
  const acct = (await db.execute(sql`select id, number, name, type from accounts where id = ${accountId}`)) as any;
  const dateFilter =
    period?.from || period?.to
      ? sql` and e.posting_date >= ${period?.from ?? '0001-01-01'} and e.posting_date <= ${period?.to ?? '9999-12-31'}`
      : sql``;
  const r = (await db.execute(sql`
    select e.id as entry_id, e.entry_number, e.posting_date, e.memo as entry_memo,
           l.line_number, l.amount, l.memo, p.display_name as party
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      left join parties p on p.id = l.party_id
     where l.account_id = ${accountId} ${dateFilter}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${limit} offset ${offset}
  `)) as any;
  const c = (await db.execute(sql`select count(*) as n, coalesce(sum(amount),0) as bal from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = ${accountId} ${dateFilter}`)) as any;
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

/**
 * Fiscal-year start/end dates for a fiscal year (named by its ending calendar
 * year), driven by the org's configured `fiscalYearStartMonth` — never
 * hardcoded to a calendar year or to April. Reads the setting via
 * `web/lib/fiscal.ts` so a change in Company & Accounting settings flows here.
 */
export async function fiscalYearRange(fyEndYear: number) {
  return fiscalYearRangeFor(fyEndYear, await fiscalStartMonth());
}

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYearEnd(today = new Date().toISOString().slice(0, 10)): Promise<number> {
  return currentFiscalYear(today);
}
