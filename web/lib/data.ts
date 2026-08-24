import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { fiscalYearOf, fiscalYearRangeFor } from "@openbooks/reports";
import { fiscalStartMonth } from "./fiscal";
import { resolveOrgId } from "./org-scope";

export const runtime = "nodejs";

export async function orgInfo(orgId?: string) {
  const activeOrgId = await resolveOrgId(orgId);
  const r = (await db.execute(sql`
    select o.name, o.base_currency,
           (select b.name from accounting_books b
             where b.org_id = o.id and b.is_primary limit 1) as book
      from orgs o
     where o.id = ${activeOrgId}
  `));
  return r.rows[0] as { name: string; base_currency: string; book: string } | undefined;
}

export async function dashboardData(orgId?: string) {
  const activeOrgId = await resolveOrgId(orgId);
  const r = (await db.execute(sql`
    select
      (select count(*) from journal_entries where org_id = ${activeOrgId}) as entries,
      (select count(*) from journal_lines where org_id = ${activeOrgId}) as lines,
      (select count(*) from accounts where org_id = ${activeOrgId} and is_active) as accounts,
      (select count(*) from parties where org_id = ${activeOrgId}) as parties,
      (select coalesce(sum(amount), 0) from journal_lines where org_id = ${activeOrgId}) as ledger_sum
  `));
  const runs = (await db.execute(sql`
    select id, source, status, started_at, finished_at, stats, error_message, triggered_by
      from sync_runs where org_id = ${activeOrgId} order by started_at desc limit 8
  `));
  return { totals: r.rows[0], runs: runs.rows };
}

/**
 * Chart-of-accounts balances in NATURAL sign (a bank account with cash reads
 * positive; a payable owed reads positive), through `asOf`. Balance-sheet
 * accounts carry their cumulative balance; income-statement accounts show the
 * current-fiscal-year-to-date activity (a lifetime P&L balance is meaningless
 * on a COA). Fiscal-year start is the org's configured month, default January.
 */
export async function accountsWithBalances(orgId: string, asOf?: string) {
  const asOfDate = asOf ?? await businessToday(orgId);
  const startMonth = await fiscalStartMonth(orgId);
  const fyStart = fiscalYearRangeFor(fiscalYearOf(asOfDate, startMonth), startMonth).from;

  const CREDIT_NORMAL = [
    'income', 'income_other',
    'liability_payable', 'liability_card', 'liability_current_other', 'liability_long_term',
    'equity',
  ];
  const PNL = ['income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred'];

  // Balances come from the gl_month_activity summary (whole months) plus the
  // as-of month's lines; the correlated per-account scan of journal_lines this
  // replaces cost seconds on a large ledger. P&L accounts measure from the
  // fiscal-year start, balance-sheet accounts from inception.
  const r = (await db.execute(sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary, a.is_active,
           coalesce(case when a.type in ${PNL} then s.fy_amount else s.all_amount end, 0)
           * case when a.type in ${CREDIT_NORMAL} then -1 else 1 end as balance
      from accounts a
      left join (
        select x.account_id,
               sum(x.amt) as all_amount,
               sum(x.amt) filter (where x.d >= ${fyStart}) as fy_amount
          from (
            select g.account_id, (g.debit_total - g.credit_total) as amt, g.month as d
              from gl_month_activity g
             where g.org_id = ${orgId} and g.month < date_trunc('month', ${asOfDate}::date)::date
            union all
            select l.account_id, l.amount, e.posting_date
              from journal_lines l
              join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
               and e.status in ('posted', 'reversed')
               and e.posting_date >= date_trunc('month', ${asOfDate}::date)::date
               and e.posting_date <= ${asOfDate}
             where l.org_id = ${orgId}
          ) x
         group by x.account_id
      ) s on s.account_id = a.id
     where a.org_id = ${orgId}
     order by a.number nulls last, a.name
  `));
  return r.rows as {
    id: string; parent_id: string | null; number: string | null; name: string;
    type: string; is_summary: boolean; is_active: boolean; balance: string;
  }[];
}

export async function journalPage(orgId: string, offset: number, limit = 50) {
  const r = (await db.execute(sql`
    select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
           count(l.id) as line_count,
           sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
      from journal_entries e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
     where e.org_id = ${orgId}
     group by e.id
     order by e.posting_date desc, e.entry_number desc
     limit ${limit} offset ${offset}
  `));
  const c = (await db.execute(sql`select count(*) as n from journal_entries where org_id = ${orgId}`)) as any;
  return { entries: r.rows, total: Number(c.rows[0].n) };
}

export async function entryDetail(orgId: string, id: string) {
  const e = (await db.execute(sql`
    select e.*, re.entry_number as reverses_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id and re.org_id = e.org_id
     where e.id = ${id} and e.org_id = ${orgId}
  `));
  const lines = (await db.execute(sql`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           a.number as account_number, a.name as account_name,
           p.display_name as party, d.name as department
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join departments d on d.id = l.department_id and d.org_id = l.org_id
     where l.entry_id = ${id} and l.org_id = ${orgId}
     order by l.line_number
  `));
  return { entry: e.rows[0] ?? null, lines: lines.rows };
}
