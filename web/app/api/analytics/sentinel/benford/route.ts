import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardPermission } from "../../../../../lib/authz";
import { sentinelAccessDenied } from "../../../../../lib/analytics/sentinel-access";
import { subsidiaryVisibleFilter } from "../../../../../lib/subsidiaries";

export const runtime = "nodejs";

const SPEND_KINDS = ["vendor_bill", "vendor_credit", "vendor_payment", "check", "expense_report", "journal", "customer_credit"];

/**
 * Benford digit drill for the transaction flyout.
 * Returns the spend documents whose leading digit (1D) or leading two digits
 * (2D) equal the clicked digit, so a deviating Benford bar drills straight into
 * the transactions behind it. Capped at 500 detail rows with the true count.
 * Benford distributions run per document currency, so the flyout accepts an
 * optional `currency` scope (omitted = all currencies, the legacy behaviour).
 */
export async function GET(req: Request) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  // Whole-ledger forensics: the same gate as the page loader (unrestricted
  // reports + audit access). A reports-only role gets a 403, never rows.
  const denied = sentinelAccessDenied(gate);
  if (denied) {
    return NextResponse.json({ error: "forbidden", message: `sentinel forensics requires ${denied}` }, { status: 403 });
  }
  const user = gate.user;
  const url = new URL(req.url);
  const digit = Number(url.searchParams.get("digit"));
  const dim = url.searchParams.get("dim") ?? "1d";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const currency = url.searchParams.get("currency");
  if ((dim !== "1d" && dim !== "2d") || !Number.isInteger(digit)
    || digit < (dim === "2d" ? 10 : 1) || digit > (dim === "2d" ? 99 : 9)
    || !isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from > to
    || (currency !== null && !/^[A-Z]{3}$/.test(currency))) {
    return NextResponse.json({ error: "valid digit, dimension and date range required" }, { status: 400 });
  }

  const kindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds);
  // Leading digit(s) via magnitude scaling: d = floor(|amt| / 10^floor(log10|amt|))
  // (1D → 1..9), or the leading two digits for 2D (10..99).
  const leadExpr = dim === "2d"
    ? sql`floor(abs(d.total) / power(10, floor(log(abs(d.total))) - 1))::int`
    : sql`floor(abs(d.total) / power(10, floor(log(abs(d.total)))))::int`;

  const base = sql`
    from documents d
    left join parties p on p.id = d.party_id and p.org_id = d.org_id
    where d.org_id = ${user.orgId} and d.voided_at is null and d.kind in (${kindsIn})
      ${subsidiaryFilter}
      and abs(d.total) >= 1
      ${currency ? sql`and d.currency = ${currency}` : sql``}
      and coalesce(d.document_date, d.posting_date) >= ${from}
      and coalesce(d.document_date, d.posting_date) <= ${to}
      and ${leadExpr} = ${digit}
  `;
  const [detail, agg] = await Promise.all([
    (db.execute(sql`
      select d.id as doc_id, d.kind as doc_kind, d.document_number,
        coalesce(d.document_date, d.posting_date)::text as date, abs(d.total) as amount,
        d.currency as currency,
        coalesce(p.display_name, '') as party_name,
        (select je.id from journal_entries je where je.source_document_id = d.id limit 1) as entry_id
      ${base}
      order by abs(d.total) desc
      limit 500
    `)),
    (db.execute(sql`select count(*) as n, coalesce(sum(abs(d.total)), 0) as total ${base}`)),
  ]);

  return NextResponse.json({
    digit,
    dim,
    currency,
    count: Number(agg.rows[0]?.n ?? 0),
    total: normalizeMoney(String(agg.rows[0]?.total ?? "0")),
    documents: ((detail.rows)).map((r) => ({
      docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "",
      date: r.date, amount: normalizeMoney(String(r.amount ?? "0")), currency: r.currency, partyName: r.party_name,
    })),
  });
}
