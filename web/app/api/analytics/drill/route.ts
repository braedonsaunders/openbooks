import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "../../../../lib/auth";

export const runtime = "nodejs";

/**
 * Generic analytics drill-down — the openbooks equivalent of Gantry's
 * `account_transactions` / `vendor_transactions` / `account_by_vendor` /
 * `account_monthly_trend` sub-actions, one endpoint for every dashboard:
 *
 *   ?account=<id>&from&to  — GL activity on one account: transactions,
 *                            monthly trend, by-party breakdown.
 *   ?party=<id>&from&to    — documents for one party: transactions, monthly
 *                            trend, by-kind breakdown.
 *
 * Fetched on click (never preloaded windows), capped at 1000 detail rows with
 * the true total reported so the UI can say what was truncated.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const account = url.searchParams.get("account");
  const party = url.searchParams.get("party");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((!account && !party) || !from || !to) {
    return NextResponse.json({ error: "account or party, plus from/to required" }, { status: 400 });
  }

  if (account) {
    const [detail, monthly, byParty, agg] = await Promise.all([
      db.execute(sql`
        select e.posting_date::text as date, e.id as entry_id, l.amount,
          d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
          coalesce(p.display_name, '') as party_name,
          coalesce(l.memo, e.memo, '') as memo
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        left join documents d on d.id = e.source_document_id
        left join parties p on p.id = l.party_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
        order by e.posting_date desc, abs(l.amount) desc
        limit 1000
      `) as Promise<any>,
      db.execute(sql`
        select to_char(e.posting_date, 'YYYY-MM') as month, sum(l.amount) as amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
        group by 1 order by 1
      `) as Promise<any>,
      db.execute(sql`
        select coalesce(p.display_name, 'No party') as name, sum(l.amount) as amount, count(*) as n
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        left join parties p on p.id = l.party_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
        group by 1 order by abs(sum(l.amount)) desc
        limit 15
      `) as Promise<any>,
      db.execute(sql`
        select count(*) as n, coalesce(sum(l.amount), 0) as total
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        where l.org_id = ${user.orgId} and l.account_id = ${account}
          and e.posting_date >= ${from} and e.posting_date <= ${to}
      `) as Promise<any>,
    ]);
    return NextResponse.json({
      mode: "account",
      total: Number(agg.rows[0]?.total ?? 0),
      count: Number(agg.rows[0]?.n ?? 0),
      entries: (detail.rows as any[]).map((r) => ({
        date: r.date,
        entryId: r.entry_id,
        docId: r.doc_id,
        docKind: r.doc_kind,
        docNumber: r.doc_number ?? "",
        label: r.party_name || r.doc_number || "Journal",
        memo: r.memo,
        amount: Number(r.amount),
      })),
      monthly: (monthly.rows as any[]).map((r) => ({ month: r.month, amount: Number(r.amount) })),
      breakdown: (byParty.rows as any[]).map((r) => ({ name: r.name, amount: Number(r.amount), count: Number(r.n) })),
    });
  }

  const [detail, monthly, byKind, agg] = await Promise.all([
    db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as date,
        d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
        e.id as entry_id, abs(d.total) as amount, d.status,
        coalesce(d.memo, '') as memo
      from documents d
      left join journal_entries e on e.source_document_id = d.id
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
      order by coalesce(d.document_date, d.posting_date) desc, abs(d.total) desc
      limit 1000
    `) as Promise<any>,
    db.execute(sql`
      select to_char(coalesce(d.document_date, d.posting_date), 'YYYY-MM') as month, sum(abs(d.total)) as amount
      from documents d
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
      group by 1 order by 1
    `) as Promise<any>,
    db.execute(sql`
      select d.kind as name, sum(abs(d.total)) as amount, count(*) as n
      from documents d
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
      group by 1 order by sum(abs(d.total)) desc
    `) as Promise<any>,
    db.execute(sql`
      select count(*) as n, coalesce(sum(abs(d.total)), 0) as total
      from documents d
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
    `) as Promise<any>,
  ]);
  return NextResponse.json({
    mode: "party",
    total: Number(agg.rows[0]?.total ?? 0),
    count: Number(agg.rows[0]?.n ?? 0),
    entries: (detail.rows as any[]).map((r) => ({
      date: r.date,
      entryId: r.entry_id,
      docId: r.doc_id,
      docKind: r.doc_kind,
      docNumber: r.doc_number ?? "",
      label: r.doc_number || r.doc_kind,
      memo: r.memo,
      amount: Number(r.amount),
    })),
    monthly: (monthly.rows as any[]).map((r) => ({ month: r.month, amount: Number(r.amount) })),
    breakdown: (byKind.rows as any[]).map((r) => ({ name: r.name, amount: Number(r.amount), count: Number(r.n) })),
  });
}
