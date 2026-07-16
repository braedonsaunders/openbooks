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
  locationId?: string;
  classId?: string;
}

function dimWhere(dims: DimFilter | undefined, alias = sql`l`) {
  let w = sql`true`;
  if (dims?.departmentId) w = sql`${w} and ${alias}.department_id = ${dims.departmentId}`;
  if (dims?.projectId) w = sql`${w} and ${alias}.project_id = ${dims.projectId}`;
  if (dims?.locationId) w = sql`${w} and ${alias}.location_id = ${dims.locationId}`;
  if (dims?.classId) w = sql`${w} and ${alias}.class_id = ${dims.classId}`;
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
  orgId: string,
  accountId: string,
  limit = 100,
  offset = 0,
  period?: { from?: string; to?: string },
) {
  const acct = (await db.execute(sql`
    select id, number, name, type from accounts
     where id = ${accountId} and org_id = ${orgId}
  `)) as any;
  if (!acct.rows[0]) return { account: undefined, lines: [], total: 0, balance: '0' };
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
     where l.account_id = ${accountId} and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${limit} offset ${offset}
  `)) as any;
  const c = (await db.execute(sql`
    select count(*) as n, coalesce(sum(amount),0) as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where l.account_id = ${accountId} and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter}
  `)) as any;
  return { account: acct.rows[0], lines: r.rows, total: Number(c.rows[0].n), balance: c.rows[0].bal };
}

// ---------------------------------------------------------------------------
// General Ledger — per-account transaction listing with a running balance
// ---------------------------------------------------------------------------

export interface GeneralLedgerLine {
  entryId: string
  entryNumber: string | null
  date: string
  memo: string | null
  party: string | null
  debit: number
  credit: number
  balance: number // running (debit-signed) within the account
  docKind: string | null
  docId: string | null
}

export interface GeneralLedgerAccount {
  id: string
  number: string | null
  name: string
  type: string
  opening: number
  closing: number
  lines: GeneralLedgerLine[]
}

export interface GeneralLedgerResult {
  accounts: GeneralLedgerAccount[]
  from: string
  to: string
  truncated: boolean
}

/**
 * General Ledger: for each account with activity in the period, its opening
 * balance (all posted lines before `from`), every posted line in the period in
 * date order with a running balance, and the closing balance. Balances are
 * debit-signed (matches the account register). Capped at `maxLines` posted
 * lines overall so a full-ledger run stays bounded.
 */
export async function generalLedger(
  from: string,
  to: string,
  opts: { accountId?: string; dims?: DimFilter; maxLines?: number } = {},
): Promise<GeneralLedgerResult> {
  const maxLines = opts.maxLines ?? 5000
  const acctFilter = opts.accountId ? sql` and l.account_id = ${opts.accountId}` : sql``

  // Opening balances (debit-signed) per account before the period.
  const opening = (await db.execute(sql`
    select l.account_id, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where e.posting_date < ${from} and ${dimWhere(opts.dims)}${acctFilter}
     group by l.account_id
  `)) as unknown as { rows: { account_id: string; bal: string }[] }
  const openingByAcct = new Map(opening.rows.map((r) => [r.account_id, Number(r.bal)]))

  const lines = (await db.execute(sql`
    select l.account_id, a.number, a.name, a.type,
           e.id as entry_id, e.entry_number, e.posting_date::text as date,
           l.memo, p.display_name as party, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join documents d on d.id = e.source_document_id
     where e.posting_date >= ${from} and e.posting_date <= ${to} and ${dimWhere(opts.dims)}${acctFilter}
     order by a.number nulls last, a.name, e.posting_date, e.entry_number, l.line_number
     limit ${maxLines + 1}
  `)) as unknown as {
    rows: {
      account_id: string; number: string | null; name: string; type: string
      entry_id: string; entry_number: string | null; date: string
      memo: string | null; party: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }[]
  }
  const truncated = lines.rows.length > maxLines
  const rows = truncated ? lines.rows.slice(0, maxLines) : lines.rows

  const accounts: GeneralLedgerAccount[] = []
  let current: GeneralLedgerAccount | null = null
  for (const r of rows) {
    if (!current || current.id !== r.account_id) {
      const open = openingByAcct.get(r.account_id) ?? 0
      current = { id: r.account_id, number: r.number, name: r.name, type: r.type, opening: open, closing: open, lines: [] }
      accounts.push(current)
    }
    const amt = Number(r.amount)
    current.closing += amt
    current.lines.push({
      entryId: r.entry_id,
      entryNumber: r.entry_number,
      date: r.date,
      memo: r.memo,
      party: r.party,
      debit: amt > 0 ? amt : 0,
      credit: amt < 0 ? -amt : 0,
      balance: current.closing,
      docKind: r.doc_kind,
      docId: r.doc_id,
    })
  }
  return { accounts, from, to, truncated }
}

// ---------------------------------------------------------------------------
// Journal report — posted journal entries with their lines, over a period
// ---------------------------------------------------------------------------

export interface JournalReportLine {
  accountNumber: string | null
  accountName: string
  party: string | null
  memo: string | null
  debit: number
  credit: number
}
export interface JournalReportEntry {
  id: string
  entryNumber: string | null
  date: string
  memo: string | null
  origin: string
  lines: JournalReportLine[]
  totalDebit: number
  docKind: string | null
  docId: string | null
}
export interface JournalReportResult {
  entries: JournalReportEntry[]
  from: string
  to: string
  truncated: boolean
}

/**
 * Journal report: every posted entry in the period with its lines (debit/credit
 * split), newest first. Capped at `maxLines` journal lines overall so a wide
 * range stays bounded.
 */
export async function journalReport(
  from: string,
  to: string,
  opts: { dims?: DimFilter; maxLines?: number } = {},
): Promise<JournalReportResult> {
  const maxLines = opts.maxLines ?? 4000
  const r = (await db.execute(sql`
    select e.id, e.entry_number, e.posting_date::text as date, e.memo as entry_memo, e.origin,
           a.number as acct_number, a.name as acct_name, p.display_name as party,
           l.memo as line_memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join documents d on d.id = e.source_document_id
     where e.status = 'posted' and e.posting_date >= ${from} and e.posting_date <= ${to}
       and ${dimWhere(opts.dims)}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${maxLines + 1}
  `)) as unknown as {
    rows: {
      id: string; entry_number: string | null; date: string; entry_memo: string | null; origin: string
      acct_number: string | null; acct_name: string; party: string | null; line_memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }[]
  }
  const truncated = r.rows.length > maxLines
  const rows = truncated ? r.rows.slice(0, maxLines) : r.rows

  const entries: JournalReportEntry[] = []
  let current: JournalReportEntry | null = null
  for (const x of rows) {
    if (!current || current.id !== x.id) {
      current = { id: x.id, entryNumber: x.entry_number, date: x.date, memo: x.entry_memo, origin: x.origin, lines: [], totalDebit: 0, docKind: x.doc_kind, docId: x.doc_id }
      entries.push(current)
    }
    const amt = Number(x.amount)
    current.lines.push({
      accountNumber: x.acct_number,
      accountName: x.acct_name,
      party: x.party,
      memo: x.line_memo,
      debit: amt > 0 ? amt : 0,
      credit: amt < 0 ? -amt : 0,
    })
    if (amt > 0) current.totalDebit += amt
  }
  return { entries, from, to, truncated }
}

// ---------------------------------------------------------------------------
// AR / AP Aging Detail — one row per open item (invoice/bill), bucketed
// ---------------------------------------------------------------------------

export type AgingBucket = "current" | "b1" | "b2" | "b3" | "b4"

export interface AgingDetailRow {
  partyId: string | null
  partyName: string | null
  reference: string | null
  dueDate: string | null
  ageDays: number
  bucket: AgingBucket
  open: number
}
export interface AgingDetailResult {
  rows: AgingDetailRow[]
  totals: Record<AgingBucket, number> & { total: number }
  asOf: string
}

function bucketOf(age: number): AgingBucket {
  if (age <= 0) return "current"
  if (age <= 30) return "b1"
  if (age <= 60) return "b2"
  if (age <= 90) return "b3"
  return "b4"
}

/**
 * Per-open-item aging: the same netted open-item logic as `agingByParty`, but
 * one row per invoice/bill (its entry reference, due date, age and bucket)
 * rather than aggregated per party. Ordered party then oldest-first.
 */
export async function agingDetail(side: AgingSide, asOf: string, dims?: DimFilter): Promise<AgingDetailResult> {
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`
  const r = (await db.execute(sql`
    with open_items as (
      select jl.party_id, je.entry_number,
             coalesce(jl.due_date, je.posting_date)::text as due,
             abs(jl.amount) - coalesce(ap.applied, 0) as open,
             (${asOf}::date - coalesce(jl.due_date, je.posting_date))::int as age_days
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
    select oi.party_id, p.display_name as party_name, oi.entry_number as reference,
           oi.due as due_date, oi.age_days, oi.open
      from open_items oi
      left join parties p on p.id = oi.party_id
     where oi.open > 0.005
     order by p.display_name nulls last, oi.age_days desc
  `)) as unknown as {
    rows: {
      party_id: string | null; party_name: string | null; reference: string | null
      due_date: string | null; age_days: number; open: string
    }[]
  }
  const totals: Record<AgingBucket, number> & { total: number } = { current: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 }
  const rows: AgingDetailRow[] = r.rows.map((x) => {
    const open = Number(x.open)
    const bucket = bucketOf(x.age_days)
    totals[bucket] += open
    totals.total += open
    return { partyId: x.party_id, partyName: x.party_name, reference: x.reference, dueDate: x.due_date, ageDays: x.age_days, bucket, open }
  })
  return { rows, totals, asOf }
}

// ---------------------------------------------------------------------------
// AR / AP Register — per-party transaction register on the control account
// ---------------------------------------------------------------------------

export interface RegisterLine {
  entryId: string
  entryNumber: string | null
  date: string
  memo: string | null
  debit: number
  credit: number
  balance: number
  docKind: string | null
  docId: string | null
}
export interface RegisterParty {
  partyId: string | null
  partyName: string | null
  opening: number
  closing: number
  lines: RegisterLine[]
}
export interface RegisterResult {
  parties: RegisterParty[]
  from: string
  to: string
  side: AgingSide
  truncated: boolean
}

/**
 * AR/AP register: for each party, its opening balance on the control account
 * (all posted lines before `from`), every posted line in the period with a
 * running balance, and the closing balance. Balances are debit-signed. AR uses
 * the `asset_receivable` control accounts, AP `liability_payable`.
 */
export async function partyRegister(
  side: AgingSide,
  opts: { from: string; to: string; partyId?: string; dims?: DimFilter; maxLines?: number },
): Promise<RegisterResult> {
  const acctType = side === "ap" ? "liability_payable" : "asset_receivable"
  const maxLines = opts.maxLines ?? 4000
  const partyFilter = opts.partyId ? sql` and l.party_id = ${opts.partyId}` : sql``

  const opening = (await db.execute(sql`
    select l.party_id, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where a.type = ${acctType} and e.posting_date < ${opts.from}
       and ${dimWhere(opts.dims)}${partyFilter}
     group by l.party_id
  `)) as unknown as { rows: { party_id: string | null; bal: string }[] }
  const openingByParty = new Map(opening.rows.map((r) => [r.party_id, Number(r.bal)]))

  const lines = (await db.execute(sql`
    select l.party_id, pt.display_name as party_name,
           e.id as entry_id, e.entry_number, e.posting_date::text as date, l.memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
      left join parties pt on pt.id = l.party_id
      left join documents d on d.id = e.source_document_id
     where a.type = ${acctType} and e.posting_date >= ${opts.from} and e.posting_date <= ${opts.to}
       and ${dimWhere(opts.dims)}${partyFilter}
     order by pt.display_name nulls last, e.posting_date, e.entry_number, l.line_number
     limit ${maxLines + 1}
  `)) as unknown as {
    rows: {
      party_id: string | null; party_name: string | null
      entry_id: string; entry_number: string | null; date: string; memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }[]
  }
  const truncated = lines.rows.length > maxLines
  const rows = truncated ? lines.rows.slice(0, maxLines) : lines.rows

  const parties: RegisterParty[] = []
  let current: RegisterParty | null = null
  for (const x of rows) {
    if (!current || current.partyId !== x.party_id) {
      const open = openingByParty.get(x.party_id) ?? 0
      current = { partyId: x.party_id, partyName: x.party_name, opening: open, closing: open, lines: [] }
      parties.push(current)
    }
    const amt = Number(x.amount)
    current.closing += amt
    current.lines.push({
      entryId: x.entry_id,
      entryNumber: x.entry_number,
      date: x.date,
      memo: x.memo,
      debit: amt > 0 ? amt : 0,
      credit: amt < 0 ? -amt : 0,
      balance: current.closing,
      docKind: x.doc_kind,
      docId: x.doc_id,
    })
  }
  return { parties, from: opts.from, to: opts.to, side, truncated }
}

// ---------------------------------------------------------------------------
// Partner statement — one party: opening, dated activity, closing + aged summary
// ---------------------------------------------------------------------------

export interface PartnerStatementResult {
  party: { id: string; name: string | null }
  side: AgingSide
  from: string
  to: string
  opening: number
  closing: number
  lines: RegisterLine[]
  aging: Record<AgingBucket, number> & { total: number }
}

/** Account statement for a single party: opening balance on the control
 *  account, dated activity with a running balance, closing balance, and an
 *  aged-summary footer as of `to` (reusing the open-item aging logic). */
export async function partnerStatement(
  partyId: string,
  opts: { from: string; to: string; side: AgingSide },
): Promise<PartnerStatementResult> {
  const reg = await partyRegister(opts.side, { from: opts.from, to: opts.to, partyId })
  const p = reg.parties[0]
  const nameRow = (await db.execute(sql`select display_name from parties where id = ${partyId}`)) as unknown as {
    rows: { display_name: string | null }[]
  }
  const aging = await agingDetail(opts.side, opts.to)
  const agingTotals: Record<AgingBucket, number> & { total: number } = { current: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 }
  for (const row of aging.rows) {
    if (row.partyId !== partyId) continue
    agingTotals[row.bucket] += row.open
    agingTotals.total += row.open
  }
  return {
    party: { id: partyId, name: nameRow.rows[0]?.display_name ?? p?.partyName ?? null },
    side: opts.side,
    from: opts.from,
    to: opts.to,
    opening: p?.opening ?? 0,
    closing: p?.closing ?? 0,
    lines: p?.lines ?? [],
    aging: agingTotals,
  }
}

// ---------------------------------------------------------------------------
// Transaction detail — the journal lines behind any statement value (drill-down)
// ---------------------------------------------------------------------------

export interface TxnDetailLine {
  entryId: string
  entryNumber: string | null
  date: string
  accountNumber: string | null
  accountName: string
  accountType: string
  party: string | null
  memo: string | null
  amount: number // debit-signed
  /** Source-document kind (vendor_bill, customer_invoice, journal, …) for the
   *  transaction-type pill; null for system-generated GL entries. */
  docKind: string | null
  /** Source-document id → opens the native module drawer; null when none. */
  docId: string | null
}

export interface TxnDetailResult {
  lines: TxnDetailLine[]
  totalDebit: number
  totalCredit: number
  /** Reader-signed net (credit-normal types flipped) — ties to the clicked cell. */
  net: number
  count: number
  truncated: boolean
}

/**
 * The posted journal lines that make up a single statement value. `accountIds`
 * drills a specific account AND its descendants (matching how the matrix rolls
 * children into parents); `accountTypes` drills a section/subtotal (every
 * account of those types). `mode: 'flow'` sums the [from,to] window; 'balance'
 * is cumulative up to `to`. Basis/dims mirror the matrix engine so the `net`
 * ties out to the cell the user clicked.
 */
export async function transactionDetail(opts: {
  accountIds?: string[]
  accountTypes?: string[]
  from?: string | null
  to: string
  mode: "flow" | "balance"
  dims?: DimFilter
  basis?: "accrual" | "cash"
  limit?: number
  offset?: number
}): Promise<TxnDetailResult> {
  const limit = opts.limit ?? 2000
  const offset = opts.offset ?? 0
  const acctFilter =
    opts.accountIds && opts.accountIds.length
      ? sql`a.id in (
          with recursive sub as (
            select id from accounts where id in ${opts.accountIds}
            union all
            select c.id from accounts c join sub on c.parent_id = sub.id
          ) select id from sub
        )`
      : opts.accountTypes && opts.accountTypes.length
        ? sql`a.type in ${opts.accountTypes}`
        : sql`true`
  const dateFilter =
    opts.mode === "balance"
      ? sql`e.posting_date <= ${opts.to}`
      : sql`e.posting_date >= ${opts.from ?? "0001-01-01"} and e.posting_date <= ${opts.to}`
  const cashFilter =
    opts.basis === "cash"
      ? sql` and e.id in (select l2.entry_id from journal_lines l2 join accounts a2 on a2.id = l2.account_id where a2.type = 'asset_bank')`
      : sql``

  const where = sql`${acctFilter} and ${dateFilter} and ${dimWhere(opts.dims)}${cashFilter}`

  // Totals over the FULL set (independent of the display limit), so `net` ties
  // out to the clicked cell even when the line list is truncated. `net` is
  // reader-signed (credit-normal types flipped) — matches the matrix account/
  // section value.
  const creditNormal = [...CREDIT_NORMAL]
  const agg = (await db.execute(sql`
    select count(*)::int as n,
           coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as debit,
           coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0) as credit,
           coalesce(sum(case when a.type in ${creditNormal} then -l.amount else l.amount end), 0) as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where ${where}
  `)) as unknown as { rows: { n: number; debit: string; credit: string; net: string }[] }
  const totals = agg.rows[0] ?? { n: 0, debit: '0', credit: '0', net: '0' }

  const r = (await db.execute(sql`
    select e.id as entry_id, e.entry_number, e.posting_date::text as date,
           a.number as acct_number, a.name as acct_name, a.type as acct_type,
           p.display_name as party, l.memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join documents d on d.id = e.source_document_id
     where ${where}
     order by e.posting_date, e.entry_number, l.line_number
     limit ${limit} offset ${offset}
  `)) as unknown as {
    rows: {
      entry_id: string; entry_number: string | null; date: string
      acct_number: string | null; acct_name: string; acct_type: string
      party: string | null; memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }[]
  }
  const lines: TxnDetailLine[] = r.rows.map((x) => ({
    entryId: x.entry_id,
    entryNumber: x.entry_number,
    date: x.date,
    accountNumber: x.acct_number,
    accountName: x.acct_name,
    accountType: x.acct_type,
    party: x.party,
    memo: x.memo,
    amount: Number(x.amount),
    docKind: x.doc_kind,
    docId: x.doc_id,
  }))
  return {
    lines,
    totalDebit: Number(totals.debit),
    totalCredit: Number(totals.credit),
    net: Number(totals.net),
    count: totals.n,
    truncated: totals.n > lines.length,
  }
}

// ---------------------------------------------------------------------------
// Project profitability — per-project revenue, cost and margin (job costing)
// ---------------------------------------------------------------------------

export interface ProjectProfitRow {
  projectId: string
  projectName: string
  customerName: string | null
  status: string | null
  billingMethod: string | null
  revenue: number
  cogs: number
  grossProfit: number
  expenses: number
  net: number
  margin: number | null // net ÷ revenue; null when there's no revenue
  hours: number
}
export interface ProjectProfitResult {
  rows: ProjectProfitRow[]
  totals: { revenue: number; cogs: number; grossProfit: number; expenses: number; net: number; margin: number | null; hours: number }
  from: string
  to: string
}

/**
 * Project profitability: for every project with posted P&L activity (or
 * approved time) in the period, its revenue, COGS, expenses, gross profit, net
 * and margin — reader-signed so revenue and profit read positive. Money comes
 * straight from `journal_lines.project_id`, so each project row ties exactly to
 * the P&L filtered on that project (the row links there). `hours` is approved
 * `time_entries` for the period, an operational read on the money.
 */
export async function projectProfitability(
  from: string,
  to: string,
  opts: { dims?: DimFilter } = {},
): Promise<ProjectProfitResult> {
  const r = (await db.execute(sql`
    with pl as (
      select l.project_id,
             coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0) as revenue,
             coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0) as cogs,
             coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0) as expenses
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.status = 'posted'
        join accounts a on a.id = l.account_id
       where l.project_id is not null
         and e.posting_date >= ${from} and e.posting_date <= ${to}
         and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
         and ${dimWhere(opts.dims)}
       group by l.project_id
    ),
    hrs as (
      select project_id, coalesce(sum(hours), 0) as hours
        from time_entries
       where project_id is not null and status = 'approved'
         and worked_on >= ${from} and worked_on <= ${to}
       group by project_id
    )
    select p.id, p.name, cu.display_name as customer, p.status, p.billing_method,
           coalesce(pl.revenue, 0) as revenue, coalesce(pl.cogs, 0) as cogs,
           coalesce(pl.expenses, 0) as expenses, coalesce(hrs.hours, 0) as hours
      from projects p
      left join pl on pl.project_id = p.id
      left join hrs on hrs.project_id = p.id
      left join parties cu on cu.id = p.customer_id
     where pl.project_id is not null or hrs.project_id is not null
     order by (coalesce(pl.revenue, 0) - coalesce(pl.cogs, 0) - coalesce(pl.expenses, 0)) desc, p.name
  `)) as unknown as {
    rows: {
      id: string; name: string; customer: string | null; status: string | null; billing_method: string | null
      revenue: string; cogs: string; expenses: string; hours: string
    }[]
  }
  const rows: ProjectProfitRow[] = r.rows.map((x) => {
    const revenue = Number(x.revenue)
    const cogs = Number(x.cogs)
    const expenses = Number(x.expenses)
    const grossProfit = revenue - cogs
    const net = grossProfit - expenses
    return {
      projectId: x.id,
      projectName: x.name,
      customerName: x.customer,
      status: x.status,
      billingMethod: x.billing_method,
      revenue, cogs, grossProfit, expenses, net,
      margin: Math.abs(revenue) >= 0.005 ? net / revenue : null,
      hours: Number(x.hours),
    }
  })
  const t = rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.revenue,
      cogs: a.cogs + r.cogs,
      grossProfit: a.grossProfit + r.grossProfit,
      expenses: a.expenses + r.expenses,
      net: a.net + r.net,
      hours: a.hours + r.hours,
    }),
    { revenue: 0, cogs: 0, grossProfit: 0, expenses: 0, net: 0, hours: 0 },
  )
  const totals = { ...t, margin: Math.abs(t.revenue) >= 0.005 ? t.net / t.revenue : null }
  return { rows, totals, from, to }
}

export async function dimensionOptions() {
  const depts = (await db.execute(sql`select id, name from departments where is_active order by name`)) as any;
  const projects = (await db.execute(sql`
    select p.id, p.name from projects p
     where exists (select 1 from journal_lines l where l.project_id = p.id)
     order by p.name limit 500`)) as any;
  const locations = (await db.execute(sql`select id, name from locations where is_active order by name`)) as any;
  const classes = (await db.execute(sql`select id, name from classes where is_active order by name`)) as any;
  return {
    departments: depts.rows as { id: string; name: string }[],
    projects: projects.rows as { id: string; name: string }[],
    locations: locations.rows as { id: string; name: string }[],
    classes: classes.rows as { id: string; name: string }[],
  };
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
