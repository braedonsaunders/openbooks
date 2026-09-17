import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney, sum } from "@openbooks/engine/src/money.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../lib/authz";
import { toISO } from "../../../../../lib/cash/core";
import { openItems } from "../../../../../lib/cash/open-items";
import { isUuid } from "../../../../../lib/list-params";
import { subsidiaryVisibleFilter } from "../../../../../lib/subsidiaries";

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
  if (!isUuid(party)) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The party is the record boundary.  A null-subsidiary party is an
  // org-wide identity, but every transaction leg below still has to be
  // narrowed to the caller's visible subsidiaries.
  const partyRow = await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId"
      from parties
     where id = ${party} and org_id = ${user.orgId}
     limit 1
  `);
  if (!partyRow.rows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scopeDenied = guardSubsidiaryScope(gate, partyRow.rows[0].subsidiaryId, { orgWideNull: true });
  if (scopeDenied) return scopeDenied;

  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const today = await businessToday(user.orgId);

  const [pay, partyOpen, recent] = await Promise.all([
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
        ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`be.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`pl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`pe.subsidiary_id`, gate.allowedSubsidiaryIds)}
    `)),
    // Open items with days-overdue — off the shared cash-engine reader, not
    // a bespoke aggregate (F-t03-010). The old query joined reversed entries
    // without the document's current posting projection, so an append-only
    // correction (reversed original + re-post of the same bill) listed the
    // same bill twice under two dates and inflated the dialog total past the
    // dashboard. Filtering the house item set to the party keeps the dialog
    // tied to /ap by construction.
    openItems(
      user.orgId,
      side,
      today,
      gate.allowedSubsidiaryIds === null ? undefined : [...gate.allowedSubsidiaryIds],
    ).then((items) => items.filter((item) => item.partyId === party)),
    // Recent payments (drawer paginates client-side).
    (db.execute(sql`
      select d.id as doc_id, d.kind as doc_kind, d.document_number, je.id as entry_id,
        coalesce(d.document_date, d.posting_date)::text as date, abs(d.total) as amount
      from documents d
      left join journal_entries je on je.source_document_id = d.id and je.org_id = d.org_id
        ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, gate.allowedSubsidiaryIds)}
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and d.kind in (${side === "ar" ? sql`'customer_payment', 'deposit'` : sql`'vendor_payment', 'check'`})
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}
      order by coalesce(d.document_date, d.posting_date) desc
      limit 200
    `)),
  ]);

  const avgDays = pay.rows[0]?.avg_days === null || pay.rows[0]?.avg_days === undefined ? null : Math.round(Number(pay.rows[0].avg_days));
  const totalPaid = normalizeMoney(String(pay.rows[0]?.total_paid ?? "0"));
  const paymentCount = Number(pay.rows[0]?.payment_count ?? 0);
  const rows = partyOpen.map((item) => {
    const due = item.dueDate ? toISO(item.dueDate) : null;
    const overdue = due !== null && due < today;
    return {
      docId: item.docId, docKind: item.docKind, entryId: item.entryId, docNumber: item.docNumber ?? "",
      tranDate: toISO(item.tranDate), dueDate: due, remaining: item.remaining, overdue,
    };
  });
  const openBalance = sum(rows.map((item) => item.remaining));
  const overdueCount = rows.filter((i) => i.overdue).length;
  const overdueRatio = rows.length ? overdueCount / rows.length : 0;

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
    openItems: rows,
    recentPayments: ((recent.rows)).map((r) => ({ docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "", date: r.date, amount: normalizeMoney(String(r.amount ?? "0")) })),
  });
}
