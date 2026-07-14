import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/src/db.ts";
import { add, sum } from "@openbooks/engine/src/money.ts";
import { currentUser } from "../../../lib/auth";

export const runtime = "nodejs";

interface BillLine {
  accountId: string;
  description?: string;
  amount: string;
  taxCodeId?: string | null;
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as {
    partyId?: string; documentDate?: string; dueDate?: string;
    referenceNumber?: string; memo?: string; lines?: BillLine[];
  };
  if (!body.partyId || !body.documentDate || !body.lines?.length) {
    return NextResponse.json({ error: "vendor, date and at least one line required" }, { status: 400 });
  }

  // tax: line amount is pre-tax; compute per line from the code's current rate
  const rates = (await db.execute(sql`
    select tc.id, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
  `)) as any;
  const rateByCode = new Map<string, number>(rates.rows.map((r: any) => [r.id, Number(r.rate)]));

  const lines = body.lines.map((l) => {
    const rate = l.taxCodeId ? (rateByCode.get(l.taxCodeId) ?? 0) : 0;
    const tax = (Math.round(Number(l.amount) * rate) / 100).toFixed(2);
    return { ...l, taxAmount: tax };
  });
  const subtotal = sum(lines.map((l) => l.amount));
  const taxTotal = sum(lines.map((l) => l.taxAmount));

  const seqRow = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, prefix)
    values (${user.orgId}, 'vendor_bill', 'BILL-')
    on conflict (org_id, document_kind)
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as any;
  const s = seqRow.rows[0];
  const documentNumber = `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;

  const [doc] = await db.insert(schema.documents).values({
    orgId: user.orgId,
    kind: "vendor_bill",
    documentNumber,
    partyId: body.partyId,
    documentDate: body.documentDate,
    dueDate: body.dueDate || null,
    currency: "CAD",
    referenceNumber: body.referenceNumber || null,
    memo: body.memo || null,
    subtotal, taxTotal, total: add(subtotal, taxTotal),
    createdBy: user.id,
  }).returning();

  await db.insert(schema.documentLines).values(
    lines.map((l, i) => ({
      orgId: user.orgId,
      documentId: doc.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      description: l.description || null,
      quantity: "1",
      unitPrice: l.amount,
      amount: l.amount,
      taxCodeId: l.taxCodeId || null,
      taxAmount: l.taxAmount,
    })),
  );

  return NextResponse.json({ id: doc.id, documentNumber: doc.documentNumber, total: doc.total });
}
