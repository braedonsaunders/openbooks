import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

export const runtime = "nodejs";

export async function orgInfo() {
  const r = (await db.execute(sql`
    select o.name, o.base_currency,
           (select b.name from accounting_books b where b.is_primary limit 1) as book
      from orgs o limit 1
  `)) as any;
  return r.rows[0] as { name: string; base_currency: string; book: string } | undefined;
}

export async function dashboardData() {
  const r = (await db.execute(sql`
    select
      (select count(*) from journal_entries) as entries,
      (select count(*) from journal_lines) as lines,
      (select count(*) from accounts where is_active) as accounts,
      (select count(*) from parties) as parties,
      (select coalesce(sum(amount), 0) from journal_lines) as ledger_sum
  `)) as any;
  const runs = (await db.execute(sql`
    select id, source, status, started_at, finished_at, stats, error_message, triggered_by
      from sync_runs order by started_at desc limit 8
  `)) as any;
  return { totals: r.rows[0], runs: runs.rows };
}

export async function accountsWithBalances() {
  const r = (await db.execute(sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary, a.is_active,
           coalesce(b.balance, 0) as balance
      from accounts a
      left join (select account_id, sum(amount) as balance from journal_lines group by 1) b
        on b.account_id = a.id
     order by a.number nulls last, a.name
  `)) as any;
  return r.rows as {
    id: string; parent_id: string | null; number: string | null; name: string;
    type: string; is_summary: boolean; is_active: boolean; balance: string;
  }[];
}

export async function journalPage(offset: number, limit = 50) {
  const r = (await db.execute(sql`
    select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
           count(l.id) as line_count,
           sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
     group by e.id
     order by e.posting_date desc, e.entry_number desc
     limit ${limit} offset ${offset}
  `)) as any;
  const c = (await db.execute(sql`select count(*) as n from journal_entries`)) as any;
  return { entries: r.rows, total: Number(c.rows[0].n) };
}

export async function entryDetail(id: string) {
  const e = (await db.execute(sql`
    select e.*, re.entry_number as reverses_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id
     where e.id = ${id}
  `)) as any;
  const lines = (await db.execute(sql`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           a.number as account_number, a.name as account_name,
           p.display_name as party, d.name as department
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join departments d on d.id = l.department_id
     where l.entry_id = ${id}
     order by l.line_number
  `)) as any;
  return { entry: e.rows[0] ?? null, lines: lines.rows };
}
