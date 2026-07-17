import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "../../../../../lib/auth";

export const runtime = "nodejs";

const SPEND_KINDS = ["vendor_bill", "vendor_credit", "vendor_payment", "check", "expense_report", "journal", "customer_credit"];

/**
 * Benford digit drill — the openbooks port of Gantry's openBenford1DDigitFlyout.
 * Returns the spend documents whose leading digit (1D) or leading two digits
 * (2D) equal the clicked digit, so a deviating Benford bar drills straight into
 * the transactions behind it. Capped at 500 detail rows with the true count.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const digit = Number(url.searchParams.get("digit"));
  const dim = url.searchParams.get("dim") === "2d" ? "2d" : "1d";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!Number.isFinite(digit) || !from || !to) return NextResponse.json({ error: "digit, from, to required" }, { status: 400 });

  const kindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  // Leading digit(s) via magnitude scaling: d = floor(|amt| / 10^floor(log10|amt|))
  // (1D → 1..9), or the leading two digits for 2D (10..99).
  const leadExpr = dim === "2d"
    ? sql`floor(abs(d.total) / power(10, floor(log(abs(d.total))) - 1))::int`
    : sql`floor(abs(d.total) / power(10, floor(log(abs(d.total)))))::int`;

  const base = sql`
    from documents d
    where d.org_id = ${user.orgId} and d.voided_at is null and d.kind in (${kindsIn})
      and abs(d.total) >= 1
      and coalesce(d.document_date, d.posting_date) >= ${from}
      and coalesce(d.document_date, d.posting_date) <= ${to}
      and ${leadExpr} = ${digit}
  `;
  const [detail, agg] = await Promise.all([
    db.execute(sql`
      select d.id as doc_id, d.kind as doc_kind, d.document_number,
        coalesce(d.document_date, d.posting_date)::text as date, abs(d.total) as amount,
        coalesce(p.display_name, '') as party_name,
        (select je.id from journal_entries je where je.source_document_id = d.id limit 1) as entry_id
      ${base}
      order by abs(d.total) desc
      limit 500
    `) as Promise<any>,
    db.execute(sql`select count(*) as n, coalesce(sum(abs(d.total)), 0) as total ${base}`) as Promise<any>,
  ]);

  return NextResponse.json({
    digit,
    dim,
    count: Number(agg.rows[0]?.n ?? 0),
    total: Number(agg.rows[0]?.total ?? 0),
    documents: (detail.rows as any[]).map((r) => ({
      docId: r.doc_id, docKind: r.doc_kind, entryId: r.entry_id, docNumber: r.document_number ?? "",
      date: r.date, amount: Number(r.amount), partyName: r.party_name,
    })),
  });
}
