import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Cash Flow entity drill for customer and vendor history.
 * For a customer (AR) or vendor (AP): average days-to-pay, total paid over 12
 * months, open balance, a reliability score (0–100), open items and recent
 * payments. Reliability starts at 70, with ±20/±10 adjustments by average-day
 * tiers at 30/45/60,
 * +10 no overdue / −15 if >50% of open items overdue.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;
  const url = new URL(req.url);
  const party = url.searchParams.get("party");
  const side = url.searchParams.get("side") === "ap" ? "ap" : "ar";
  if (!party) return NextResponse.json({ error: "party required" }, { status: 400 });
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const today = await businessToday(user.orgId);

  const [pay, open, recent] = await Promise.all([
    // Avg days-to-pay + total paid over the trailing 12 months.
    (db.execute(sql`
      select avg(pe.posting_date - be.posting_date) as avg_days,
        coalesce(sum(ap.amount), 0) as total_paid, count(*) as payment_count
      from applications ap
      join journal_lines bl on bl.id = ap.to_line_id and bl.org_id = ap.org_id
      join journal_entries be on be.id = bl.entry_id and be.org_id = ap.org_id
      join journal_lines pl on pl.id = ap.from_line_id and pl.org_id = ap.org_id
      join journal_entries pe on pe.id = pl.entry_id and pe.org_id = ap.org_id
      join accounts ba on ba.id = bl.account_id and ba.org_id = ap.org_id
      where ap.org_id = ${user.orgId} and ba.type = ${acctType} and ap.unapplied_at is null
        and bl.party_id = ${party}
        and pe.posting_date >= ${today}::date - interval '12 months' and pe.posting_date <= ${today}
    `)),
    // Open items with days-overdue. Applications drain from EITHER side of the
    // link (credits/payments can sit on to_ or from_), and fully-applied lines
    // with a stale is_open_item flag are filtered out — "open" means money is
    // actually outstanding.
    (db.execute(sql`
      with oi as (
        select jl.id, je.id as entry_id, je.source_document_id as doc_id,
          d.kind as doc_kind, d.document_number,
          je.posting_date::text as tran_date, jl.due_date::text as due_date,
          abs(jl.amount) - coalesce((
            select sum(x.amount) from applications x
             where x.org_id = jl.org_id
               and (x.to_line_id = jl.id or x.from_line_id = jl.id) and x.unapplied_at is null
          ), 0) as remaining
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
          and je.status in ('posted', 'reversed')
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
        left join documents d on d.id = je.source_document_id and d.org_id = jl.org_id
        where jl.org_id = ${user.orgId} and jl.is_open_item and a.type = ${acctType}
          and jl.party_id = ${party}
          and ${side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`}
      )
      select * from oi where remaining > 0
      order by due_date nulls last
    `)),
    // Recent payments (drawer paginates client-side).
    (db.execute(sql`
      select d.id as doc_id, d.kind as doc_kind, d.document_number, je.id as entry_id,
        coalesce(d.document_date, d.posting_date)::text as date, abs(d.total) as amount
      from documents d
      left join journal_entries je on je.source_document_id = d.id and je.org_id = d.org_id
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and d.kind in (${side === "ar" ? sql`'customer_payment', 'deposit'` : sql`'vendor_payment', 'check'`})
      order by coalesce(d.document_date, d.posting_date) desc
      limit 200
    `)),
  ]);

  const avgDays = pay.rows[0]?.avg_days === null || pay.rows[0]?.avg_days === undefined ? null : Math.round(Number(pay.rows[0].avg_days));
  const totalPaid = Number(pay.rows[0]?.total_paid ?? 0);
  const paymentCount = Number(pay.rows[0]?.payment_count ?? 0);
  const openItems = ((open.rows)).map((r) => {
    const due = r.due_date as string | null;
    const overdue = due && due < today;
    return {
      docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "",
      tranDate: r.tran_date, dueDate: due, remaining: Number(r.remaining), overdue: Boolean(overdue),
    };
  });
  const openBalance = openItems.reduce((a, i) => a + i.remaining, 0);
  const overdueCount = openItems.filter((i) => i.overdue).length;
  const overdueRatio = openItems.length ? overdueCount / openItems.length : 0;

  // Reliability score.
  let reliability = 70;
  if (avgDays !== null) {
    if (avgDays <= 30) reliability += 20;
    else if (avgDays <= 45) reliability += 10;
    else if (avgDays > 60) reliability -= 20;
  }
  if (overdueCount === 0) reliability += 10;
  else if (overdueRatio > 0.5) reliability -= 15;
  reliability = Math.max(0, Math.min(100, reliability));

  return NextResponse.json({
    avgDays,
    totalPaid,
    paymentCount,
    openBalance,
    overdueCount,
    reliability,
    openItems,
    recentPayments: ((recent.rows)).map((r) => ({ docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "", date: r.date, amount: Number(r.amount) })),
  });
}
