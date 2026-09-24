import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { add, mulDecimal, normalizeMoney, sum } from "@openbooks/engine/src/money/money.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../lib/authz";
import { statementBookExpr } from "../../../../../lib/gl-summary";
import { flowRates, presentationCurrency } from "../../../../../lib/fx-presentation";
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
  // Cash settlement source kinds, shared by the payment stats and the recent
  // list: only documents that move cash count as payments. Customer/vendor
  // credits and other offsets settle balances without cash and are excluded
  // from payment counts, days and totals.
  const settlementKinds = side === "ar" ? sql`'customer_payment', 'deposit'` : sql`'vendor_payment', 'check'`;

  const [pay, partyOpen, recent] = await Promise.all([
    // Payment legs over the trailing 12 months, grouped per source payment
    // document (one payment split across two bills is one payment, with days
    // amount-weighted across its applications). Each group carries its own
    // functional frame and source date: applications.amount is a ledger
    // amount in the payment line's functional currency, so groups settle in
    // different frames for multi-subsidiary parties and must translate
    // per group — never summed raw. Count, average days and the translated
    // total are aggregated in JS below over these rows.
    (db.execute(sql`
      select pe.source_document_id as pid,
        sum(ap.amount * (pe.posting_date - be.posting_date))
          / nullif(sum(ap.amount), 0) as days,
        sum(ap.amount) as paid,
        coalesce(psub.base_currency, o.base_currency) as func,
        pe.posting_date::text as date
      from applications ap
      join journal_lines bl on bl.id = ap.to_line_id and bl.org_id = ap.org_id
      join journal_entries be on be.id = bl.entry_id and be.org_id = ap.org_id
      join journal_lines pl on pl.id = ap.from_line_id and pl.org_id = ap.org_id
      join journal_entries pe on pe.id = pl.entry_id and pe.org_id = ap.org_id
      join accounts ba on ba.id = bl.account_id and ba.org_id = ap.org_id
      join documents sp on sp.id = pe.source_document_id and sp.org_id = ap.org_id
      left join subsidiaries psub on psub.id = pl.subsidiary_id and psub.org_id = ap.org_id
      join orgs o on o.id = ap.org_id
      where ap.org_id = ${user.orgId} and ba.type = ${acctType} and ap.unapplied_at is null
        and bl.party_id = ${party}
        and pe.posting_date >= ${today}::date - interval '12 months' and pe.posting_date <= ${today}
        and sp.kind in (${settlementKinds})
        ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`be.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`pl.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`pe.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`sp.subsidiary_id`, gate.allowedSubsidiaryIds)}
      group by pe.source_document_id, coalesce(psub.base_currency, o.base_currency), pe.posting_date
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
    // Recent payments (drawer paginates client-side): the posted source
    // population only, joined one-to-one to its posting in the current
    // statement book through the house resolver. Drafts never list, and a
    // payment posted in two books appears once, not twice.
    (db.execute(sql`
      select d.id as doc_id, d.kind as doc_kind, d.document_number, je.id as entry_id,
        coalesce(d.document_date, d.posting_date)::text as date,
        round(abs(d.total) * d.fx_rate, 4) as func_amount,
        coalesce(sub.base_currency, o.base_currency) as func
      from documents d
      join journal_entries je on je.source_document_id = d.id and je.org_id = d.org_id
        and je.status in ('posted', 'reversed') and je.book_id = ${statementBookExpr(user.orgId)}
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      join orgs o on o.id = d.org_id
      where d.org_id = ${user.orgId} and d.party_id = ${party} and d.voided_at is null
        and d.status = 'posted'
        and d.kind in (${settlementKinds})
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}
        ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, gate.allowedSubsidiaryIds)}
      order by coalesce(d.document_date, d.posting_date) desc
      limit 200
    `)),
  ]);

  // Payment legs aggregate in JS over the grouped rows: distinct source
  // documents count, days average like SQL avg (nulls ignored), and the paid
  // total translates per group — never summed across functional frames raw.
  const legs = (pay.rows ?? []) as Array<{ pid: unknown; days: unknown; paid: unknown; func: unknown; date: unknown }>;
  const paymentCount = new Set(legs.map((l) => String(l.pid))).size;
  const dayValues = legs
    .map((l) => l.days)
    .filter((d): d is string | number => d !== null && d !== undefined)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const avgDays = dayValues.length > 0 ? Math.round(dayValues.reduce((a, b) => a + b, 0) / dayValues.length) : null;

  // Recent amounts AND the paid total translate to presentation at each
  // source date through the one flow context — a USD 100 payment in a CAD
  // org reads CAD 135, never CAD 100, in both the payment list and the
  // 12-month total. Missing coverage refuses 422 by name for either.
  const fxResult = await flowRates(user.orgId, [
    ...recent.rows.map((r) => ({
      func: typeof r.func === "string" ? r.func : null,
      date: String(r.date ?? today).slice(0, 10),
    })),
    ...legs.map((l) => ({
      func: typeof l.func === "string" ? l.func : null,
      date: String(l.date ?? today).slice(0, 10),
    })),
  ]).then(
    (rates) => ({ ok: true as const, rates }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!fxResult.ok) {
    return NextResponse.json(
      { error: "missing exchange rate", message: fxResult.error instanceof Error ? fxResult.error.message : String(fxResult.error) },
      { status: 422 },
    );
  }
  const fx = fxResult.rates;
  let recentAmounts: string[];
  let totalPaid: string;
  try {
    recentAmounts = recent.rows.map((r) =>
      mulDecimal(String(r.func_amount ?? "0"), fx.rateAt(typeof r.func === "string" ? r.func : null, String(r.date ?? today).slice(0, 10))));
    totalPaid = normalizeMoney(legs.reduce(
      (total, l) => add(total, mulDecimal(String(l.paid ?? "0"), fx.rateAt(typeof l.func === "string" ? l.func : null, String(l.date ?? today).slice(0, 10)))),
      "0",
    ));
  } catch (error) {
    return NextResponse.json(
      { error: "missing exchange rate", message: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
  const currency = fx.base || await presentationCurrency(user.orgId);
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
    currency,
    openItems: rows,
    recentPayments: ((recent.rows)).map((r, i) => ({ docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "", date: r.date, amount: normalizeMoney(recentAmounts[i] ?? "0") })),
  });
}
